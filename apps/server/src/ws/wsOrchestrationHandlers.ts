import {
  type ApplicationStoredEvent,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
  type OrchestrationProjectShell,
  OrchestrationSearchThreadsError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2SearchThreadError,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadStreamItem,
  type ScheduledTaskListResult,
  ThreadId,
  WS_METHODS,
  WorkflowRequestError,
} from "@zerocode/contracts";
import { dedupeSnapshotBodies } from "@zerocode/shared/orchestrationV2DedupedBodies";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as NativeChildWorkQuery from "../orchestration-v2/NativeChildWorkQuery.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ShellProjectionBroadcaster from "../orchestration-v2/ShellProjectionBroadcaster.ts";
import {
  type ShellApplicationEvent,
  bufferShellLiveStream,
  canResumeShellFrom,
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadOlderSettledThreadsPage,
  loadShellSnapshotParts,
  loadSubscriberShellSnapshot,
  resumeIdentityRoots,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
} from "../orchestration-v2/ShellStream.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  buildBoundedThreadProjection,
} from "../orchestration-v2/threadHistoryPaging.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
} from "../orchestration-v2/ThreadLiveEventCoalescer.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import {
  THREAD_RESUME_MAX_REPLAY_EVENTS,
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
} from "../orchestration-v2/ThreadStream.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import {
  makeLiveBodyDeduper,
  makeLiveTextDeltaEncoder,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
  threadStreamEventItem,
} from "../orchestration-v2/WireProjection.ts";
import { readWorkflowScript } from "../orchestration-v2/workflowScriptQuery.ts";
import * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerThreadRelay from "../peer/PeerThreadRelay.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { OrchestrationWsRpcGroup } from "./wsRpcShared.ts";

