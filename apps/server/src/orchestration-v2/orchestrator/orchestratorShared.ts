import {
  CommandId,
  type ChatAttachment,
  isCompactionCommandMessage,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  latestProviderTurnForAttempt,
  managedRuntimeModeCeilingMessage,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ContextSourcePoint,
  parseGoalCommand,
  ProviderInstanceId,
  ProviderInteractionMode,
  type RunId,
  RuntimeMode,
  ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@zerocode/contracts";
import * as IdAllocator from "@zerocode/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@zerocode/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@zerocode/provider-core/server/ProviderContinuationRequests";
import * as KeyedLock from "@zerocode/shared/KeyedLock";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
  usageLimitBlockedRun,
} from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../../serverSettings.ts";
import * as TaskFolderStore from "../../workspace/TaskFolderStore.ts";
import { CheckpointServiceV2 } from "../CheckpointService.ts";
import { CommandPolicyV2 } from "../CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { ContextHandoffServiceV2, readInheritedHandoffItems } from "../ContextHandoffService.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  narrowToCeiling,
  type RuntimeModeCeiling,
  runtimeModeCeilingRefusal,
  threadsStartingWork,
} from "../DispatchModeLimit.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import type {
  OrchestrationEffectRequestV2,
  PendingOrchestrationEffectV2,
} from "../EffectOutbox.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { isBufferedProviderNotification } from "../NotificationMailbox.ts";
import * as ProjectStore from "../ProjectStore.ts";
import {
  applyToProjection,
  emptyProjection,
  ProjectionStoreV2,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
} from "../ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "../ProviderSwitchService.ts";
import { isRuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "../RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import { ThreadForkServiceV2 } from "../ThreadForkService.ts";

export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorThreadAlreadyExistsError extends Schema.TaggedError<OrchestratorThreadAlreadyExistsError>()(
  "OrchestratorThreadAlreadyExistsError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} already exists. Use a new thread id.`;
  }
}

export class OrchestratorCommandRejectedError extends Schema.TaggedError<OrchestratorCommandRejectedError>()(
  "OrchestratorCommandRejectedError",
  { commandId: CommandId, commandType: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Orchestration command ${this.commandType} (${this.commandId}) was rejected before commit.`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedError<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export const isOrchestratorProjectionError = Schema.is(OrchestratorProjectionError);

export class OrchestratorDomainEventStreamError extends Schema.TaggedError<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedError<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorSubagentThreadReadOnlyError extends Schema.TaggedError<OrchestratorSubagentThreadReadOnlyError>()(
  "OrchestratorSubagentThreadReadOnlyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return "This subagent is run by its provider and cannot take messages. Message the parent thread instead.";
  }
}

export class OrchestratorThreadAboveModeLimitError extends Schema.TaggedError<OrchestratorThreadAboveModeLimitError>()(
  "OrchestratorThreadAboveModeLimitError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    mode: Schema.Literals(["runtime", "interaction"]),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} now runs in ${this.runtimeMode}/${this.interactionMode} mode, above what this caller may change.`;
  }
}

export class OrchestratorProviderSelectionBusyError extends Schema.TaggedError<OrchestratorProviderSelectionBusyError>()(
  "OrchestratorProviderSelectionBusyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} has an active turn. Wait for it to finish, then retry the provider selection change.`;
  }
}

const isOrchestratorDispatchError = Schema.is(OrchestratorDispatchError);

/** The ceiling refusal under however many dispatch errors wrapped it on the way out. */
export function runtimePolicyCeilingCause(error: unknown) {
  let current = error;
  while (isOrchestratorDispatchError(current)) current = current.cause;
  return isRuntimePolicyAboveCeilingError(current) ? current : undefined;
}

