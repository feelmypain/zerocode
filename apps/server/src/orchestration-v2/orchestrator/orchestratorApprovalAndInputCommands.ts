import {
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  resolveProjectProviderInstanceEnabled,
  type ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@zerocode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { isActiveRun } from "../CommandPolicy.ts";
import { DispatchModeLimit } from "../DispatchModeLimit.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import {
  type CancelUnsettledEffects,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  type OrchestratorShared,
  type OrchestratorV2Error,
  providerTurnForRun,
} from "./orchestratorShared.ts";

const isMessageQuestionAnswer = Schema.is(
  Schema.Union([TrimmedNonEmptyString, Schema.NonEmptyArray(TrimmedNonEmptyString)]),
);

// Validate before resolving the request: adapters may otherwise coerce unusable answers.
const decodeUserInputAnswers = Schema.decodeUnknownEffect(
  Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.String),
      Schema.Struct({ answers: Schema.Array(Schema.String) }),
    ]),
  ),
);

const RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE =
  "ZeroCode could not confirm that your answer reached the agent. If the run stays stuck, stop it and try again.";

function askedForLinkedMachine(
  card: Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>,
  linked: Extract<OrchestrationV2InternalCommand, { readonly type: "link_request.record" }>,
): boolean {
  if (card.requestedAccess !== linked.requestedAccess) return false;
  if (card.environmentId !== undefined) return card.environmentId === linked.linkedEnvironmentId;
  if (card.url !== undefined) return linked.url !== undefined && card.url === linked.url;
  const normalize = (text: string | undefined) => text?.trim().toLowerCase() ?? "";
  const hint = normalize(card.hint);
  return hint !== "" && hint === normalize(linked.hint) && hint === normalize(linked.linkedLabel);
}

