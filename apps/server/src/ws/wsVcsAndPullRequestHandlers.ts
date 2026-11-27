import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  CommandId,
  type GitActionProgressEvent,
  GitCommandError,
  type GitManagerServiceError,
  type PullRequestRef,
  WS_METHODS,
} from "@zerocode/contracts";
import * as SourceControlRateLimit from "@zerocode/source-control-core/server/SourceControlRateLimit";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import { refreshPushedPullRequests } from "../git/refreshPushedPullRequests.ts";
import { assertCheckoutIdle } from "../git/sharedCheckoutGuard.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { listLinkedPullRequestThreads } from "../pullRequest/linkedThreads.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { pullRequestSyncKey } from "../pullRequest/pullRequestSyncKey.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { VcsAndPullRequestWsRpcGroup, makeRefreshGitStatus } from "./wsRpcShared.ts";

export const makeVcsAndPullRequestHandlers = Effect.fn("ws.handlers.vcsAndPullRequests")(function* (
  currentSession: EnvironmentAuth.AuthenticatedSession,
) {
  const sql = yield* SqlClient.SqlClient;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const issues = yield* IssueService.IssueService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const issueTrackers = yield* IssueTrackerConnections.IssueTrackerConnections;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const review = yield* ReviewService.ReviewService;
  const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const sourceControlRepositories =
    yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const sourceControlSignIn = yield* SourceControlSignIn.SourceControlSignIn;

  const refreshGitStatus = makeRefreshGitStatus(vcsStatusBroadcaster);
  const withPullRequestViewer = pullRequests.withRoutingCredential;
  // The panel's reads for a pull request the user opened go out during a rate-limit pause.
  const openedPullRequestRead = Effect.provideService(SourceControlRateLimit.Interactive, true);

  const serverCommandId = (tag: string) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
    );

  const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
    reference.host !== undefined && reference.repository.includes("/")
      ? Effect.succeed(pullRequestSyncKey(reference))
      : projectService.getShell(reference.projectId).pipe(
          Effect.map((project) =>
            pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
          ),
          Effect.orElseSucceed(() => null),
        );

  // A project's layout command is its owner's code: only a session that may already run
  // commands on the host has it run from a worktree request.
  const projectCommands: TaskFolders.ProjectCommands =
    currentSession.scopes.includes(AuthOrchestrationOperateScope) ||
    currentSession.scopes.includes(AuthTerminalOperateScope)
      ? "permitted"
      : "request-not-permitted";

  const handlers = VcsAndPullRequestWsRpcGroup.of({
    [WS_METHODS.issuesList]: (input) => issues.list(input),
    [WS_METHODS.issuesDetail]: (input) => issues.detail(input),
    [WS_METHODS.issuesComments]: (input) => issues.comments(input),
    [WS_METHODS.issuesTemplates]: (input) => issues.templates(input),
    [WS_METHODS.issuesCandidates]: (input) => issues.candidates(input),
    [WS_METHODS.issuesLinkedThreads]: (input) => threadIssues.linkedThreads(input),
    [WS_METHODS.issuesCreate]: (input) => issues.create(input),
    [WS_METHODS.issuesComment]: (input) => issues.comment(input),
    [WS_METHODS.issuesUpdate]: (input) => issues.update(input),
    [WS_METHODS.issuesSetState]: (input) => issues.setState(input),
    [WS_METHODS.issuesReact]: (input) => issues.react(input),
    [WS_METHODS.issueTrackersList]: () => issueTrackers.list,
    [WS_METHODS.issueTrackersConnect]: (input) => issueTrackers.connect(input),
    [WS_METHODS.issueTrackersBindProject]: (input) => issueTrackers.bindProject(input),
    [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
    [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
    [WS_METHODS.pullRequestsFilterOptions]: (input) => pullRequests.filterOptions(input),
    [WS_METHODS.pullRequestsRoutingIdentity]: (input) => pullRequests.routingIdentity(input),
    [WS_METHODS.pullRequestsRouting]: (input) => pullRequests.routing(input),
    [WS_METHODS.pullRequestsSummary]: (input) =>
      withPullRequestViewer(input, pullRequests.summary(input)),
    [WS_METHODS.pullRequestsStack]: (input) =>
      withPullRequestViewer(input, pullRequests.stack(input)),
    [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
      resolvePullRequestSyncKey(input).pipe(
        Effect.flatMap((key) =>
          key === null
            ? Effect.succeed({ threads: [] })
            : listLinkedPullRequestThreads(key).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
        ),
      ),
    [WS_METHODS.pullRequestsDetail]: (input) =>
      withPullRequestViewer(input, openedPullRequestRead(pullRequests.detail(input))),
    [WS_METHODS.pullRequestsPreview]: (input) =>
      withPullRequestViewer(input, pullRequests.preview(input)),
    [WS_METHODS.pullRequestsChecks]: (input) =>
      withPullRequestViewer(input, pullRequests.checks(input)),
    [WS_METHODS.pullRequestsActivity]: (input) =>
      withPullRequestViewer(input, openedPullRequestRead(pullRequests.activity(input))),
    [WS_METHODS.pullRequestsReviewGuide]: (input) =>
      withPullRequestViewer(input, reviewGuides.get(input)),
    [WS_METHODS.pullRequestsGenerateReviewGuide]: (input) =>
      withPullRequestViewer(input, reviewGuides.generate(input)),
    [WS_METHODS.pullRequestsThreadComments]: (input) =>
      withPullRequestViewer(input, pullRequests.threadComments(input)),
    [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
      withPullRequestViewer(input, pullRequests.diffFileContents(input)),
    [WS_METHODS.pullRequestsFilesViewed]: (input) =>
      withPullRequestViewer(input, pullRequests.filesViewed(input)),
    [WS_METHODS.pullRequestsChangeBreakdown]: (input) =>
      withPullRequestViewer(input, pullRequests.changeBreakdown(input)),
    [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
      withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
    [WS_METHODS.pullRequestsRunAction]: (input) =>
      withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
        Effect.tap(() =>
          resolvePullRequestSyncKey(input).pipe(
            Effect.flatMap((key) =>
              key === null ? Effect.void : pullRequestSync.requestSync(key),
            ),
          ),
        ),
      ),
    [WS_METHODS.pullRequestsUpdate]: (input) =>
      withPullRequestViewer(input, pullRequests.update(input)),
    [WS_METHODS.pullRequestsComment]: (input) =>
      withPullRequestViewer(input, pullRequests.comment(input)),
    [WS_METHODS.pullRequestsUpdateComment]: (input) =>
      withPullRequestViewer(input, pullRequests.updateComment(input)),
    [WS_METHODS.pullRequestsSubmitReview]: (input) =>
      withPullRequestViewer(input, pullRequests.submitReview(input)),
    [WS_METHODS.pullRequestsReplyToThread]: (input) =>
      withPullRequestViewer(input, pullRequests.replyToThread(input)),
    [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
      withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
    [WS_METHODS.pullRequestsSetReaction]: (input) =>
      withPullRequestViewer(input, pullRequests.setReaction(input)),
    [WS_METHODS.pullRequestsReportState]: (input) => pullRequests.reportState(input),
    [WS_METHODS.pullRequestsInvalidate]: (input) =>
      pullRequests
        .invalidate(input, { notifyReaders: true })
        .pipe(
          Effect.andThen(
            input.reference === undefined || input.filesViewedOnly === true
              ? Effect.void
              : resolvePullRequestSyncKey(input.reference).pipe(
                  Effect.flatMap((key) =>
                    key === null ? Effect.void : pullRequestSync.requestSync(key),
                  ),
                ),
          ),
        ),
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
    [WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes]: () =>
      pullRequests.subscribeLinkedThreadRefreshes,
    [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
      withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
    [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
      withPullRequestViewer(input, pullRequests.requestReviewers(input)),
    [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
      withPullRequestViewer(input, pullRequests.labelCandidates(input)),
    [WS_METHODS.pullRequestsSetLabels]: (input) =>
      withPullRequestViewer(input, pullRequests.setLabels(input)),
    [WS_METHODS.sourceControlLookupRepository]: (input) =>
      sourceControlRepositories.lookupRepository(input),
    [WS_METHODS.sourceControlCloneRepository]: (input) =>
      sourceControlRepositories.cloneRepository(input),
    [WS_METHODS.sourceControlSignInStart]: (input) => sourceControlSignIn.start(input),
    [WS_METHODS.sourceControlSignInWait]: (input) => sourceControlSignIn.wait(input),
    [WS_METHODS.sourceControlSignInCancel]: (input) => sourceControlSignIn.cancel(input),
    [WS_METHODS.sourceControlAppAccess]: (input) => sourceControlSignIn.access(input),
    [WS_METHODS.sourceControlStarred]: (input) => sourceControlSignIn.starred(input),
    [WS_METHODS.sourceControlStar]: (input) => sourceControlSignIn.star(input),
    [WS_METHODS.sourceControlPublishRepository]: (input) =>
      sourceControlRepositories.publishRepository(input).pipe(
        // A failed push still leaves the new remote added.
        Effect.ensuring(
          repositoryIdentityResolver
            .resolve(input.cwd, { refresh: true })
            .pipe(Effect.andThen(refreshGitStatus(input.cwd))),
        ),
      ),
    [WS_METHODS.subscribeVcsBranch]: (input) => vcsStatusBroadcaster.streamBranchStatus(input),
    [WS_METHODS.vcsRefreshBranch]: (input) =>
      vcsStatusBroadcaster.refreshBranchStatus(input).pipe(Effect.asVoid),
    [WS_METHODS.subscribeVcsStatus]: (input) => vcsStatusBroadcaster.streamStatus(input),
    [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
    [WS_METHODS.worktreeSetupCancel]: (input) =>
      worktreeSetupTracker.cancel(input.threadId).pipe(Effect.map((cancelled) => ({ cancelled }))),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
    [WS_METHODS.vcsPull]: (input) =>
      gitWorkflow.pullCurrentBranch(input.cwd).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Effect.failCause(cause),
          onSuccess: (result) =>
            refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
        }),
      ),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
        gitWorkflow
          .runStackedAction(input, {
            actionId: input.actionId,
            progressReporter: {
              publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
            },
          })
          .pipe(
            Effect.matchCauseEffect({
              // Earlier steps (branch, commit) may have landed before the failing one.
              onFailure: (cause) =>
                refreshGitStatus(input.cwd).pipe(Effect.andThen(Queue.failCause(queue, cause))),
              onSuccess: (result) =>
                (input.threadId === undefined
                  ? Effect.void
                  : linkCreatedPullRequest({
                      threadId: input.threadId,
                      cwd: input.cwd,
                      result,
                      commandId: serverCommandId("pr-created-link"),
                    }).pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                      Effect.provideService(ProjectService.ProjectService, projectService),
                      Effect.provideService(
                        RepositoryIdentityResolver.RepositoryIdentityResolver,
                        repositoryIdentityResolver,
                      ),
                    )
                ).pipe(
                  Effect.andThen(
                    refreshPushedPullRequests(input, result).pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                      Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                      Effect.provideService(PullRequestService.PullRequestService, pullRequests),
                    ),
                  ),
                  Effect.andThen(refreshGitStatus(input.cwd)),
                  Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                ),
            }),
          ),
      ),
    [WS_METHODS.gitResolvePullRequest]: (input) => gitWorkflow.resolvePullRequest(input),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      (input.mode === "local"
        ? assertCheckoutIdle("GitWorkflowService.preparePullRequestThread", input.cwd)
        : Effect.void
      ).pipe(
        Effect.andThen(gitWorkflow.preparePullRequestThread(input)),
        Effect.tap(() => refreshGitStatus(input.cwd)),
      ),
    [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
    [WS_METHODS.vcsCreateWorktree]: (input) =>
      // A project that tracks repositories gets a task folder, as its new worktree threads do.
      taskFolders.createForProjectFolder(input, { projectCommands }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "TaskFolders.create",
              command: "git worktree add",
              cwd: input.cwd,
              detail: cause.detail,
            }),
        ),
        Effect.filterOrElse(
          (created) => created !== null,
          () => gitWorkflow.createWorktree(input),
        ),
        Effect.tap(() => refreshGitStatus(input.cwd)),
      ),
    [WS_METHODS.vcsRemoveWorktree]: (input) =>
      // A thread's worktree may be a task folder: its repositories' worktrees go with it.
      taskFolders
        .removeIfTaskFolder({ path: input.path, force: input.force === true, projectCommands })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "TaskFolders.remove",
                command: "git worktree remove",
                cwd: input.cwd,
                detail: cause.detail,
              }),
          ),
          Effect.flatMap((removed) => (removed ? Effect.void : gitWorkflow.removeWorktree(input))),
          // No project-root refresh here: the client awaits vcs.refreshStatus right after, and a
          // second refresh would queue behind this one and reread an unchanged repository.
          // Subscribers of the removed checkout learn it is no longer a repository.
          Effect.tap(() =>
            vcsStatusBroadcaster
              .refreshLocalStatus(input.path)
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
          ),
        ),
    [WS_METHODS.vcsCreateRef]: (input) =>
      (input.switchRef
        ? assertCheckoutIdle("GitWorkflowService.createRef", input.cwd)
        : Effect.void
      ).pipe(
        Effect.andThen(gitWorkflow.createRef(input)),
        Effect.tap(() =>
          input.switchRef
            ? vcsStatusBroadcaster.refreshAfterCheckout(input.cwd)
            : refreshGitStatus(input.cwd),
        ),
      ),
    [WS_METHODS.vcsSwitchRef]: (input) =>
      assertCheckoutIdle("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(gitWorkflow.switchRef(input)),
        Effect.tap(() => vcsStatusBroadcaster.refreshAfterCheckout(input.cwd)),
      ),
    [WS_METHODS.vcsInit]: (input) =>
      vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    [WS_METHODS.reviewGetBranchCommits]: (input) => review.getBranchCommits(input),
    [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
    [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
  });

  return yield* VcsAndPullRequestWsRpcGroup.toHandlers(handlers);
});