export class OrchestratorRuntimeModeAboveCeilingError extends Schema.TaggedError<OrchestratorRuntimeModeAboveCeilingError>()(
  "OrchestratorRuntimeModeAboveCeilingError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    refused: Schema.Literals(["mode", "turn"]),
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    const limit = managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode);
    return this.refused === "turn" ? `${limit} Switch this thread's mode to continue.` : limit;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export class OrchestratorCommandIdConflictError extends Schema.TaggedError<OrchestratorCommandIdConflictError>()(
  "OrchestratorCommandIdConflictError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    receiptThreadId: ThreadId,
    commandThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was already handled for thread ${this.receiptThreadId} and cannot be replayed for ${this.commandThreadId}.`;
  }
}

export const OrchestratorV2Error = Schema.Union([
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandIdConflictError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorProviderSelectionBusyError,
  OrchestratorRuntimeModeAboveCeilingError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;

export interface OrchestratorV2DispatchResult {
  readonly sequence: number;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  /** The command id was already accepted; analytics skip it. */
  readonly replayed?: true;
}

export interface CancelUnsettledEffects {
  readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
  readonly reason: string;
}

/** Unfinished runs (including queued) or open requests block moving a thread to another project. */
export function threadHasUnfinishedWork(records: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
}): boolean {
  return (
    records.runs.some(
      (run) =>
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        run.status !== "interrupted" &&
        run.status !== "rolled_back",
    ) || records.runtimeRequests.some((request) => request.status === "pending")
  );
}

export function commandThreadId(command: OrchestrationV2ServerCommand): ThreadId {
  switch (command.type) {
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.guest-share.open":
    case "thread.guest-share.redeem":
    case "thread.guest-share.close":
    case "thread.guest-message.submit":
    case "thread.guest-message.dismiss":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.tag.set":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.issue.link":
    case "thread.issue.unlink":
    case "thread.pull-request.watch":
    case "thread.pull-request-watch.sync":
    case "thread.pull-request-watch.checks-reopen":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.project.adopt-folder":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "notification.delivery.accept":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "prepared-run.retry":
    case "subagent.stop":
    case "run.interrupt":
    case "run.output.submit":
    case "queued-message.promote-to-steer":
    case "queued-run.start":
    case "queue.resume":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "runtime-request.delivery.fail":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "thread.interrupt.unresponsive":
    case "thread.stop":
    case "provider.switch":
      return command.threadId;
    case "delegated_task.request":
    case "delegated_task.remote.request":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return command.parentThreadId;
    case "secret_request.record":
    case "link_request.record":
      return command.threadId;
    case "thread.fork":
    case "thread.merge_back":
      return command.targetThreadId;
  }
}

export function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}

export function delegatedTasksStopEffect(command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly reason?: string | undefined;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${command.commandId}:delegated-tasks.stop`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "delegated-tasks.stop",
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  };
}

export const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";
/** How long automatic settlement waits for a queued turn to start. */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/** Stop ended this task, so its result is not delivered to the parent agent. */
export function cancelledAppOwnedTask(
  task: OrchestrationV2Subagent,
  now: DateTime.Utc,
): OrchestrationV2Subagent {
  return {
    ...task,
    status: "cancelled",
    completedAt: now,
    updatedAt: now,
    completionDelivery: { state: "disposed", observedByRunId: null },
  };
}

// Provider wakes can start follow-up work; monitor updates only report progress.
// Dispatch takes the parent's lock for follow-ups because intake writes the parent.
export function mayStartSubagentFollowup(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): boolean {
  if (command.scheduledTaskId !== undefined || command.restartContinuationOfRunId !== undefined)
    return false;
  if (isCompactionCommandMessage({ role: "user", ...command })) return false;
  if (command.notification !== undefined)
    return (
      command.notification.source.kind !== "monitor" || command.notification.outcome !== "updated"
    );
  return (
    command.createdBy === "user" ||
    command.creationSource === "mcp" ||
    command.usageLimitContinuationOfRunId !== undefined
  );
}

/** Waiting runs only drain post-terminal output; their agent turn is over and still needs a wake. */
export function isLiveRun(run: OrchestrationV2Run): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

export function hasLiveRun(projection: Pick<OrchestrationV2ThreadProjection, "runs">): boolean {
  return projection.runs.some(isLiveRun);
}

export function withPullRequestWatch(
  link: ThreadPullRequestLink,
  watch: ThreadPullRequestWatch | undefined,
): ThreadPullRequestLink {
  const { watch: previous, endedWatch, ...rest } = link;
  if (watch !== undefined) return { ...rest, watch };
  const ended = previous ?? endedWatch;
  return ended === undefined ? rest : { ...rest, endedWatch: ended };
}