function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
  readonly acceptDeferredWork?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
  (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    Effect.flatMap(ProjectEnrichmentService.ProjectEnrichmentService, (projectEnrichment) =>
      Effect.forEach(
        projects,
        (project) =>
          projectEnrichment.getAvailable(project.workspaceRoot).pipe(
            Effect.map((enrichment) => ({
              project: {
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              },
              repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
            })),
          ),
        { concurrency: 16 },
      ).pipe(
        Effect.map((enriched) => ({
          projects: enriched.map((entry) => entry.project),
          resolvedRepositoryIdentityRoots: enriched
            .filter((entry) => entry.repositoryIdentityResolved)
            .map((entry) => entry.project.workspaceRoot),
        })),
      ),
    ),
);

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
    readonly acceptDeferredWork?: boolean;
    readonly acceptCompactTurnItems?: boolean;
    readonly acceptDedupedBodies?: boolean;
    readonly acceptCompactIds?: boolean;
    readonly acceptTextDeltas?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const dedupeBodies = input.acceptDedupedBodies === true;
    const emitTextDeltas = input.acceptTextDeltas === true;
    // Replay, snapshot, and live tail share one deduper and delta encoder: both must see every delivered record.
    // Body dedupe runs before text deltas so assistant_message turn items still match full message text.
    const withLiveDedupe = <E, R>(stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>) => {
      const deduped = dedupeBodies
        ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper()))
        : stream;
      return emitTextDeltas
        ? Stream.suspend(() => Stream.map(deduped, makeLiveTextDeltaEncoder()))
        : deduped;
    };
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map(threadStreamEventItem),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
          // Downgrades can leave unknown rows; skip them and resume live from highWater so later events survive.
          skipUnknownEventTypes: true,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              deferWork: input.acceptDeferredWork === true,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: input.acceptCompactTurnItems === true,
            dedupeBodies,
            compactIds: input.acceptCompactIds === true,
          })
        : (() => {
            const projection = projectThreadProjectionForWire(snapshot.projection);
            return {
              kind: "snapshot" as const,
              snapshotSequence,
              projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
            };
          })();
      return rpcInitialItems([snapshotItem]).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(snapshotSequence)),
        withLiveDedupe,
      );
    });

    // Subscribe before reading persisted events to retain concurrent publishes; clients dedupe overlap by sequence.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      const prunedThrough = yield* applicationEvents.prunedThroughSequence.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      // An idle thread's cursor sits at its own high-water: nothing was missed, so replay nothing.
      if (
        input.afterSequence > highWater ||
        (input.afterSequence < highWater && input.afterSequence < prunedThrough)
      ) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored and projected payload bytes separately; neither bounds process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // Retained creation events may describe deleted threads; replace replay only if a snapshot exists.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replayed = yield* loadReplayThrough(input.afterSequence, highWater);
      // Pruning publishes its boundary before deleting, so a pass during the read shows up here.
      if (
        input.afterSequence < highWater &&
        input.afterSequence <
          (yield* applicationEvents.prunedThroughSequence.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
                  cause,
                }),
            ),
          ))
      ) {
        return yield* snapshotThenLive();
      }
      // A deleted thread reads as gone: its replay starts at the deletion.
      const deletion = replayed.findLastIndex((item) => item.event.type === "thread.deleted");
      const replay = coalesceLiveUpdatedEvents(
        deletion === -1 ? replayed : replayed.slice(deletion),
      );
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return rpcInitialItems(replay).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(highWater)),
        withLiveDedupe,
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  function* (input: {
    readonly afterSequence?: number;
    readonly httpSnapshotFallback?: true;
    readonly knownProjectIdentities?: string;
    readonly requestCompletionMarker?: boolean;
    readonly omitIdleSubagents?: boolean;
    readonly omitOlderSettled?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const shellBroadcaster = yield* Effect.serviceOption(
      ShellProjectionBroadcaster.ShellProjectionBroadcaster,
    );
    let subagentThreadIds = new Set<string>();
    const filterSubagentTranscript = (stored: ApplicationStoredEvent) =>
      shouldPublishShellApplicationEvent(stored, subagentThreadIds);

    const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
    // Subscribe before loading snapshot or replay high-water mark so no live delta is missed.
    const sharedLive = Option.isSome(shellBroadcaster)
      ? yield* shellBroadcaster.value.subscribe.pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetShellSnapshotError({
                message: "Failed to prepare the application shell stream",
                cause,
              }),
          ),
        )
      : null;
    const loadProjectMetadataSnapshot = Effect.fn("ws.orchestrationV2.loadProjectMetadataSnapshot")(
      function* (snapshotSequence: number) {
        const enriched = yield* enrichProjectShells(yield* projects.listShells());
        return {
          snapshot: {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence,
            projects: enriched.projects,
            threads: [],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot,
          resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
        };
      },
    );
    const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
      const forSubscriber = yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex: threadManagement.listActiveShellIndex(),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: projects.listShells(),
        latestSequence: applicationEvents.latestApplicationSequence,
        options: {
          omitIdleSubagents: input.omitIdleSubagents === true,
          omitOlderSettled: input.omitOlderSettled === true,
        },
      });
      subagentThreadIds = forSubscriber.subagentThreadIds;
      const enriched = yield* enrichProjectShells(forSubscriber.snapshot.projects);
      return {
        snapshot: {
          ...forSubscriber.snapshot,
          projects: enriched.projects,
        } as OrchestrationV2ShellSnapshot,
        resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
      };
    });
    const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
      stored: Extract<ShellApplicationEvent, { readonly aggregateKind: "project" }>,
    ) {
      if (stored.type === "project.deleted") {
        return {
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        };
      }
      const project = yield* projectService.getShell(stored.aggregateId);
      return Option.match(project, {
        onNone: () => ({
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        }),
        onSome: (value) => ({
          kind: "project.updated" as const,
          sequence: stored.sequence,
          project: value,
        }),
      });
    });

    const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
      events: ReadonlyArray<ShellApplicationEvent>,
    ) {
      const coalesced = coalesceShellApplicationEvents(events);
      const threadIds = coalesced.flatMap((stored) =>
        "aggregateKind" in stored ? [] : [stored.event.threadId],
      );
      // A failed batch can't name its thread, so the scalar reads below report which one is bad.
      const batch =
        threadIds.length > 1
          ? yield* threadManagement
              .getShellSnapshot({ threadIds })
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      const batchedShells =
        batch === null
          ? null
          : new Map(
              [...batch.threads, ...batch.archivedThreads].map(
                (shell) => [shell.id, shell] as const,
              ),
            );
      return yield* Effect.forEach(
        coalesced,
        (stored) =>
          Effect.gen(function* () {
            if ("aggregateKind" in stored) {
              return yield* projectItem(stored);
            }
            const threadId = stored.event.threadId;
            const shell =
              batchedShells === null
                ? yield* threadManagement.getThreadShell(threadId)
                : (batchedShells.get(threadId) ?? null);
            return shellStreamItemFromThreadShell({ stored, shell });
          }),
        { concurrency: 8 },
      );
    });

    const toShellStream = <E, R>(stream: Stream.Stream<ShellApplicationEvent, E, R>) =>
      stream.pipe(
        Stream.groupedWithin(512, Duration.millis(50)),
        Stream.mapEffect((events) => projectShellItems(Array.from(events))),
        Stream.flatMap(Stream.fromIterable),
        skipUnchangedThreadShells,
      );

    const toShellStreamError = (cause: unknown) =>
      new OrchestrationV2GetShellSnapshotError({
        message: "Failed while streaming the application shell",
        cause,
      });

    const liveFrom = (afterSequence: number) =>
      sharedLive !== null
        ? bufferShellLiveStream(
            sharedLive.pipe(Stream.filter((item) => item.sequence > afterSequence)),
          ).pipe(Stream.mapError(toShellStreamError))
        : bufferShellLiveStream(
            toShellStream(
              applicationEvents.streamProjectedApplicationEvents({
                afterSequence,
                project: toShellApplicationEvent,
                filter: filterSubagentTranscript,
              }),
            ),
          ).pipe(Stream.mapError(toShellStreamError));

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
      Stream.mapEffect((changes) =>
        Effect.gen(function* () {
          const identities = new Map(
            Array.from(changes, (change) => [
              change.workspaceRoot,
              change.enrichment.repositoryIdentity,
            ]),
          );
          const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
          const changedProjects = (yield* projects.listShells()).flatMap((project) =>
            identities.has(project.workspaceRoot)
              ? [{ ...project, repositoryIdentity: identities.get(project.workspaceRoot) ?? null }]
              : [],
          );
          return shellStreamItemFromEnrichmentRefresh({
            snapshot: {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence,
              projects: changedProjects,
              threads: [],
              archivedThreads: [],
            } as OrchestrationV2ShellSnapshot,
            changes: Array.from(changes),
          });
        }),
      ),
    );

    // Subscribe before loading for racing enrichments; initial refresh covers pre-subscription completions and cold HTTP snapshots.
    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;
    const initialSnapshotItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    const initialEnrichmentItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromResumeSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    // Drain initial frames before merging enrichment with live events so marked refreshes cannot precede the initial frame.
    const completionThenLive = (afterSequence: number) =>
      Stream.concat(completionMarker, liveFrom(afterSequence));

    const stream = yield* Effect.gen(function* () {
      if (input.afterSequence === undefined) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const snapshotRequired: Stream.Stream<OrchestrationV2ShellStreamItem> = Stream.make({
        kind: "snapshot-required",
      });
      const fromSnapshot =
        input.httpSnapshotFallback === true
          ? Effect.succeed(snapshotRequired)
          : Effect.gen(function* () {
              const loaded = yield* loadSnapshot();
              return composeShellStreamWithEnrichment({
                initial: initialSnapshotItems(loaded),
                tail: completionThenLive(loaded.snapshot.snapshotSequence),
                enrichment: enrichmentRefreshes,
              });
            });
      const highWater = yield* applicationEvents.latestApplicationSequence;
      if (!(yield* canResumeShellFrom(applicationEvents, input.afterSequence, highWater))) {
        return yield* fromSnapshot;
      }

      subagentThreadIds = new Set(yield* threadManagement.listActiveSubagentThreadIds());

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      // Read before replying: the range is budgeted above, and a prune pass during the read
      // publishes its boundary first, so the recheck below catches deleted rows.
      const replayed = yield* applicationEvents
        .readApplicationEvents({
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          // A row a newer build wrote (e.g. after a downgrade) must not fail
          // every shell resubscribe. The live tail below resumes from
          // highWater, so a dropped row never hides later events.
          skipUnknownEventTypes: true,
        })
        .pipe(Stream.filter(filterSubagentTranscript), Stream.runCollect);
      if (
        input.afterSequence < highWater &&
        input.afterSequence < (yield* applicationEvents.prunedThroughSequence)
      ) {
        return yield* fromSnapshot;
      }
      const replay = toShellStream(Stream.fromIterable(replayed));
      return composeShellStreamWithEnrichment({
        initial: initialEnrichmentItems({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: resumeIdentityRoots({
            projects: loaded.snapshot.projects,
            resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
            knownProjectIdentities: input.knownProjectIdentities,
          }),
        }),
        tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
        enrichment: enrichmentRefreshes,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to prepare the application shell stream",
            cause,
          }),
      ),
    );

    return stream.pipe(
      dedupeShellEnrichment,
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed while streaming the application shell",
            cause,
          }),
      ),
    );
  },
);