interface ApprovalAndInputCommandCallbacks {
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<CancelUnsettledEffects | undefined, OrchestratorV2Error>;
  readonly recordSubagentFollowup: (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<void, OrchestratorV2Error>;
}

export function makeApprovalAndInputCommands(
  shared: OrchestratorShared,
  callbacks: ApprovalAndInputCommandCallbacks,
) {
  const {
    idAllocator,
    projectionStore,
    providerSessions,
    serverSettings,
    emit,
    mapDispatchError,
    nextTurnItemOrdinal,
    refuseAboveDispatchModeLimit,
    stopReachedRun,
    turnStartedModes,
  } = shared;

  const dispatchSecretRequestRecord = Effect.fn("orchestrationV2.dispatch.secretRequestRecord")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { readonly type: "secret_request.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const projection = yield* projectionStore
        .getRunCardRecords(command.threadId, command.runId, command.nodeId, "secret_request")
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      if (run === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} was not found.`,
        });
      }
      const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
      // Only a new card needs its run's current root. A steer restarts the run
      // under a new root, and the card asked before it must still close.
      if (existing === undefined && run.rootNodeId !== command.nodeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
        });
      }
      if (existing !== undefined && existing.type !== "secret_request") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Turn item ${command.turnItemId} is not a secret request.`,
        });
      }
      if (existing !== undefined && existing.runId !== command.runId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Secret request ${command.turnItemId} belongs to another run.`,
        });
      }
      const nodeId = existing?.nodeId ?? command.nodeId;
      const now = yield* DateTime.now;
      const unchanged =
        existing !== undefined &&
        (existing.secretStatus !== "pending" || command.secretStatus === "pending");
      const pending = command.secretStatus === "pending";
      const turnItem: OrchestrationV2TurnItem = unchanged
        ? existing
        : {
            id: command.turnItemId,
            threadId: command.threadId,
            runId: command.runId,
            nodeId,
            // An update keeps where the card was asked, even after a restart.
            ...(existing === undefined
              ? {
                  providerThreadId: run.providerThreadId,
                  providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
                }
              : {
                  providerThreadId: existing.providerThreadId,
                  providerTurnId: existing.providerTurnId,
                }),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: existing?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
            status: pending
              ? "waiting"
              : command.secretStatus === "saved"
                ? "completed"
                : "cancelled",
            title: command.label,
            startedAt: existing?.startedAt ?? now,
            completedAt: pending ? null : now,
            updatedAt: now,
            type: "secret_request",
            label: command.label,
            reason: command.reason,
            ...(command.url === undefined ? {} : { url: command.url }),
            ...(command.placeholder === undefined ? {} : { placeholder: command.placeholder }),
            ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
            ...(command.fields === undefined ? {} : { fields: command.fields }),
            secretStatus: command.secretStatus,
          };
      if (
        !unchanged &&
        command.secretStatus === "saved" &&
        projection.thread.snoozedUntil != null
      ) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.unsnoozed",
          threadId: command.threadId,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: { ...projection.thread, snoozedUntil: null, snoozedAt: null, updatedAt: now },
        });
      }
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: command.runId,
        nodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  /**
   * Records or updates the card for a link an agent asked the user to make.
   * The pairing code goes straight to the link and never through orchestration.
   */
  const dispatchLinkRequestRecord = Effect.fn("orchestrationV2.dispatch.linkRequestRecord")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { readonly type: "link_request.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const projection = yield* projectionStore
        .getRunCardRecords(command.threadId, command.runId, command.nodeId, "link_request")
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      if (run === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} was not found.`,
        });
      }
      const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
      if (existing !== undefined && existing.type !== "link_request") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Turn item ${command.turnItemId} is not a link request.`,
        });
      }
      if (existing !== undefined && existing.runId !== command.runId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Link request ${command.turnItemId} belongs to another run.`,
        });
      }
      // Only a new card needs its run's current root and a live run. An answer
      // may land long after a steer restarted the run or the run ended, and the
      // link it reports is already made.
      if (existing === undefined && run.rootNodeId !== command.nodeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
        });
      }
      if (
        existing === undefined &&
        (!isActiveRun(run) || (yield* stopReachedRun(command, command.threadId, run.id)))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not active.`,
        });
      }
      const nodeId = existing?.nodeId ?? command.nodeId;
      const now = yield* DateTime.now;
      // A request is answered once, and a retry finds its card as it was
      // asked: either one records the card unchanged.
      const unchanged =
        existing !== undefined &&
        (existing.linkStatus !== "pending" || command.linkStatus === "pending");
      const pending = command.linkStatus === "pending";
      const {
        type: _type,
        commandId: _commandId,
        turnItemId: _turnItemId,
        answeringTurnItemIds,
        wake,
        ...fields
      } = command;
      const turnItem: OrchestrationV2TurnItem = unchanged
        ? existing
        : {
            ...fields,
            id: command.turnItemId,
            // An update keeps where the card was asked, even after a restart.
            ...(existing === undefined
              ? {
                  providerThreadId: run.providerThreadId,
                  providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
                }
              : {
                  nodeId: existing.nodeId,
                  providerThreadId: existing.providerThreadId,
                  providerTurnId: existing.providerTurnId,
                }),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: existing?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
            status: pending
              ? "waiting"
              : command.linkStatus === "linked"
                ? "completed"
                : command.linkStatus === "failed"
                  ? "failed"
                  : "cancelled",
            title: command.label ?? command.url ?? "Link an environment",
            startedAt: existing?.startedAt ?? now,
            completedAt: pending ? null : now,
            updatedAt: now,
            type: "link_request",
          };
      if (!unchanged && command.linkStatus === "linked" && projection.thread.snoozedUntil != null) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.unsnoozed",
          threadId: command.threadId,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: { ...projection.thread, snoozedUntil: null, snoozedAt: null, updatedAt: now },
        });
      }
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: command.runId,
        nodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
      // The link answers the older cards that asked for the same machine and
      // access. They end without waking anyone: the agent hears this link.
      // A card still being answered stays open for its own answer to end.
      if (!unchanged && command.linkStatus === "linked") {
        for (const item of projection.turnItems) {
          if (
            item.type !== "link_request" ||
            item.linkStatus !== "pending" ||
            item.ordinal >= turnItem.ordinal ||
            answeringTurnItemIds?.includes(item.id) === true ||
            !askedForLinkedMachine(item, command)
          ) {
            continue;
          }
          yield* emit(
            events,
            command,
          )({
            type: "turn-item.updated",
            threadId: command.threadId,
            ...(item.runId === null ? {} : { runId: item.runId }),
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            occurredAt: now,
            payload: {
              ...item,
              status: "cancelled",
              linkStatus: "cancelled",
              completedAt: now,
              updatedAt: now,
            },
          });
        }
      }
      // The agent asked without waiting, so the answer reaches it as a
      // notification: it starts a turn, or follows the one running. Only the
      // answer that closes the card wakes it, and never a closed thread.
      if (
        wake === undefined ||
        unchanged ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null
      ) {
        return;
      }
      yield* callbacks.dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: wake.messageId,
          text: wake.text,
          notification: wake.notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        },
        events,
        effects,
      );
    },
  );

  /**
   * Closes the link cards still waiting for the user. Their agent stopped
   * waiting long ago, so nobody is woken: stopping, settling or archiving the
   * thread means the user is done with it.
   */
  const closePendingLinkRequests = Effect.fn("orchestrationV2.closePendingLinkRequests")(
    function* (input: {
      readonly command: OrchestrationV2ServerCommand;
      readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
      readonly threadId: ThreadId;
      readonly now: DateTime.Utc;
    }) {
      const { turnItems } = yield* projectionStore
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["link_request"],
          turnItemStatuses: ["waiting"],
          messageRoles: [],
        })
        .pipe(mapDispatchError(input.command));
      for (const item of turnItems) {
        if (item.type !== "link_request" || item.linkStatus !== "pending") continue;
        yield* emit(
          input.events,
          input.command,
        )({
          type: "turn-item.updated",
          threadId: input.threadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          occurredAt: input.now,
          payload: {
            ...item,
            status: "cancelled",
            linkStatus: "cancelled",
            completedAt: input.now,
            updatedAt: input.now,
          },
        });
      }
    },
  );

  const dispatchRuntimeRequestRespond = Effect.fn("Orchestrator.dispatchRuntimeRequestRespond")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const context = yield* projectionStore
        .getRuntimeResponseContext(command.threadId, command.requestId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const runtimeRequest = context.request;
      if (runtimeRequest === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} was not found.`,
        });
      }
      if (runtimeRequest.status !== "pending") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
        });
      }
      if (runtimeRequest.responseCapability.type === "not_resumable") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: runtimeRequest.responseCapability.reason,
        });
      }
      if (
        command.feedback !== undefined &&
        (runtimeRequest.responseCapability.type !== "live" ||
          !runtimeRequest.responseCapability.supportsFeedback ||
          runtimeRequest.kind === "user_input" ||
          command.decision !== "decline" ||
          !command.feedback.trim())
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Feedback requires a live approval that supports it and a decline decision.",
        });
      }
      const providerSessionId =
        runtimeRequest.responseCapability.type === "live"
          ? runtimeRequest.responseCapability.providerSessionId
          : null;
      if (providerSessionId !== null && (yield* DispatchModeLimit) !== undefined) {
        // The answer goes into the turn that asked, which keeps the modes it started with.
        const live = yield* projectionStore
          .getThreadRecords(command.threadId, ["runs", "attempts"])
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        yield* refuseAboveDispatchModeLimit(
          command,
          command.threadId,
          turnStartedModes(
            live.attempts,
            live.runs.find((run) => run.id === context.node?.runId),
          ),
        );
      }
      const providerSession = context.session;
      if (providerSessionId !== null && providerSession === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider session ${providerSessionId} was not found.`,
        });
      }
      let answers = command.answers;
      if (runtimeRequest.kind === "user_input" && answers !== undefined) {
        const decoded = yield* decodeUserInputAnswers(answers).pipe(mapDispatchError(command));
        answers = Object.fromEntries(
          Object.entries(decoded).map(([questionId, answer]) => [
            questionId,
            typeof answer === "object" && "answers" in answer ? answer.answers : answer,
          ]),
        );
      }

      const approvalTurnItem = context.item;
      const resolvedNodeStatus =
        command.decision === "decline" || command.decision === "cancel"
          ? ("cancelled" as const)
          : ("completed" as const);
      const replies: string[] = [];
      if (
        runtimeRequest.responseCapability.type === "message" &&
        resolvedNodeStatus !== "cancelled"
      ) {
        if (approvalTurnItem?.type !== "user_input_request") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "The question for this request was not found.",
          });
        }
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(mapDispatchError(command));
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        if (
          !resolveProjectProviderInstanceEnabled(
            settings,
            thread.projectId,
            thread.providerInstanceId,
          )
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "The provider for this project is disabled.",
          });
        }
        const questionIds = new Set(approvalTurnItem.questions.map((question) => question.id));
        if (
          !Object.entries(answers ?? {}).every(
            ([questionId, answer]) =>
              questionIds.has(questionId) || isMessageQuestionAnswer(answer),
          )
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Answer each question before sending.",
          });
        }
        for (const question of approvalTurnItem.questions) {
          const answer = answers?.[question.id];
          if (
            question.multiSelect === true &&
            question.required !== true &&
            Array.isArray(answer) &&
            answer.length === 0
          ) {
            replies.push(`${question.question}\nNone selected`);
            continue;
          }
          const answered = isMessageQuestionAnswer(answer);
          // Clients send "" for a skipped optional question or an attachment-only answer.
          if (!answered && !command.attachmentsByQuestionId?.[question.id]?.length) {
            if (question.required === false) continue;
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Answer each question before sending.",
            });
          }
          if (!answered) {
            replies.push(question.question);
            continue;
          }
          const text = typeof answer === "string" ? answer : answer.join(", ");
          replies.push(`${question.question}\n${text.trim()}`);
        }
        if (replies.length === 0) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Enter an answer before sending.",
          });
        }
      }

      const now = yield* DateTime.now;
      const resolvedRequest = {
        ...runtimeRequest,
        status: "resolved" as const,
        resolvedAt: now,
        ...(command.decision === undefined ? {} : { decision: command.decision }),
        ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
        ...(answers === undefined ? {} : { answers }),
      };
      const emitEvent = emit(events, command);
      const requestNode = context.node;
      if (command.feedback !== undefined) {
        const messageId = MessageId.make(`approval-feedback:${command.requestId}`);
        // Record the reply for every client without dispatching a prompt to the parent agent.
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
          nodeId: runtimeRequest.nodeId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId: command.threadId,
            runId: requestNode?.runId ?? null,
            nodeId: runtimeRequest.nodeId,
            role: "user",
            text: command.feedback,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
          nodeId: runtimeRequest.nodeId,
          occurredAt: now,
          payload: {
            id: idAllocator.derive.userTurnItem({ messageId }),
            threadId: command.threadId,
            runId: requestNode?.runId ?? null,
            nodeId: runtimeRequest.nodeId,
            providerThreadId:
              context.item?.providerThreadId ?? requestNode?.providerThreadId ?? null,
            providerTurnId: runtimeRequest.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: yield* projectionStore
              .getNextTurnItemOrdinal(command.threadId)
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
                ),
              ),
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId,
            inputIntent: "steer",
            text: command.feedback,
            attachments: [],
            createdBy: "user",
            creationSource: "server",
          },
        });
      }
      yield* emitEvent({
        type: "runtime-request.updated",
        threadId: command.threadId,
        ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
        nodeId: runtimeRequest.nodeId,
        ...(providerSession === undefined
          ? {}
          : {
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
            }),
        occurredAt: now,
        payload: resolvedRequest,
      });
      if (requestNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
          nodeId: requestNode.id,
          ...(providerSession === undefined
            ? {}
            : {
                driver: providerSession.driver,
                providerInstanceId: providerSession.providerInstanceId,
              }),
          occurredAt: now,
          payload: {
            ...requestNode,
            status: resolvedNodeStatus,
            completedAt: now,
          },
        });
      }

      if (approvalTurnItem !== undefined) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          ...(approvalTurnItem.runId === null ? {} : { runId: approvalTurnItem.runId }),
          ...(approvalTurnItem.nodeId === null ? {} : { nodeId: approvalTurnItem.nodeId }),
          ...(providerSession === undefined
            ? {}
            : {
                driver: providerSession.driver,
                providerInstanceId: providerSession.providerInstanceId,
              }),
          occurredAt: now,
          payload: {
            ...approvalTurnItem,
            ...(approvalTurnItem.type === "user_input_request" && answers !== undefined
              ? {
                  questionAnswer: {
                    requestId: command.requestId,
                    answers,
                    attachmentsByQuestionId: command.attachmentsByQuestionId ?? {},
                    questionTextById: Object.fromEntries(
                      approvalTurnItem.questions.map((question) => [
                        question.id,
                        question.question,
                      ]),
                    ),
                  },
                }
              : {}),
            status: resolvedNodeStatus,
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      if (runtimeRequest.responseCapability.type === "message") {
        if (resolvedNodeStatus === "cancelled") return;
        let dispatchMode: Extract<
          OrchestrationV2Command,
          { type: "message.dispatch" }
        >["dispatchMode"] = {
          type: "queue_after_active",
        };
        const {
          run: activeRun,
          providerThread: activeProviderThread,
          providerTurn: activeProviderTurn,
        } = yield* projectionStore
          .getRunningTurnContext(command.threadId)
          .pipe(mapDispatchError(command));
        if (activeRun && activeProviderTurn && activeProviderThread?.providerSessionId) {
          const activeSession = yield* providerSessions
            .get(activeProviderThread.providerSessionId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          if (
            Option.isSome(activeSession) &&
            activeSession.value.providerSession.capabilities.turns.supportsActiveSteering
          ) {
            dispatchMode = { type: "steer_active", targetRunId: activeRun.id };
          }
        }
        const answer = {
          type: "message.dispatch" as const,
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: MessageId.make(`async-answer:${command.requestId}`),
          text: replies.join("\n\n"),
          attachments: Object.values(command.attachmentsByQuestionId ?? {}).flat(),
          createdBy: "user" as const,
          creationSource: "server" as const,
          dispatchMode,
        };
        yield* callbacks.dispatchMessage(answer, events, effects);
        return yield* callbacks.recordSubagentFollowup(answer, events);
      }
      if (providerSessionId === null) return;
      if (runtimeRequest.kind === "user_input" && resolvedNodeStatus === "completed") {
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(mapDispatchError(command));
        if (thread.snoozedUntil != null) {
          yield* emitEvent({
            type: "thread.unsnoozed",
            threadId: command.threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: { ...thread, snoozedUntil: null, snoozedAt: null, updatedAt: now },
          });
        }
      }
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:runtime-request.respond:${command.requestId}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "runtime-request.respond",
            providerSessionId,
            requestId: command.requestId,
            ...(command.decision === undefined ? {} : { decision: command.decision }),
            ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
            ...(answers === undefined ? {} : { answers }),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    },
  );

  /**
   * Respond resolves the request before delivery, and a failed delivery cannot
   * tell whether the provider is still waiting, so the answer stays recorded and
   * the timeline shows the failure instead of a run spinning with no question.
   */
  const dispatchRuntimeRequestDeliveryFail = Effect.fn(
    "Orchestrator.dispatchRuntimeRequestDeliveryFail",
  )(function* (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "runtime-request.delivery.fail" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(mapDispatchError(command));
    if (thread.deletedAt !== null) return;
    const node = (yield* projectionStore
      .getRuntimeResponseContext(command.threadId, command.requestId)
      .pipe(mapDispatchError(command))).node;
    if (node === undefined) return;
    const now = yield* DateTime.now;
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      ...(node.runId === null ? {} : { runId: node.runId }),
      nodeId: node.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:runtime-request-delivery-failure:${command.requestId}`),
        threadId: command.threadId,
        runId: node.runId,
        nodeId: node.id,
        providerThreadId: node.providerThreadId,
        providerTurnId: node.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal({ thread }),
        status: "failed",
        title: "Answer delivery not confirmed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error",
        failure: {
          class: "transport_error",
          message: RUNTIME_REQUEST_DELIVERY_FAILED_MESSAGE,
          code: null,
          retryable: null,
        },
      },
    });
  });

  const dispatchThreadUserInputDismiss = Effect.fn("Orchestrator.dispatchThreadUserInputDismiss")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.user-input.dismiss" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const request = yield* projectionStore
        .getRuntimeRequest(command.threadId, command.requestId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (request === undefined || request.status !== "pending") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This question has already been answered.",
        });
      }
      if (request.kind !== "user_input" || request.responseCapability.type !== "message") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      yield* dispatchRuntimeRequestRespond(
        {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: command.requestId,
          decision: "cancel",
        },
        events,
        effects,
      );
    },
  );

  return {
    dispatchSecretRequestRecord,
    dispatchLinkRequestRecord,
    closePendingLinkRequests,
    dispatchRuntimeRequestRespond,
    dispatchRuntimeRequestDeliveryFail,
    dispatchThreadUserInputDismiss,
  };
}