const DELEGATED_RESULT_INLINE_BYTES = 16_000;

export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): string {
  let remainingBytes = DELEGATED_RESULT_INLINE_BYTES;
  return taskIds
    .map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      // A follow-up gets a fresh task id; the child thread links it to the task delegate_task returned.
      const thread = task?.childThreadId == null ? "" : ` in child thread ${task.childThreadId}`;
      const label = `Delegated task ${taskId}${task?.title == null ? "" : ` (${task.title})`}${thread}${task === undefined ? " reached a terminal state" : ` [${task.status}]`}`;
      if (task?.result != null) {
        const detail = `${label}:\n${task.result}`;
        const bytes = Buffer.byteLength(detail);
        if (bytes <= remainingBytes) {
          remainingBytes -= bytes;
          return detail;
        }
      }
      return `${label}. Use task_status with taskId ${taskId} to read the result.`;
    })
    .join("\n\n");
}

export function isTerminalDelegatedTaskStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function delegatedTaskTerminalStatus(
  status: OrchestrationV2Run["status"],
): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

/**
 * Failed worktree setup keeps the queue held so queued messages cannot start in the project checkout.
 * A run that started had its worktree, so ending it later is not a failed setup.
 */
export function worktreeSetupPending(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): boolean {
  return (
    projection.thread.worktreePath === null &&
    projection.runs.some(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.startedAt === null &&
        run.workspacePreparation?.type === "worktree",
    )
  );
}

// Delegated completions, monitor notifications and queued messages that name no model never choose a
// model, so a queued one runs on the thread's current pick rather than the one frozen at queue time.
export function followsCurrentConversation(
  message:
    | Pick<
        OrchestrationV2ConversationMessage,
        | "createdBy"
        | "creationSource"
        | "notification"
        | "delegatedCompletion"
        | "followsThreadSelection"
      >
    | undefined,
): boolean {
  return (
    message?.delegatedCompletion !== undefined ||
    message?.followsThreadSelection === true ||
    (message?.notification?.source.kind === "monitor" && !isBufferedProviderNotification(message))
  );
}

export function queuedRunModelSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
): ModelSelection {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return followsCurrentConversation(message)
    ? projection.thread.modelSelection
    : run.modelSelection;
}

/**
 * The provider's latest run stopped on its usage limit and nothing ran after it.
 * With `now` (automatic starts), a run on another provider since does not lift
 * a reported reset still in the future; an unknown reset is lifted, as transient 429s are.
 */
export function usageLimitHoldsQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  providerInstanceId: ModelSelection["instanceId"],
  now?: DateTime.Utc,
): boolean {
  let latestSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (
      session.providerInstanceId === providerInstanceId &&
      (latestSession === undefined ||
        DateTime.isGreaterThan(session.updatedAt, latestSession.updatedAt))
    ) {
      latestSession = session;
    }
  }
  const limited = usageLimitBlockedRun(
    projection.runs.filter((run) => run.providerInstanceId === providerInstanceId),
    projection.turnItems,
    latestSession?.lastError ?? null,
  );
  if (limited === null) return false;
  if (latestExecutedRun(projection.runs)?.id === limited.id) return true;
  if (now === undefined) return false;
  const resetAt = latestRootProviderFailure(limited, projection.turnItems)?.resetAt;
  return resetAt != null && Date.parse(resetAt) > DateTime.toEpochMillis(now);
}

export function pullRequestSnapshotEndsWatch(
  snapshot: ThreadPullRequestLink["snapshot"],
  watchStartedAt: ThreadPullRequestWatch["startedAt"],
): boolean {
  return (
    snapshot?.state === "merged" ||
    // A restarted watch can see a closed snapshot from before the PR reopened.
    (snapshot?.state === "closed" &&
      DateTime.isGreaterThanOrEqualTo(
        DateTime.makeUnsafe(snapshot.syncedAt),
        DateTime.makeUnsafe(watchStartedAt),
      ))
  );
}

