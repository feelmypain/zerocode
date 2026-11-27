import { CommandId, type ModelSelection, type ThreadId } from "@zerocode/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import {
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@zerocode/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadTriageOutbox } from "./threadTriageOutbox.ts";
import * as DateTime from "effect/DateTime";

import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  environmentConnectionAtom,
} from "./runtime.ts";
import { waitForTitleRegenerationOutcome } from "./threadTitleRegeneration.ts";
import {
  type InterruptThreadTurnInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  closeGuestShare,
  resolveGuestMessage,
  cancelQueuedRun,
  createThread,
  deleteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkSideChat,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  promoteQueuedRun,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  linkThreadIssue,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unlinkThreadIssue,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import {
  forEachTrackedAtomRegistry,
  onEnvironmentDisposed,
  trackAtomRegistry,
} from "../connection/disposal.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
  readonly throughEntryId?: string;
  readonly workAnchorId?: string;
};

function applySettle(
  thread: OrchestrationV2ThreadShell,
  now: DateTime.Utc,
  accepted: boolean,
): OrchestrationV2ThreadShell {
  return !accepted &&
    (thread.pendingRuntimeRequest !== null ||
      ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
    ? thread
    : {
        ...thread,
        pendingRuntimeRequest: null,
        settledOverride: "settled",
        settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
        unsettledAt: null,
        activeOrderKey: null,
        pinnedAt: null,
        pinOrderKey: null,
        snoozedAt: null,
        snoozedUntil: null,
      };
}

function applySnooze(
  thread: OrchestrationV2ThreadShell,
  snoozedUntil: string,
  now: DateTime.Utc,
  accepted: boolean,
): OrchestrationV2ThreadShell {
  return (!accepted &&
    ((thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input") ||
      ["preparing", "queued", "starting"].includes(thread.status))) ||
    !(Date.parse(snoozedUntil) > DateTime.toEpochMillis(now))
    ? thread
    : {
        ...thread,
        snoozedUntil: DateTime.makeUnsafe(snoozedUntil),
        snoozedAt: now,
      };
}

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  /** Offline settle and snooze are sent once this reports a synchronized shell. */
  shellStatusAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialLane = (lane: string) => ({
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      `${lane}:${JSON.stringify([environmentId, input.threadId])}`,
  });
  // Separate lanes prevent slow turns (uploads/60s retries) or feedback uploads from blocking
  // urgent controls, visits, or triage actions on the same thread.
  const turnConcurrency = serialLane("turn");
  const lifecycleConcurrency = serialLane("lifecycle");
  const visitConcurrency = serialLane("visit");
  const metadataConcurrency = serialLane("metadata");
  const feedbackConcurrency = serialLane("feedback");
  const loadEarlierHistory = Effect.fn("ThreadCommands.loadEarlierHistory")(function* (
    input: LoadEarlierThreadHistoryInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    if (Option.isNone(controller)) {
      return {
        _tag: "noop",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    return yield* controller.value.loadEarlier(
      supervisor.target.environmentId,
      input.threadId,
      input.throughEntryId,
      input.workAnchorId,
    );
  });

  // Runs whether or not the server accepted the interrupt, so a stale cached item still
  // settles when Stop had nothing to interrupt; the interrupt's own failure still surfaces.
  // The repair is detached: closing the thread cancels the repair, not the Stop that triggered it.
  const interruptTurn = Effect.fn("ThreadCommands.interruptTurn")(function* (
    input: InterruptThreadTurnInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    return yield* interruptThreadTurn(input).pipe(
      Effect.ensuring(
        Option.match(controller, {
          onNone: () => Effect.void,
          onSome: (value) =>
            value
              .reconcilePendingWork(supervisor.target.environmentId, input.threadId)
              .pipe(Effect.forkDetach, Effect.asVoid),
        }),
      ),
    );
  });

  const armTitleRegeneration = Effect.fn("ThreadCommands.armTitleRegeneration")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const requestId = CommandId.make(yield* random.uuidV4());
    const result = yield* updateThreadMetadata({
      threadId: input.threadId,
      regenerateTitle: true,
      commandId: requestId,
    });
    return { requestId, sequence: result.sequence };
  });

  // Counts the commands that move or remove a thread's row. A list that holds its rows while
  // environments synchronize (`stepSteadyShells`) shows the user's own change at once.
  const rowActionsAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const rowAction = <W extends { readonly environmentId: EnvironmentId }, A, E>(
    command: AtomCommand<W, A, E>,
  ): AtomCommand<W, A, E> => ({
    label: command.label,
    run: (registry, target) =>
      Effect.suspend(() => {
        trackAtomRegistry(registry);
        registry.update(rowActionsAtom(target.environmentId), (count) => count + 1);
        return command.run(registry, target);
      }),
  });

  // The environment's time of the last sign-in to a server in a thread, until the app reloads.
  const mcpSignedInAtFamily = Atom.family((_key: string) =>
    Atom.make<number | null>(null).pipe(Atom.keepAlive),
  );
  const mcpSignInKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  onEnvironmentDisposed((environmentId) => {
    const rowAtom = rowActionsAtom(environmentId);
    const signInKeys = mcpSignInKeysByEnvironment.get(environmentId);
    mcpSignInKeysByEnvironment.delete(environmentId);
    forEachTrackedAtomRegistry((registry) => {
      const nodes = registry.getNodes();
      if (nodes.has(rowAtom)) {
        registry.set(rowAtom, 0);
      }
      if (signInKeys !== undefined) {
        for (const key of signInKeys) {
          const signInAtom = mcpSignedInAtFamily(key);
          if (nodes.has(signInAtom)) {
            registry.set(signInAtom, null);
          }
        }
      }
    });
  });
  const mcpSignInKey = (
    environmentId: EnvironmentId,
    input: { readonly threadId: ThreadId; readonly server: string },
  ) => JSON.stringify([environmentId, input.threadId, input.server]);
  const markMcpSignedIn = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input: { readonly threadId: ThreadId; readonly server: string },
    signedInAt: string,
  ) => {
    trackAtomRegistry(registry);
    const key = mcpSignInKey(environmentId, input);
    let keys = mcpSignInKeysByEnvironment.get(environmentId);
    if (keys === undefined) {
      keys = new Set();
      mcpSignInKeysByEnvironment.set(environmentId, keys);
    }
    keys.add(key);
    registry.update(mcpSignedInAtFamily(key), (current) =>
      Math.max(current ?? 0, Date.parse(signedInAt)),
    );
  };
  const mcpNoticeSignedInFamily = Atom.family((key: string) => {
    const [signInKey, noticeAt] = JSON.parse(key) as [string, number];
    // A notice newer than the sign-in means the server needs one again.
    return Atom.make((get) => {
      const signedInAt = get(mcpSignedInAtFamily(signInKey));
      return signedInAt !== null && noticeAt <= signedInAt;
    });
  });
  /** Whether a sign-in notice, by its environment time, came before the server was signed in. */
  const mcpSignedInAtom = (
    environmentId: EnvironmentId,
    input: { readonly threadId: ThreadId; readonly server: string; readonly noticeAt: number },
  ) =>
    mcpNoticeSignedInFamily(JSON.stringify([mcpSignInKey(environmentId, input), input.noticeAt]));
  const sent = {
    armTitleRegeneration: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:regenerate-title",
      execute: armTitleRegeneration,
      scheduler,
      concurrency: metadataConcurrency,
    }),

    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: createThread,
      scheduler,
      concurrency: turnConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: deleteThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    closeGuestShare: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:close-guest-share",
      execute: closeGuestShare,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    resolveGuestMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolve-guest-message",
      execute: resolveGuestMessage,
      scheduler,
      concurrency: turnConcurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: archiveThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: unarchiveThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: settleThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: unsettleThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: snoozeThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: unsnoozeThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: pinThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: unpinThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: reorderPinnedThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: setThreadAutoSettle,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: reorderActiveThread,
      scheduler,
      concurrency: lifecycleConcurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: visitThread,
      scheduler,
      concurrency: visitConcurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: markThreadUnread,
      scheduler,
      concurrency: visitConcurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: updateThreadMetadata,
      scheduler,
      concurrency: turnConcurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: linkThreadPullRequest,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: unlinkThreadPullRequest,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: watchThreadPullRequest,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    setModelSelection: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-model-selection",
      execute: (input: UpdateThreadMetadataInput & { readonly modelSelection: ModelSelection }) =>
        updateThreadMetadata(input),
      scheduler,
      concurrency: turnConcurrency,
    }),
    linkIssue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-issue",
      execute: linkThreadIssue,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    unlinkIssue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-issue",
      execute: unlinkThreadIssue,
      scheduler,
      concurrency: metadataConcurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: setThreadRuntimeMode,
      scheduler,
      concurrency: turnConcurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: setThreadInteractionMode,
      scheduler,
      concurrency: turnConcurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: startThreadTurn,
      scheduler,
      concurrency: turnConcurrency,
    }),
    // Urgent control actions bypass the turn queue so Stop and pending-request replies never
    // wait behind attachment uploads or 60s send retries.
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: interruptTurn,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: respondToThreadApproval,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: respondToThreadUserInput,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: dismissThreadUserInput,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: revertThreadCheckpoint,
      scheduler,
      concurrency: turnConcurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: stopThreadSession,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: forkThreadFromRun,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    forkSideChat: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-side-chat",
      execute: forkSideChat,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: mergeThreadBack,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: resumeThreadQueue,
      scheduler,
      concurrency: turnConcurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: promoteQueuedRun,
      scheduler,
      concurrency: turnConcurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: cancelQueuedRun,
      scheduler,
      concurrency: turnConcurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: retryWorkspacePreparation,
      scheduler,
      concurrency: turnConcurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: editQueuedRun,
      scheduler,
      concurrency: turnConcurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: loadEarlierHistory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `history:${JSON.stringify([environmentId, input.threadId])}`,
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency: feedbackConcurrency,
    }),
    // Outside the thread's queue: finishing can wait on the agent, and messages must not.
    mcpSignInStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:mcp-sign-in-start",
      tag: WS_METHODS.providerMcpSignInStart,
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          if (result.signedInAt !== null) {
            markMcpSignedIn(registry, environmentId, input, result.signedInAt);
          }
        }),
    }),
    mcpSignInComplete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:mcp-sign-in-complete",
      tag: WS_METHODS.providerMcpSignInComplete,
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => markMcpSignedIn(registry, environmentId, input, result.signedInAt)),
    }),
  };
  const commands = {
    ...sent,
    delete: rowAction(sent.delete),
    archive: rowAction(sent.archive),
    unarchive: rowAction(sent.unarchive),
    settle: rowAction(sent.settle),
    unsettle: rowAction(sent.unsettle),
    snooze: rowAction(sent.snooze),
    unsnooze: rowAction(sent.unsnooze),
    pin: rowAction(sent.pin),
    unpin: rowAction(sent.unpin),
  };
  const triage = createThreadTriageOutbox({
    runtime,
    sourceSnapshotAtom: snapshotAtom,
    shellStatusAtom,
    apply: (thread, action, queuedAt) =>
      action.type === "settle"
        ? applySettle(thread, queuedAt, false)
        : applySnooze(thread, action.snoozedUntil, queuedAt, false),
    send: (registry, { environmentId, threadId, commandId, action }) =>
      action.type === "settle"
        ? settle.run(registry, { environmentId, input: { threadId, commandId } })
        : snooze.run(registry, {
            environmentId,
            input: { threadId, commandId, snoozedUntil: action.snoozedUntil },
          }),
  });
  const optimistic = createOptimisticThreadLifecycle(triage.snapshotAtom);
  const settle = optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
    applySettle(thread, now, accepted),
  );
  const snooze = optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
    applySnooze(thread, input.snoozedUntil, now, accepted),
  );
  const disconnectedAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const connection = AsyncResult.getOrElse(
        get(environmentConnectionAtom(runtime, environmentId)),
        () => null,
      );
      return connection !== null && connectionProjectionPhase(connection[0]) === "disconnected";
    }),
  );
  const regenerateTitle = {
    label: commands.armTitleRegeneration.label,
    run: (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: { threadId: ThreadId } },
    ) =>
      commands.armTitleRegeneration.run(registry, target).pipe(
        Effect.flatMap((armed) =>
          waitForTitleRegenerationOutcome(
            registry,
            {
              snapshot: snapshotAtom(target.environmentId),
              disconnected: disconnectedAtom(target.environmentId),
            },
            { threadId: target.input.threadId, ...armed },
          ),
        ),
      ),
  };
  return {
    ...commands,
    regenerateTitle,
    rowActionsAtom,
    mcpSignedInAtom,
    snapshotAtom: optimistic.snapshotAtom,
    pendingThreadIdsAtom: optimistic.pendingThreadIdsAtom,
    pendingSyncAtom: triage.pendingSyncAtom,
    // Queued inside the optimistic update, so it stays shown until the queued entry replaces it.
    settle: optimistic.wrap(
      triage.queueWhenOffline(commands.settle, () => ({ type: "settle" as const })),
      (thread, _input, now, accepted) => applySettle(thread, now, accepted),
    ),
    unsettle: triage.cancelQueued(
      optimistic.wrap(commands.unsettle, (thread, input, now) => ({
        ...thread,
        settledOverride: input.reason === "user" ? "active" : null,
        settledAt: null,
        unsettledAt:
          thread.settledOverride === "active"
            ? (thread.unsettledAt ?? null)
            : input.restoreUnsettledAt === undefined
              ? now
              : input.restoreUnsettledAt === null
                ? null
                : DateTime.makeUnsafe(input.restoreUnsettledAt),
      })),
      "settle",
    ),
    snooze: optimistic.wrap(
      triage.queueWhenOffline(commands.snooze, (input) => ({
        type: "snooze" as const,
        snoozedUntil: input.snoozedUntil,
      })),
      (thread, input, now, accepted) => applySnooze(thread, input.snoozedUntil, now, accepted),
    ),
    unsnooze: triage.cancelQueued(
      optimistic.wrap(commands.unsnooze, (thread) => ({
        ...thread,
        snoozedUntil: null,
        snoozedAt: null,
      })),
      "snooze",
    ),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
    // Shown at once, so a composer that releases its accepted pick keeps showing it.
    setModelSelection: optimistic.wrap(commands.setModelSelection, (thread, input) => ({
      ...thread,
      modelSelection: input.modelSelection,
    })),
  };
}
