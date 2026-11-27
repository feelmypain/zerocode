import {
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  ChatAttachmentId,
  CommandId,
  type DiscoveredLocalServerList,
  FilesystemBrowseError,
  type FilesystemBrowseFailure,
  type MessageId,
  OrchestrationDispatchCommandError,
  PersistChatAttachmentsError,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  type ProjectId,
  type ProjectMutation,
  ProjectMutationError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  SOURCE_CONTROL_MEDIA_ASSET,
  type TaskFolderError,
  type TerminalMetadataStreamEvent,
  ThreadId,
  type WorktreeLayoutCommandKind,
  WS_METHODS,
} from "@zerocode/contracts";
import { isNetworkPath } from "@zerocode/shared/path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "../attachmentStore.ts";
import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { requiredScopeForDeviceList } from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import type * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { mutateProjectWithClone } from "../project/ProjectMutation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { terminalOutputStream } from "../terminal/OutputProtocol.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { makePrepareTerminalLaunch } from "../workspace/restoreMissingWorktree.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  PreviewDeviceTerminalWsRpcGroup,
  authorizeEffect,
  makeRefreshGitStatus,
} from "./wsRpcShared.ts";

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

const persistChatAttachments = Effect.fn("ws.assets.persistChatAttachments")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachments: ReadonlyArray<{
    readonly type: "image";
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly dataUrl: string;
  }>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments.map((attachment, index) => ({ attachment, index })),
    Effect.fn("ws.assets.persistChatAttachment")(function* ({ attachment, index }) {
      const parsed = parseBase64DataUrl(attachment.dataUrl);
      if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} has an invalid image payload.`,
        });
      }
      const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} is not valid base64.`,
              cause,
            }),
        ),
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} size does not match its payload.`,
        });
      }
      const rawId = createDeterministicAttachmentId(
        input.threadId,
        chatAttachmentStableKey(input.messageId, index, bytes),
      );
      if (rawId === null) {
        return yield* new PersistChatAttachmentsError({
          message: "Could not allocate an attachment identifier.",
        });
      }
      const persisted = {
        type: "image" as const,
        id: ChatAttachmentId.make(rawId),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      yield* fileSystem
        .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(persisted)!), bytes)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
      return persisted;
    }),
    { concurrency: 2 },
  );
});

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
  readonly pathMissing?: boolean;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "read_directory_failed",
        parentPath: error.parentPath,
        ...(error.pathMissing ? { pathMissing: true } : {}),
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

export const makePreviewDeviceTerminalHandlers = Effect.fn("ws.handlers.previewDeviceTerminal")(
  function* (input: {
    readonly currentSession: EnvironmentAuth.AuthenticatedSession;
    readonly serverBrowser: ServerBrowser.ServerBrowser["Service"];
    readonly reportProfiles: ServerBrowser.ProfileReporter;
    readonly setLayoutCommandApproval: (input: {
      readonly projectId: ProjectId;
      readonly kind: WorktreeLayoutCommandKind;
      readonly command: string | null;
    }) => Effect.Effect<void, TaskFolderError>;
  }) {
    const { currentSession, serverBrowser, reportProfiles, setLayoutCommandApproval } = input;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const scratchThreadPromotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
    const deviceService = yield* DeviceService.DeviceService;
    const random = yield* SecureRandom.SecureRandom;
    // RPC client ids are only unique within one socket; terminals share viewers across sockets.
    const terminalViewerPrefix = yield* random.uuidV4();
    const terminalViewerId = (metadata: { readonly client: { readonly id: number } }) =>
      `${terminalViewerPrefix}:${metadata.client.id}`;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
    const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const terminalManager = yield* TerminalManager.TerminalManager;
    const prepareTerminalLaunch = yield* makePrepareTerminalLaunch(threadManagement.getThreadShell);
    const previewManager = yield* PreviewManager.PreviewManager;
    const portDiscovery = yield* PortScanner.PortDiscovery;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
    const taskFolders = yield* TaskFolders.TaskFolders;
    const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

    const refreshGitStatus = makeRefreshGitStatus(vcsStatusBroadcaster);
    const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
      return yield* mutateProjectWithClone(projectService, projectCloneTracker, mutation);
    });

    const handlers = PreviewDeviceTerminalWsRpcGroup.of({
      [WS_METHODS.projectCloneStart]: (input) =>
        projectCloneTracker.start(input, {
          createProject: (project) =>
            projectService
              .create({
                commandId: CommandId.make(`project-clone-create:${project.projectId}`),
                projectId: project.projectId,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                createWorkspaceRootIfMissing: true,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((cause) =>
                  cause._tag === "ProjectConflictError"
                    ? cause
                    : new OrchestrationDispatchCommandError({
                        message: "Failed to create clone project.",
                        cause,
                      }),
                ),
              ),
          onCloned: (project) =>
            repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
              Effect.andThen(
                projectService.update({
                  commandId: CommandId.make(`project-clone-done:${project.projectId}`),
                  projectId: project.projectId,
                }),
              ),
              Effect.andThen(refreshGitStatus(project.workspaceRoot)),
              // The folder was empty when the project was created, so the cached
              // enrichment says "no repository" and clients cannot group it yet.
              Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
              Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
              Effect.ignoreCause({ log: true }),
            ),
        }),
      [WS_METHODS.projectsEnsureScratch]: () =>
        managedFolders.ensureScratchProject.pipe(
          Effect.mapError(
            (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
      [WS_METHODS.projectsCreateNew]: (input) =>
        managedFolders
          .createNamedProject(input)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
      [WS_METHODS.projectsCreateFromThread]: (input) =>
        scratchThreadPromotion
          .promote(input)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
      [WS_METHODS.projectCloneCancel]: (input) =>
        projectCloneTracker.cancel(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
      [WS_METHODS.projectCloneRetry]: (input) =>
        projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
      [WS_METHODS.subscribeProjectClones]: () => projectCloneTracker.stream,
      [WS_METHODS.projectsSearchEntries]: (input) =>
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                cwd: input.cwd,
                queryLength: input.query.length,
                limit: input.limit,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsSearchContents]: (input) =>
        workspaceEntries.searchContents(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchContentsError({
                cwd: input.cwd,
                queryLength: input.query.length,
                limit: input.limit,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsListEntries]: (input) =>
        workspaceEntries.list(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListEntriesError({
                ...input,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsListIgnoredFiles]: (input) =>
        workspaceEntries.listIgnoredFiles(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListEntriesError({
                ...input,
                ...projectEntriesFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsReadFile]: (input) =>
        workspaceFileSystem.readFile(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectReadFileError({
                ...input,
                ...projectFileFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        workspaceFileSystem.writeFile(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectWriteFileError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                ...projectFileFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsMutate]: (mutation) =>
        startup.enqueueCommand(mutateProject(mutation)).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectMutationError({
                commandId: mutation.commandId,
                message:
                  cause._tag === "ProjectNotEmptyError" || cause._tag === "ProjectInvalidError"
                    ? cause.message
                    : "Failed to mutate project.",
                cause,
              }),
          ),
        ),
      [WS_METHODS.shellOpenInEditor]: (input) => externalLauncher.launchEditor(input),
      [WS_METHODS.filesystemGetMetadata]: (input) => workspaceFileSystem.getMetadata(input),
      [WS_METHODS.filesystemBrowse]: (input) =>
        workspaceEntries.browse(input).pipe(
          Effect.mapError(
            (cause) =>
              new FilesystemBrowseError({
                ...input,
                ...filesystemBrowseFailureContext(cause),
                cause,
              }),
          ),
        ),
      [WS_METHODS.workspaceListFolders]: (input) => workspaceFolders.list(input),
      [WS_METHODS.workspaceScanFolders]: (input) => workspaceFolders.scan(input),
      [WS_METHODS.workspaceTaskFolder]: (input) =>
        taskFolders.find(input.worktreePath).pipe(Effect.map((taskFolder) => ({ taskFolder }))),
      [WS_METHODS.workspaceAddTaskFolderRepository]: (input) => taskFolders.addRepository(input),
      [WS_METHODS.workspaceLayoutCommands]: (input) => taskFolders.layoutCommands(input.projectId),
      // The one place an approval is recorded: a person's client session, behind the scope.
      [WS_METHODS.workspaceApproveLayoutCommands]: (input) =>
        Effect.forEach(
          input.approvals,
          (approval) => setLayoutCommandApproval({ projectId: input.projectId, ...approval }),
          { discard: true },
        ).pipe(Effect.andThen(taskFolders.layoutCommands(input.projectId))),
      [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
      [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
      [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
      [WS_METHODS.agentSessionsImport]: (input) =>
        agentSessionImporter.importRecentAgentThreads(input),
      [WS_METHODS.assetsCreateUrl]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* (input) {
          const path = yield* Path.Path;
          if (
            input.resource._tag === "attachment" ||
            input.resource._tag === "native-app-icon" ||
            input.resource._tag === "environment-theme-background" ||
            input.resource._tag === "tool-output-image" ||
            input.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ||
            // A network path is served only from the thread's project, looked up below.
            (input.resource._tag === "media-file" &&
              path.isAbsolute(input.resource.path) &&
              !isNetworkPath(input.resource.path))
          ) {
            return yield* issueAssetUrl({ resource: input.resource });
          }
          if (input.resource._tag === "draft-workspace-file") {
            return yield* issueAssetUrl({
              resource: input.resource,
              workspaceRoot: input.resource.cwd,
            });
          }
          if (input.resource._tag === "project-favicon") {
            const project = yield* projectStore.findActiveByWorkspaceRoot(input.resource.cwd).pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(project)) {
              return yield* new AssetWorkspaceContextNotFoundError({
                resource: input.resource,
              });
            }
            // Clone projects precede their files; clients retry asset URLs after clone completion.
            const clone = yield* projectCloneTracker.get(project.value.projectId);
            return yield* issueAssetUrl({
              resource: input.resource,
              ...(project.value.faviconPath
                ? { projectFaviconPath: project.value.faviconPath }
                : {}),
              ...(clone !== null && clone.destinationPath === project.value.workspaceRoot
                ? { projectCheckout: clone.phase === "done" ? "cloned" : "pending" }
                : {}),
            });
          }
          const thread = yield* threadManagement.getThreadRecords(input.resource.threadId, []).pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceContextResolutionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          );
          const project = yield* projectService.getById(thread.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceContextResolutionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new AssetWorkspaceContextNotFoundError({
              resource: input.resource,
            });
          }
          return yield* issueAssetUrl({
            resource: input.resource,
            workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
          });
        }),
      [WS_METHODS.assetsPersistChatAttachments]: (input) =>
        persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
      [WS_METHODS.terminalOpen]: (input) =>
        prepareTerminalLaunch(input).pipe(
          Effect.flatMap((launch) =>
            terminalManager
              .open(launch.input)
              .pipe(Effect.provideService(TerminalManager.TerminalCwdRecovery, launch.recover)),
          ),
        ),
      [WS_METHODS.terminalAttach]: (input, metadata) =>
        Stream.unwrap(
          prepareTerminalLaunch(input).pipe(
            Effect.map((launch) =>
              terminalManager
                .attachOutputStream(launch.input, terminalViewerId(metadata))
                .pipe(Stream.provideService(TerminalManager.TerminalCwdRecovery, launch.recover)),
            ),
          ),
        ),
      [WS_METHODS.terminalWrite]: (input, metadata) =>
        terminalManager.write(input, terminalViewerId(metadata)),
      [WS_METHODS.terminalResize]: (input, metadata) =>
        terminalManager.resize(input, terminalViewerId(metadata)),
      [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
      [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
      [WS_METHODS.terminalObserve]: (input) =>
        terminalOutputStream(
          (listener, registerCleanup) =>
            terminalManager.observeStream(input, listener, registerCleanup),
          (listener, registerCleanup) =>
            terminalManager.resyncStream(input, listener, registerCleanup),
        ),
      [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
        Stream.callback<TerminalMetadataStreamEvent>((queue) =>
          Effect.acquireRelease(
            terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [WS_METHODS.previewOpen]: (input) => previewManager.open(input),
      [WS_METHODS.previewResize]: (input) => previewManager.resize(input),
      [WS_METHODS.previewAdjust]: (input) => previewManager.adjust(input),
      [WS_METHODS.previewClose]: (input) => previewManager.close(input),
      [WS_METHODS.previewList]: (input) => previewManager.list(input),
      [WS_METHODS.previewClearProfile]: (input) => serverBrowser.clearProfile(input.profileId),
      [WS_METHODS.previewReportProfiles]: (input) => reportProfiles(input),
      [WS_METHODS.previewReportStatus]: (input) => previewManager.reportStatus(input),
      [WS_METHODS.subscribePreviewEvents]: (_input) => previewManager.events,
      [WS_METHODS.deviceConfigure]: (input) => deviceService.configure(input),
      [WS_METHODS.deviceTestHost]: (input) => deviceService.testHost(input),
      [WS_METHODS.deviceEasAccount]: (input) => deviceService.easAccount(input),
      [WS_METHODS.deviceSimlockIdentity]: (input) => deviceService.simlockIdentity(input),
      [WS_METHODS.deviceList]: (input) =>
        input.inspectOnly && !input.updateTool
          ? deviceService.inspect
          : authorizeEffect(
              currentSession,
              requiredScopeForDeviceList(input),
              input.updateTool
                ? deviceService.updateTool(input.updateTool)
                : input.retryHostId
                  ? deviceService.retryHost(input.retryHostId)
                  : deviceService.list,
            ),
      [WS_METHODS.deviceOpen]: (input) =>
        threadWorkspaceRoot(input.threadId).pipe(
          Effect.flatMap((workspaceRoot) => deviceService.open(input, { workspaceRoot })),
        ),
      [WS_METHODS.deviceClose]: (input) => deviceService.close(input),
      [WS_METHODS.deviceShutdown]: (input) => deviceService.shutdown(input),
      [WS_METHODS.deviceDetail]: (input) => deviceService.detail(input),
      [WS_METHODS.deviceAction]: (input) => deviceService.action(input),
      [WS_METHODS.subscribeDeviceState]: (_input) => DeviceService.stateStream(deviceService),
      [WS_METHODS.previewStopLocalServer]: (input) => portDiscovery.stopServer(input),
      [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
        Stream.callback<DiscoveredLocalServerList>((queue) =>
          Effect.gen(function* () {
            const configuredUrls = input.configuredUrls ?? [];
            yield* portDiscovery.retain;
            const initial = yield* portDiscovery.scan(configuredUrls);
            const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
            yield* Queue.offer(queue, {
              servers: initial,
              scannedAt: initialScannedAt,
              configuredUrlProbing: true,
            });
            yield* portDiscovery.subscribe(
              { configuredUrls, initialSnapshot: initial },
              (servers) =>
                Effect.gen(function* () {
                  const scannedAt = DateTime.formatIso(yield* DateTime.now);
                  yield* Queue.offer(queue, {
                    servers,
                    scannedAt,
                    configuredUrlProbing: true,
                  });
                }),
            );
          }),
        ),
    });

    return yield* PreviewDeviceTerminalWsRpcGroup.toHandlers(handlers);
  },
);