export function queuedRunCancellationEvents(
  projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">,
  run: OrchestrationV2Run,
  now: DateTime.Utc,
): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> {
  const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId);
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [
    {
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
    },
  ];
  if (attempt !== undefined && rootNode !== undefined) {
    events.push({
      type: "run-attempt.updated",
      threadId: run.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...attempt, status: "cancelled", completedAt: now },
    });
  }
  if (rootNode !== undefined) {
    events.push({
      type: "node.updated",
      threadId: run.threadId,
      runId: run.id,
      nodeId: rootNode.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...rootNode, status: "cancelled", completedAt: now },
    });
  }
  return events;
}

function latestStartedRun(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | undefined {
  return runs
    .filter((run) => run.status !== "queued")
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
      undefined,
    );
}

export function providerThreadForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderThread | undefined {
  return run.providerThreadId === null
    ? undefined
    : projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId);
}

export function providerTurnForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderTurn | undefined {
  if (run.activeAttemptId === null) {
    return undefined;
  }
  const latest = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  if (latest !== undefined) {
    return latest;
  }
  const namedTurnId = projection.attempts.find(
    (candidate) => candidate.id === run.activeAttemptId,
  )?.providerTurnId;
  return namedTurnId === undefined || namedTurnId === null
    ? undefined
    : projection.providerTurns.find((turn) => turn.id === namedTurnId);
}

export function contextSourcePointForRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts"
  >,
  run: OrchestrationV2Run,
): OrchestrationV2ContextSourcePoint {
  const providerThread = providerThreadForRun(projection, run);
  const providerTurn = providerTurnForRun(projection, run);
  return {
    threadId: projection.thread.id,
    runId: run.id,
    ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
    ...(providerThread?.nativeThreadRef === null || providerThread?.nativeThreadRef === undefined
      ? {}
      : { providerThreadRef: providerThread.nativeThreadRef }),
    ...(providerTurn?.nativeTurnRef === null || providerTurn?.nativeTurnRef === undefined
      ? {}
      : { providerTurnRef: providerTurn.nativeTurnRef }),
  };
}

export function shouldPrepareLegacyImportHandoff(input: {
  readonly hasNativeHistory?: boolean;
  readonly hasCompletedRun: boolean;
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly legacyImportItemCount: number;
}): boolean {
  return (
    input.historyOrigin === "v1_import" &&
    !input.hasNativeHistory &&
    !input.hasCompletedRun &&
    input.legacyImportItemCount > 0
  );
}

export const hasRunningDelegatedTasks = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
  subagents.some(
    (task) =>
      task.origin === "app_owned" &&
      task.childThreadId !== null &&
      isOrchestrationV2WorkActive(task.status),
  );

