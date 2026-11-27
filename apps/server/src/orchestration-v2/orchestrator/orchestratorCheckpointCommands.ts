import {
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  repositoryRewindCheckpoint,
} from "@zerocode/contracts";
import { orchestrationV2WorktreePending } from "@zerocode/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "../CheckpointRestoreSafety.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { forkableSourceRunStatusError, isForkableSourceRunStatus } from "../ThreadForkService.ts";
import {
  contextSourcePointForRun,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderAdapterError,
  OrchestratorThreadAlreadyExistsError,
  providerThreadForRun,
  providerTurnForRun,
  type OrchestratorShared,
} from "./orchestratorShared.ts";

function latestStableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | null {
  return (
    projection.runs
      .filter((run) => run.status === "completed" && run.checkpointId !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

function runForSourcePoint(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "checkpoints">,
  sourcePoint: Extract<
    OrchestrationV2Command,
    { readonly type: "thread.fork" | "thread.merge_back" }
  >["sourcePoint"],
): OrchestrationV2Run | null {
  switch (sourcePoint.type) {
    case "latest_stable":
      return latestStableRun(projection);
    case "run":
      return projection.runs.find((run) => run.id === sourcePoint.runId) ?? null;
    case "checkpoint": {
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === sourcePoint.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? null
        : (projection.runs.find((run) => run.id === checkpoint.runId) ?? null);
    }
  }
}

export function makeCheckpointCommands(shared: OrchestratorShared) {
  const {
    commandPolicy,
    fileSystem,
    idAllocator,
    path,
    projects,
    projectionStore,
    providerAdapters,
    taskFolderStore,
    threadForkService,
    emit,
    findThread,
    loadProjectionForCommand,
    mapDispatchError,
    refuseAboveDispatchModeLimit,
  } = shared;

  const dispatchThreadFork = Effect.fn("orchestrationV2.dispatch.threadFork")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadRecords(command.sourceThreadId, [
        "runs",
        ...(command.sourcePoint.type === "checkpoint" ? (["checkpoints"] as const) : []),
        "providerThreads",
        "providerTurns",
        "attempts",
      ])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );
    // Read under the source's lock; validate the modes copied here, not an earlier read.
    yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);
    if (sourceProjection.thread.deletedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} was deleted.`,
      });
    }
    // The fork would copy no worktree path and run in the project checkout.
    if (
      command.sideChat === true &&
      orchestrationV2WorktreePending(sourceProjection.thread.worktreePath, sourceProjection.runs)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} has no worktree yet. Start the side chat once its worktree is set up.`,
      });
    }
    if ((yield* findThread(command.targetThreadId)) !== null) {
      return yield* new OrchestratorThreadAlreadyExistsError({
        commandId: command.commandId,
        threadId: command.targetThreadId,
      });
    }

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);

    // A side chat may open during the parent's first turn; it starts from a digest instead.
    if (
      sourceRun === null &&
      !(command.sideChat === true && command.sourcePoint.type === "latest_stable")
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for fork source ${command.sourcePoint.type}.`,
      });
    }
    if (sourceRun !== null && !isForkableSourceRunStatus(sourceRun.status)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: forkableSourceRunStatusError(sourceRun),
      });
    }
    const sourceProviderThread =
      sourceRun === null ? undefined : providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: sourceProjection.thread.id,
        targetThreadId: command.targetThreadId,
        type: "fork",
      }),
    );
    const { targetThread, transfer } = yield* threadForkService
      .plan({
        sourceProjection,
        sourceRun,
        sourceProviderThread,
        sourceTokenUsage:
          sourceRun === null
            ? undefined
            : providerTurnForRun(sourceProjection, sourceRun)?.tokenUsage,
        canonicalSourcePoint:
          sourceRun === null
            ? { threadId: sourceProjection.thread.id }
            : contextSourcePointForRun(sourceProjection, sourceRun),
        transferId,
        targetThreadId: command.targetThreadId,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.sideChat ? { sideChat: true } : {}),
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        createdAt: now,
      })
      .pipe(mapDispatchError(command));

    yield* emitEvent({
      type: "thread.created",
      threadId: command.targetThreadId,
      providerInstanceId: targetThread.providerInstanceId,
      occurredAt: now,
      payload: targetThread,
    });
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: transfer.sourceProviderInstanceId ?? targetThread.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const dispatchThreadMergeBack = Effect.fn("orchestrationV2.dispatch.threadMergeBack")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.merge_back" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadRecords(command.sourceThreadId, [
        "runs",
        "checkpoints",
        "providerThreads",
        "providerTurns",
        "attempts",
        "contextTransfers",
      ])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );
    // The source is unlocked; validate the modes copied here, not an earlier read.
    yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);
    const targetProjection = yield* projectionStore
      .getThreadRecords(command.targetThreadId, ["runs", "contextTransfers"])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.targetThreadId,
              cause,
            }),
        ),
      );

    if (
      sourceProjection.thread.lineage.relationshipToParent !== "fork" ||
      sourceProjection.thread.lineage.parentThreadId !== command.targetThreadId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} is not a fork of ${command.targetThreadId}.`,
      });
    }
    if (sourceProjection.thread.deletedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} was deleted.`,
      });
    }
    if (targetProjection.thread.deletedAt !== null || targetProjection.thread.archivedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.targetThreadId} is archived or deleted.`,
      });
    }
    // Queued runs cannot consume merge-back context. Refuse under the target's
    // command lock before a pending transfer can block its ordinary messages.
    if (targetProjection.runs.some((run) => isActiveRun(run) || run.status === "queued")) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause:
          "Finish or stop the target thread's active work and clear its queue before merging back.",
      });
    }
    const otherPendingMergeBack = targetProjection.contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.status === "pending" &&
        transfer.targetThreadId === command.targetThreadId &&
        transfer.sourceThreadId !== command.sourceThreadId,
    );
    if (otherPendingMergeBack) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.targetThreadId} already has pending context from another side chat or fork. Send a message there first.`,
      });
    }

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);
    if (sourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for merge-back source ${command.sourcePoint.type}.`,
      });
    }
    if (sourceRun.status !== "completed" && sourceRun.status !== "waiting") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Merge-back source run ${sourceRun.id} is ${sourceRun.status}; only provider-finished runs are supported.`,
      });
    }

    const forkTransfer = sourceProjection.contextTransfers.findLast(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.sourceThreadId === command.targetThreadId &&
        transfer.targetThreadId === command.sourceThreadId,
    );
    if (forkTransfer === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No fork transfer exists between ${command.targetThreadId} and ${command.sourceThreadId}.`,
      });
    }

    const sourceProviderThread = providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: command.sourceThreadId,
        targetThreadId: command.targetThreadId,
        type: "merge_back",
      }),
    );
    const pendingMergeBackTransfersForPair = targetProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.status === "pending" &&
        transfer.sourceThreadId === command.sourceThreadId &&
        transfer.targetThreadId === command.targetThreadId,
    );
    const transfer: OrchestrationV2ContextTransfer = {
      id: transferId,
      type: "merge_back",
      sourceThreadId: command.sourceThreadId,
      targetThreadId: command.targetThreadId,
      sourcePoint: contextSourcePointForRun(sourceProjection, sourceRun),
      basePoint: forkTransfer.sourcePoint,
      sourceProviderInstanceId: sourceRun.providerInstanceId,
      targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
      targetRunId: null,
      status: "pending",
      resolution: null,
      createdBy: command.createdBy,
      error:
        sourceProviderThread === undefined ? "Source merge-back run has no provider thread." : null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
    };

    for (const pendingTransfer of pendingMergeBackTransfersForPair) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.targetThreadId,
        providerInstanceId: sourceRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...pendingTransfer,
          status: "superseded",
          error: `Superseded by merge-back transfer ${transferId}.`,
          updatedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: sourceRun.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const dispatchCheckpointRollback = Effect.fn("Orchestrator.dispatchCheckpointRollback")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const projection = yield* loadProjectionForCommand(
        command,
        ["providerThreads", "checkpoints", "checkpointScopes", "runs", "providerTurns", "attempts"],
        { turnItemTypes: [], messageRoles: ["user"] },
      );
      if (projection.thread.deletedAt !== null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} is deleted.`,
        });
      }
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      if (providerThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "No active provider thread exists for rollback.",
        });
      }
      if (providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider thread ${providerThread.id} has no provider session.`,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const capabilities = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.flatMap((adapter) => adapter.getCapabilities()),
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      yield* mapDispatchError(command)(
        commandPolicy.ensureRollback({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
        }),
      );

      const targetCheckpoint = projection.checkpoints.find(
        (candidate) => candidate.id === command.checkpointId,
      );
      if (targetCheckpoint === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} was not found.`,
        });
      }
      const worktreePath = projection.thread.worktreePath;
      const taskFolder =
        command.restoreFiles === false || worktreePath === null
          ? null
          : yield* taskFolderStore.findContaining(worktreePath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
      // A task folder's linked project folder has no snapshot; its repositories can still restore.
      const restoresRepositories =
        taskFolder !== null &&
        !taskFolder.projectIsWorktree &&
        projection.checkpointScopes.some(
          (scope) =>
            typeof scope.repositoryPath === "string" &&
            repositoryRewindCheckpoint(
              projection.checkpoints.filter((candidate) => candidate.scopeId === scope.id),
              targetCheckpoint.appRunOrdinal ?? 0,
            ) !== null,
        );
      // Missing or failed snapshots otherwise support conversation rewind only.
      if (
        targetCheckpoint.status !== "ready" &&
        !(targetCheckpoint.status === "error" && command.restoreFiles === false) &&
        !(
          targetCheckpoint.status === "missing" &&
          (command.restoreFiles === false || restoresRepositories)
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} is ${targetCheckpoint.status} and cannot be restored.`,
        });
      }
      const targetScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === targetCheckpoint.scopeId,
      );
      if (targetScope === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint scope ${targetCheckpoint.scopeId} was not found.`,
        });
      }
      if (targetScope.id !== command.scopeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} belongs to scope ${targetScope.id}, not ${command.scopeId}.`,
        });
      }
      // A repository's checkpoints follow the thread's; they are not a place to rewind to.
      if (typeof targetScope.repositoryPath === "string") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} belongs to a tracked repository; roll back to the thread's own checkpoint instead.`,
        });
      }
      if (command.restoreFiles !== false) {
        const isolated = yield* isCheckpointRestoreIsolated(
          projection.thread,
          targetScope,
          taskFolder,
          {
            projects,
            path,
            fileSystem,
            projections: projectionStore,
          },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );
        if (!isolated)
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: SHARED_WORKSPACE_RESTORE_MESSAGE,
          });
      }

      const targetOrdinal = targetCheckpoint.appRunOrdinal ?? 0;
      if (targetOrdinal > 0) {
        const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
        const targetProviderTurn =
          targetRun === undefined ? undefined : providerTurnForRun(projection, targetRun);
        if (
          targetRun === undefined ||
          targetRun.status === "rolled_back" ||
          targetProviderTurn === undefined
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back to checkpoint ${targetCheckpoint.id}: its provider turn is unavailable.`,
          });
        }
        if (targetProviderTurn.providerThreadId !== providerThread.id) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back provider thread ${providerThread.id} to checkpoint ${targetCheckpoint.id}: target provider turn ${targetProviderTurn.id} belongs to provider thread ${targetProviderTurn.providerThreadId}.`,
          });
        }
      }

      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: projection.thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          rollbackRequestId: command.commandId,
          rollbackFailure: null,
          rollbackUnrestored: null,
          updatedAt: now,
        },
      });
      yield* emit(
        events,
        command,
      )({
        type: "checkpoint.rollback-requested",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          scopeId: targetScope.id,
          checkpointId: targetCheckpoint.id,
          requestedAt: now,
        },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-thread.rollback:${providerThread.id}:${targetCheckpoint.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-thread.rollback",
            ...(command.restoreFiles === undefined ? {} : { restoreFiles: command.restoreFiles }),
            providerThreadId: providerThread.id,
            checkpointId: targetCheckpoint.id,
            scopeId: targetScope.id,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    },
  );

  const dispatchCheckpointRollbackFail = Effect.fn("Orchestrator.dispatchCheckpointRollbackFail")(
    function* (
      command: Extract<
        OrchestrationV2InternalCommand,
        { readonly type: "checkpoint.rollback.fail" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(mapDispatchError(command));
      if (thread.deletedAt !== null) return;
      if (thread.rollbackRequestId !== command.requestId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Rollback ${command.requestId} is no longer the thread's current rollback.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...thread,
          rollbackFailure: { requestId: command.requestId, message: command.message },
          updatedAt: now,
        },
      });
    },
  );

  return {
    dispatchThreadFork,
    dispatchThreadMergeBack,
    dispatchCheckpointRollback,
    dispatchCheckpointRollbackFail,
  };
}