export const makeOrchestrationHandlers = Effect.fn("ws.handlers.orchestration")(function* (
  currentSession: EnvironmentAuth.AuthenticatedSession,
) {
  const currentSessionId = currentSession.sessionId;
  const sql = yield* SqlClient.SqlClient;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const intakeContext = yield* Effect.context<
    | ThreadManagementService.ThreadManagementService
    | ThreadLaunchService.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
    | DocumentText.DocumentText
  >();
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
  const threadViewers = yield* ThreadViewers.ThreadViewers;
  const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const workflows = yield* Workflows.Workflows;
  const workflowDefinitions = yield* WorkflowRuntime.WorkflowDefinitions;
  // The service's messages are built from its own attributes, so they are safe to send.
  const toWorkflowRequestError = (error: Workflows.WorkflowError) =>
    new WorkflowRequestError({ message: error.message });
  const secretRequests = yield* SecretRequests.SecretRequests;
  const guestShares = yield* GuestShareService.GuestShareService;
  const shellBroadcaster = yield* Effect.serviceOption(
    ShellProjectionBroadcaster.ShellProjectionBroadcaster,
  );
  const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const nativeChildWork = yield* NativeChildWorkQuery.NativeChildWorkQuery;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
  const peerThreadRelay = yield* PeerThreadRelay.PeerThreadRelay;
  const peerClientPairing = yield* PeerClientPairing.PeerClientPairing;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

  // Webhook URLs start agents; expose them only to operate-scoped sessions while keeping tasks readable.
  const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
    currentSession.scopes.includes(AuthOrchestrationOperateScope)
      ? result
      : {
          ...result,
          tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task),
        };

  const getOrchestrationV2ArchivedShellSnapshot = Effect.gen(function* () {
    const { threads, projects, snapshotSequence } = yield* loadShellSnapshotParts({
      sql,
      readThreads: threadManagement.readShellSnapshot({ location: "archive" }),
      listProjects: projectStore.listShells(),
      latestSequence: applicationEvents.latestApplicationSequence,
    });
    return {
      schemaVersion: threads.schemaVersion,
      snapshotSequence,
      projects,
      threads: threads.archivedThreads,
    } as const;
  }).pipe(
    Effect.flatMap((snapshot) =>
      enrichProjectShells(snapshot.projects).pipe(
        Effect.map(({ projects }) => ({ ...snapshot, projects })),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new OrchestrationV2GetShellSnapshotError({
          message: "Failed to load archived thread snapshot",
          cause,
        }),
    ),
  );

  // Rows the shell can omit, read with the same snapshot sequence the shell uses.
  const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(function* (
    options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
    message: string,
  ) {
    const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
      sql,
      readThreads: threadManagement.readShellSnapshot({ location: "active", ...options }),
      listProjects: Effect.succeed([]),
      latestSequence: applicationEvents.latestApplicationSequence,
    }).pipe(
      Effect.mapError((cause) => new OrchestrationV2GetShellSnapshotError({ message, cause })),
    );
    return { snapshotSequence, threads: threads.threads };
  });

  const handlers = OrchestrationWsRpcGroup.of({
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": command.commandId,
        "orchestration_v2.command_type": command.type,
        "orchestration_v2.thread_id":
          command.type === "thread.fork" || command.type === "thread.merge_back"
            ? command.targetThreadId
            : command.type === "delegated_task.request" ||
                command.type === "delegated_task.wake-policy" ||
                command.type === "delegated_task.completion-delivery.acknowledge" ||
                command.type === "delegated_task.completion-delivery.dispose" ||
                command.type === "thread.created.record"
              ? command.parentThreadId
              : command.threadId,
        ...(command.type === "thread.fork" || command.type === "thread.merge_back"
          ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
          : {}),
      }).pipe(
        Effect.andThen(
          startup
            .enqueueCommand(
              (command.type === "prepared-run.retry"
                ? threadLaunch.retryPreparation(command)
                : ThreadMessageIntake.dispatchCommand(
                    ThreadManagementService.withCreationProvenance(command, {
                      createdBy: "user",
                      creationSource: "creationSource" in command ? command.creationSource : "web",
                    }),
                    {
                      managesProviders: currentSession.scopes.includes(AuthProvidersManageScope),
                    },
                  )
              ).pipe(Effect.provide(intakeContext)),
            )
            .pipe(
              Effect.map((result) => ({ sequence: result.sequence })),
              Effect.mapError((cause) => {
                if (cause._tag === "EnvironmentAuthorizationError") return cause;
                const detail = userFacingDispatchErrorMessage(cause);
                return new OrchestrationV2DispatchCommandError({
                  commandId: command.commandId,
                  commandType: command.type,
                  message: detail ?? "Failed to dispatch orchestration V2 command",
                  ...(detail === undefined ? {} : { detail }),
                  cause,
                });
              }),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) => threadManagement.stopWorkflow(input),
    [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: (input) =>
      threadManagement.forceStopThread(input),
    [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
      readWorkflowScript({ scriptPath: input.scriptPath }),
    [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: (input) =>
      nativeChildWork.getNativeChildWork(input),
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
      threadManagement.getTurnItem(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: "Failed to load turn item",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
      checkpointDiffQuery.getTurnDiff(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetTurnDiffError({
              message: "Failed to load turn diff",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
      checkpointDiffQuery.getFullThreadDiff(input).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationGetFullThreadDiffError({
              message: "Failed to load full thread diff",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
      threadManagement
        .searchThread(input)
        .pipe(Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
    [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
      threadManagement
        .searchThreadStream(input)
        .pipe(Stream.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
    [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
      ThreadSearch.searchThreadsWithOlderSettledRows({
        request: input,
        search: threadSearch.search,
        searchOlderSettled: threadSearch.searchOlderSettled,
        sql,
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({ location: "active", threadIds }),
        latestSequence: applicationEvents.latestApplicationSequence,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationSearchThreadsError({
              message: "Failed to search threads",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
      getOrchestrationV2ArchivedShellSnapshot,
    [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input) =>
      readOmittableShellRows({ familyOf: input.threadId }, "Failed to load the thread family"),
    [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input) =>
      threadManagement.getThreadLinkMetadata(input.threadIds).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load thread link metadata",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: (input) =>
      threadManagement.getThreadTitles(input.threadIds).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load thread titles",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: (input) =>
      loadOlderSettledThreadsPage({
        sql,
        listThreads: threadManagement.listOlderSettledThreads(input),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({ location: "active", threadIds }),
        latestSequence: applicationEvents.latestApplicationSequence,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load older settled threads",
              cause,
            }),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) =>
      readOmittableShellRows(
        { worktreePath: input.worktreePath },
        "Failed to load the worktree's threads",
      ).pipe(Effect.map(({ threads }) => ({ threadIds: threads.map((thread) => thread.id) }))),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(
          // Bound compatibility snapshots so pre-pagination clients cannot materialize unlimited transcripts.
          threadManagement
            .getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            })
            .pipe(
              Effect.map(
                (snapshot) =>
                  buildBoundedThreadProjection({
                    projection: projectThreadProjectionForWire(snapshot.projection),
                    snapshotSequence: snapshot.snapshotSequence,
                  }).projection,
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to load orchestration V2 thread ${input.threadId}`,
                    cause,
                  }),
              ),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId,
        "orchestration_v2.project_id": input.projectId,
      }).pipe(
        Effect.andThen(
          startup
            .enqueueCommand(
              threadLaunch
                .checkWorktreeBase({
                  commandId: input.commandId,
                  projectId: input.projectId,
                  workspaceStrategy: input.workspaceStrategy,
                })
                .pipe(
                  Effect.andThen(
                    ThreadMessageIntake.launchThread({
                      commandId: input.commandId,
                      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                      ...(input.reuseExistingThread === undefined
                        ? {}
                        : { reuseExistingThread: input.reuseExistingThread }),
                      projectId: input.projectId,
                      title: input.title,
                      ...(input.generateTitle === undefined
                        ? {}
                        : { generateTitle: input.generateTitle }),
                      modelSelection: input.modelSelection,
                      runtimeMode: input.runtimeMode,
                      interactionMode: input.interactionMode,
                      workspaceStrategy: input.workspaceStrategy,
                      ...(input.initialMessage === undefined
                        ? {}
                        : {
                            initialMessage: {
                              ...(input.initialMessage.messageId === undefined
                                ? {}
                                : { messageId: input.initialMessage.messageId }),
                              text: input.initialMessage.text,
                              attachments: input.initialMessage.attachments,
                              ...(input.initialMessage.context === undefined
                                ? {}
                                : { context: input.initialMessage.context }),
                            },
                          }),
                      createdBy: "user",
                      creationSource: input.creationSource ?? "web",
                    }),
                  ),
                  Effect.provide(intakeContext),
                ),
            )
            .pipe(
              Effect.map((result) => ({
                ...result,
                projection: projectThreadProjectionForWire(result.projection),
              })),
              Effect.catchTags({
                AttachmentClaimError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: "Failed to launch thread",
                    cause,
                  }),
                ServerRuntimeStartupError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: "Failed to launch thread",
                    cause,
                  }),
                ThreadManagementProviderInstanceDisabledError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchBaseRefError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchBranchExistsError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchBranchConflictError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                ThreadLaunchNotRepositoryError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
                TaskFolderError: (cause) =>
                  new OrchestrationV2ThreadLaunchError({
                    commandId: input.commandId,
                    projectId: input.projectId,
                    message: cause.message,
                    cause,
                  }),
              }),
            ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.unwrap(
        Option.match(shellBroadcaster, {
          onNone: () => subscribeOrchestrationV2Shell(input),
          onSome: (broadcaster) =>
            subscribeOrchestrationV2Shell(input).pipe(
              Effect.provideService(
                ShellProjectionBroadcaster.ShellProjectionBroadcaster,
                broadcaster,
              ),
            ),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
      Stream.unwrap(
        Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
          Effect.andThen(threadViewers.view(input.threadId)),
          Effect.andThen(subscribeOrchestrationV2Thread(input)),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
      Stream.unwrap(
        Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
          Effect.as(commandOutputHub.subscribe(input)),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion]: (input) =>
      providerSessionManager.subscribePromptSuggestion(input.threadId),
    [WS_METHODS.workflowsSubscribe]: (input) =>
      input.changes === true ? workflows.watch : Workflows.wholeLists(workflows.watch),
    [WS_METHODS.workflowsCounts]: (_input) => workflows.counts,
    [WS_METHODS.workflowsGet]: (input) =>
      workflows.get(input.runId).pipe(Effect.mapError(toWorkflowRequestError)),
    [WS_METHODS.workflowsAbout]: (input) =>
      workflows.about(input).pipe(Effect.mapError(toWorkflowRequestError)),
    [WS_METHODS.workflowsAnswer]: (input) =>
      serverAuth.listClientSessions(currentSessionId).pipe(
        Effect.map((sessions) =>
          EnvironmentAuth.clientSessionLabel(sessions.find((session) => session.current)?.client),
        ),
        Effect.orElseSucceed(() => EnvironmentAuth.clientSessionLabel(undefined)),
        // The label names it to others; the session tells its own client the answer is its own.
        Effect.map((label) => ({ label, sessionId: currentSessionId })),
        Effect.flatMap((answeredBy) =>
          workflows.answer(
            input.runId,
            input.name,
            {
              choice: input.choice,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
            answeredBy,
          ),
        ),
        Effect.mapError(toWorkflowRequestError),
      ),
    [WS_METHODS.workflowsResume]: (input) =>
      workflows.resume(input.runId).pipe(Effect.mapError(toWorkflowRequestError)),
    [WS_METHODS.workflowsCancel]: (input) =>
      workflows.cancel(input.runId, input.reason).pipe(Effect.mapError(toWorkflowRequestError)),
    [WS_METHODS.workflowsGetDefinition]: (_input) => workflowDefinitions.read,
    [WS_METHODS.workflowsSaveDefinition]: (input) =>
      workflowDefinitions.save(input.name, input.source),
    [WS_METHODS.workflowsDeleteDefinition]: (input) => workflowDefinitions.remove(input.name),
    [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
      scheduledTasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
    [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
    [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.setEnabled(input)),
      ),
    [WS_METHODS.scheduledTasksDelete]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.delete(input)),
      ),
    [WS_METHODS.scheduledTasksRunNow]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.runNow(input)),
      ),
    [WS_METHODS.scheduledTasksRotateWebhookToken]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.rotateWebhookToken(input)),
      ),
    [WS_METHODS.guestShareCreate]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(guestShares.create(input)),
      ),
    [WS_METHODS.secretsAnswerRequest]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(secretRequests.answer(input)),
      ),
    [WS_METHODS.scheduledTasksListWebhookDeliveries]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.listWebhookDeliveries(input)),
      ),
    [WS_METHODS.scheduledTasksGetWebhookDelivery]: (input) =>
      Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
        Effect.andThen(scheduledTasks.getWebhookDelivery(input)),
      ),
    [WS_METHODS.peerLinksList]: (_input) => peerLinks.list.pipe(Effect.map((links) => ({ links }))),
    [WS_METHODS.peerLinksNames]: (_input) =>
      peerLinks.names.pipe(Effect.map((links) => ({ links }))),
    [WS_METHODS.peerLinksLink]: (input) => peerLinks.link(input),
    [WS_METHODS.peerLinksUnlink]: ({ environmentId }) => peerLinks.unlink(environmentId),
    [WS_METHODS.peerLinksSubscribeThread]: (input) => peerThreadRelay.subscribe(input),
    [WS_METHODS.peerLinksThreadHistoryPage]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(peerThreadRelay.historyPage(input)),
      ),
    [WS_METHODS.peerLinksThreadItem]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(peerThreadRelay.item(input)),
      ),
    [WS_METHODS.peerLinksPairClient]: (input) => peerClientPairing.request(input, currentSession),
    [WS_METHODS.peerLinksPairLink]: (input) =>
      peerClientPairing.requestForLink(input, currentSession),
    [WS_METHODS.peerLinksAnswerRequest]: (input) =>
      Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
        Effect.andThen(peerLinkRequests.answer(input)),
      ),
  });

  return yield* OrchestrationWsRpcGroup.toHandlers(handlers);
});