interface OrchestratorServiceDeps {
  readonly checkpointService: CheckpointServiceV2["Service"];
  readonly commandPolicy: CommandPolicyV2["Service"];
  readonly contextHandoffService: ContextHandoffServiceV2["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly commandReceipts: CommandReceiptStoreV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly taskFolderStore: TaskFolderStore.TaskFolderStore["Service"];
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly effectOutbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly providerAdapters: ProviderAdapterRegistryV2["Service"];
  readonly continuationRequests: Effect.Success<
    typeof ProviderContinuationRequests.ProviderContinuationRequests
  >;
  readonly providerSessions: ProviderSessionManagerV2["Service"];
  readonly providerSwitchService: ProviderSwitchServiceV2["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly runtimePolicy: RuntimePolicyV2["Service"];
  readonly threadForkService: ThreadForkServiceV2["Service"];
  readonly threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
  readonly messageIntake: KeyedLock.KeyedLock<ThreadId>;
  readonly runtimeModeCeiling: RuntimeModeCeiling | undefined;
}

export function makeOrchestratorShared(deps: OrchestratorServiceDeps) {
  const {
    idAllocator,
    projectionStore,
    effectOutbox,
    providerAdapters,
    providerSessions,
    eventSink,
    runtimeModeCeiling,
  } = deps;

  const nextTurnItemOrdinal = (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) =>
    projectionStore.getNextTurnItemOrdinal(projection.thread.id).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: projection.thread.id, cause }),
      ),
      Effect.map((next) =>
        (projection.turnItems ?? []).reduce(
          (ordinal, item) => Math.max(ordinal, item.ordinal + 1),
          next,
        ),
      ),
    );

  const mapDispatchError =
    (command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const mapDelegatedCompletionError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: CommandId.make("command:system:delegated-completion-delivery"),
            commandType: "delegated_task.completion-delivery",
            cause,
          }),
      ),
    );

  /** The driver when this provider runs `/goal` natively, else undefined. */
  const goalDriverFor = Effect.fn("Orchestrator.goalDriverFor")(function* (
    command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">,
    providerInstanceId: ProviderInstanceId,
  ) {
    const adapter = yield* providerAdapters.get(providerInstanceId).pipe(mapDispatchError(command));
    const { driver } = adapter;
    if (driver === "opencode" || driver === "antigravity") {
      const capabilities = yield* adapter.getCapabilities().pipe(mapDispatchError(command));
      return capabilities.turns.supportsNativeGoals === true ? driver : undefined;
    }
    return driver === "codex" || driver === "claudeAgent" ? driver : undefined;
  });

  /** Unsupported goal controls can become new objectives in native providers. */
  const ensureGoalCommandSupported = Effect.fn("Orchestrator.ensureGoalCommandSupported")(
    function* (
      command: Pick<OrchestrationV2ServerCommand, "commandId" | "type">,
      message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
      providerInstanceId: ProviderInstanceId,
    ) {
      const goalCommand = parseGoalCommand(message);
      if (goalCommand === null || goalCommand.type === "set") return;
      const driver = yield* goalDriverFor(command, providerInstanceId);
      if (driver === "antigravity") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "Antigravity accepts /goal followed by an objective. Interrupt the running turn, then ask Antigravity to stop the current goal.",
        });
      }
      if (goalCommand.type !== "pause" && goalCommand.type !== "resume") return;
      if (driver !== "claudeAgent") return;
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.",
      });
    },
  );

  const providerSessionIdFor = (input: {
    readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) =>
    input.adapter.getCapabilities().pipe(
      Effect.flatMap((capabilities) =>
        capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? Effect.succeed(
              idAllocator.derive.providerSession({
                providerInstanceId: input.providerInstanceId,
              }),
            )
          : idAllocator.allocate.providerSession({
              providerInstanceId: input.providerInstanceId,
              threadId: input.threadId,
            }),
      ),
    );

  const makeEvent =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* <Event extends OrchestrationV2DomainEvent>(
      command: OrchestrationV2ServerCommand,
      event: Omit<Event, "id">,
    ) {
      const eventId = yield* mapDispatchError(command)(
        idAllocator.allocate.event({
          threadId: event.threadId,
          commandId: command.commandId,
        }),
      );
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const emit =
    (events: Ref.Ref<Array<OrchestrationV2DomainEvent>>, command: OrchestrationV2ServerCommand) =>
    <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const withId = yield* makeEvent(command, event);
        yield* Ref.update(events, (existing) => [...existing, withId]);
        return withId;
      });

  // Detaching kills background work running inside the provider process.
  // Probe even with an empty roster: Claude's native subagents never reach
  // pendingBackgroundTasks. Sessions shared across threads probe per thread.
  const sessionHasBackgroundWork = Effect.fn("Orchestrator.sessionHasBackgroundWork")(function* (
    detaching: OrchestrationV2ProviderSession,
    providerThreads: OrchestrationV2ThreadProjection["providerThreads"],
  ) {
    const session = yield* providerSessions
      .get(detaching.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session)) return false;
    const runtime = session.value;
    const probes =
      !detaching.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
      runtime.hasPendingBackgroundWork !== undefined
        ? [runtime.hasPendingBackgroundWork]
        : providerThreads.flatMap((providerThread) =>
            providerThread.providerSessionId === detaching.id &&
            runtime.hasPendingBackgroundWorkForThread !== undefined
              ? [runtime.hasPendingBackgroundWorkForThread(providerThread)]
              : [],
          );
    for (const probe of probes) {
      // A failed probe cannot confirm that the work ended.
      if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) return true;
    }
    return false;
  });

  // A run completes before its turn-end checkpoint capture. Steers and queued turns advance when
  // the capture commits and repeats the update, after the deliveries ahead of it on the lane.
  const awaitsCheckpointCapture = (run: OrchestrationV2Run) =>
    run.status !== "completed" || run.checkpointId !== null
      ? Effect.succeed(false)
      : effectOutbox.get(`effect:checkpoint.capture:${run.id}`).pipe(
          Effect.map(
            Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
          ),
          Effect.orElseSucceed(() => false),
        );

  const awaitLatestRunCapture = Effect.fn("Orchestrator.awaitLatestRunCapture")(
    function* (threadId: ThreadId) {
      const { runs } = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
      const latest = latestStartedRun(runs);
      if (latest === undefined || !(yield* awaitsCheckpointCapture(latest))) return;
      yield* effectOutbox.awaitSettled(`effect:checkpoint.capture:${latest.id}`);
    },
    (effect) => Effect.ignore(effect),
  );

  // Commands decide as if the latest run were still `waiting` until its turn-end capture commits:
  // the capture keeps the thread's effect lane, and steers and queued turns must line up behind it.
  const holdRunAwaitingCapture = Effect.fn("Orchestrator.holdRunAwaitingCapture")(function* (
    projection: OrchestrationV2ThreadProjection,
  ) {
    const latest = latestStartedRun(projection.runs);
    if (latest === undefined || !(yield* awaitsCheckpointCapture(latest))) return projection;
    return {
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === latest.id ? { ...run, status: "waiting" as const, completedAt: null } : run,
      ),
    };
  });

  // Runs in every command transaction; avoid reading thousands of finished leaf nodes.
  const readCommandProjection = (
    threadId: ThreadId,
    recent?: ProjectionRecordFilter["sinceLastCompaction"],
  ) =>
    projectionStore
      .getThreadRecords(
        threadId,
        [
          "runs",
          "attempts",
          "nodes",
          "subagents",
          "providerSessions",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "messages",
          "turnItems",
          "checkpointScopes",
          "contextTransfers",
        ],
        {
          turnItemTypes: ["user_message", "error"],
          messageRoles: ["user"],
          omitSettledLeafNodes: true,
          // Commands here read only undelivered or active tasks; a dispatcher thread keeps
          // thousands of delivered ones, each carrying its full prompt.
          omitSettledSubagents: true,
          // No command reads a settled task's node or its child's provider thread.
          omitSettledSubagentRecords: true,
          // Commands act on pending forks and merge-backs only; consumed ones stay unread.
          contextTransferStatuses: ["pending"],
          ...(recent === undefined ? {} : { sinceLastCompaction: recent }),
        },
      )
      .pipe(
        Effect.map((records): OrchestrationV2ThreadProjection => ({
          ...records,
          checkpoints: [],
          plans: [],
          contextHandoffs: [],
          visibleTurnItems: [],
          updatedAt: records.thread.updatedAt,
        })),
        Effect.flatMap(holdRunAwaitingCapture),
        Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
      );

  // Command reads omit settled tasks, but a completion notice counts its whole cohort.
  const notificationTasks = (
    threadId: ThreadId,
    message: Pick<OrchestrationV2ConversationMessage, "delegatedCompletion">,
    loaded: ReadonlyArray<OrchestrationV2Subagent>,
  ) =>
    message.delegatedCompletion === undefined
      ? Effect.succeed(loaded)
      : projectionStore
          .getThreadRecords(threadId, ["subagents"], {
            subagentRunIds: [message.delegatedCompletion.parentRunId],
          })
          .pipe(
            Effect.map((records) => records.subagents),
            Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
          );

  const readHandoffItems = (threadId: ThreadId, runIds?: ReadonlyArray<RunId | null>) =>
    projectionStore
      .getThreadRecords(
        threadId,
        ["turnItems"],
        runIds === undefined ? undefined : { turnItemRunIds: runIds },
      )
      .pipe(
        Effect.map((records) => records.turnItems),
        Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
      );

  const readInheritedItems = (thread: OrchestrationV2AppThread) =>
    readInheritedHandoffItems(projectionStore, thread).pipe(
      Effect.mapError((cause) => new OrchestratorProjectionError({ threadId: thread.id, cause })),
    );

  /** Includes tombstones, which still reserve their id. */
  const findThread = (threadId: ThreadId) =>
    projectionStore
      .findThread(threadId)
      .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));

  /** Side chats live inside their parent, so deleting or archiving the parent takes them too. */
  const liveSideChatIds = Effect.fn("Orchestrator.liveSideChatIds")(
    function* (threadId: ThreadId) {
      const { contextTransfers } = yield* projectionStore
        .getThreadRecords(threadId, ["contextTransfers"])
        .pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed({ contextTransfers: [] }),
          }),
        );
      const sideChatIds: Array<ThreadId> = [];
      for (const transfer of contextTransfers) {
        if (transfer.type !== "fork" || transfer.sourceThreadId !== threadId) continue;
        const child = yield* projectionStore.findThread(transfer.targetThreadId);
        if (child?.lineage.sideChat === true && child.deletedAt === null) {
          sideChatIds.push(child.id);
        }
      }
      return sideChatIds;
    },
    (effect, threadId) =>
      effect.pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
  );

  const getProjectionWithPendingEvents =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* (
      threadId: ThreadId,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      recent?: ProjectionRecordFilter["sinceLastCompaction"],
    ) {
      const pending = (yield* Ref.get(events)).filter((event) => event.threadId === threadId);
      const created = pending.find(
        (
          event,
        ): event is Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }> =>
          event.type === "thread.created",
      );
      // A thread created here has no stored row: create and fork refuse used ids, delegation derives a fresh one.
      let projection: OrchestrationV2ThreadProjection;
      if (created === undefined) {
        projection = yield* readCommandProjection(threadId, recent);
      } else {
        projection = emptyProjection(created);
      }

      for (const event of pending) {
        if (event.type === "thread.created" && projection.thread.id === event.payload.id) {
          projection = { ...projection, thread: event.payload, updatedAt: event.occurredAt };
          continue;
        }
        projection = applyToProjection(projection, event);
      }
      return projection;
    });

  const makeSystemEvent =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* <Event extends OrchestrationV2DomainEvent>(
      event: Omit<Event, "id">,
    ) {
      const eventId = yield* idAllocator.allocate.event({
        threadId: event.threadId,
      });
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const writeSystemEvents =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(function* (
      events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
      effects: ReadonlyArray<PendingOrchestrationEffectV2> = [],
      options: { readonly updateDelegatedCompletionOnly?: boolean } = {},
    ) {
      const withIds = yield* Effect.forEach(events, (event) => makeSystemEvent(event));
      yield* eventSink.writeWithEffects({ events: withIds, effects, ...options });
    });

  const emitQueuedRunCancellation = Effect.fn("Orchestrator.emitQueuedRunCancellation")(
    function* (input: {
      readonly command: OrchestrationV2ServerCommand;
      readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
      readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">;
      readonly run: OrchestrationV2Run;
      readonly now: DateTime.Utc;
    }) {
      const emitEvent = emit(input.events, input.command);
      for (const event of queuedRunCancellationEvents(input.projection, input.run, input.now)) {
        yield* emitEvent(event);
      }
    },
  );

  // A turn keeps the modes it started with, so a thread lowered since can hold a broader one.
  // A turn that recorded none is taken as unrestricted.
  const turnStartedModes = (
    attempts: ReadonlyArray<OrchestrationV2RunAttempt>,
    run: OrchestrationV2Run | undefined,
  ) =>
    attempts.find((attempt) => attempt.id === run?.activeAttemptId)?.startedModes ?? {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    };

  // A parked steer is delivered later by the server, without the caller's limit, into a turn
  // whose modes are not recorded yet. Only a caller allowed any turn may park or rewrite one.
  const limitForbidsParkedSteer = Effect.gen(function* () {
    const limit = narrowToCeiling(yield* DispatchModeLimit, runtimeModeCeiling);
    return (
      limit !== undefined &&
      exceededDispatchModeLimit(limit, {
        runtimeMode: "full-access",
        interactionMode: "default",
      }) !== undefined
    );
  });

  const refuseAboveDispatchModeLimit = Effect.fn("orchestrationV2.dispatch.refuseAboveModeLimit")(
    function* (
      command: OrchestrationV2ServerCommand,
      threadId: ThreadId,
      modes: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) {
      const limit = narrowToCeiling(yield* DispatchModeLimit, runtimeModeCeiling);
      const exceeded = limit === undefined ? undefined : exceededDispatchModeLimit(limit, modes);
      if (limit === undefined || exceeded === undefined) return;
      const refusal = {
        threadId,
        mode: exceeded,
        runtimeMode: modes.runtimeMode,
        interactionMode: modes.interactionMode,
      };
      if (limit.refused !== undefined) yield* Ref.set(limit.refused, refusal);
      return yield* new OrchestratorThreadAboveModeLimitError({
        commandId: command.commandId,
        ...refusal,
      });
    },
  );

  const refuseAboveRuntimeModeCeiling = Effect.fn(
    "orchestrationV2.dispatch.refuseAboveRuntimeModeCeiling",
  )(function* (
    command: OrchestrationV2ServerCommand,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) {
    if (runtimeModeCeiling === undefined) return;
    const runtimeModes = new Map<ThreadId, RuntimeMode>();
    for (const threadId of threadsStartingWork(events)) {
      const thread = yield* findThread(threadId);
      if (thread !== null) runtimeModes.set(threadId, thread.runtimeMode);
    }
    const refusal = runtimeModeCeilingRefusal(
      runtimeModeCeiling.maxRuntimeMode,
      events,
      runtimeModes,
    );
    if (refusal === undefined) return;
    return yield* new OrchestratorRuntimeModeAboveCeilingError({
      commandId: command.commandId,
      ...refusal,
      ...runtimeModeCeiling,
    });
  });

  // Providers own native subagent conversations; messages cannot target them, and adapters ask questions on the parent.
  const refuseNativeSubagentMessage = Effect.fnUntraced(function* (
    command: Pick<OrchestrationV2Command, "commandId"> & { readonly threadId: ThreadId },
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (isProviderNativeSubagentThread(thread)) {
      return yield* new OrchestratorSubagentThreadReadOnlyError({
        commandId: command.commandId,
        threadId: command.threadId,
      });
    }
    return thread;
  });

  const subagentCount = (threadId: ThreadId) =>
    projectionStore
      .getSubagentCount(threadId)
      .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));

  const loadProjectionForCommand = <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    projectionStore
      .getThreadRecords(commandThreadId(command), fields, filter)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: commandThreadId(command), cause }),
        ),
      );

  /** Late tool calls and restart continuations must not outlive Stop. */
  const stopReachedRun = (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => projectionStore.hasRunInterruptRequest(threadId, runId).pipe(mapDispatchError(command));

  const awaitsRestartContinuation = (run: OrchestrationV2Run) =>
    effectOutbox
      .get(`effect:restart-continuation:${run.id}`)
      .pipe(
        Effect.map(
          Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
        ),
      );

  const childAwaitsRestartContinuation = (
    runs: ReadonlyArray<OrchestrationV2Run>,
    resultRun: OrchestrationV2Run,
    settledContinuationOf?: RunId,
  ) =>
    Effect.forEach(
      runs.filter(
        (run) =>
          run.id !== settledContinuationOf &&
          (run.id === resultRun.id || runRanAfter(run, resultRun)),
      ),
      awaitsRestartContinuation,
    ).pipe(Effect.map((pending) => pending.includes(true)));

  return {
    ...deps,
    nextTurnItemOrdinal,
    goalDriverFor,
    ensureGoalCommandSupported,
    mapDispatchError,
    mapDelegatedCompletionError,
    providerSessionIdFor,
    emit,
    sessionHasBackgroundWork,
    readCommandProjection,
    notificationTasks,
    readHandoffItems,
    readInheritedItems,
    findThread,
    liveSideChatIds,
    getProjectionWithPendingEvents,
    makeSystemEvent,
    writeSystemEvents,
    emitQueuedRunCancellation,
    awaitsCheckpointCapture,
    awaitLatestRunCapture,
    awaitsRestartContinuation,
    childAwaitsRestartContinuation,
    stopReachedRun,
    subagentCount,
    loadProjectionForCommand,
    turnStartedModes,
    limitForbidsParkedSteer,
    refuseAboveDispatchModeLimit,
    refuseAboveRuntimeModeCeiling,
    refuseNativeSubagentMessage,
  };
}

export type OrchestratorShared = ReturnType<typeof makeOrchestratorShared>;
