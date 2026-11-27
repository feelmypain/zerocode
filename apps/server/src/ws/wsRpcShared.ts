import {
  type EditorId,
  EnvironmentAuthorizationError,
  type FileManagerRevealKind,
  type AuthEnvironmentScope,
  type ServerConfig as ClientServerConfig,
  type ServerConfigStreamEvent,
  WsRpcGroup,
} from "@zerocode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RpcGroup } from "effect/rpc";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import type * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import type * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import type * as ExternalLauncher from "../process/externalLauncher.ts";
import type * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

// Middleware added later wraps middleware added earlier, so instrumentation wraps authorization.
export const ServerWsRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);

// RpcGroup.toLayer/toHandlers derives each handler's requirements by scanning every RPC in
// the group, so its type cost grows with handlers × RPCs. Near 200 methods that crosses
// TypeScript's instantiation limit and the layer's requirements degrade to `any`, so the
// handlers are partitioned into four disjoint, domain-scoped sub-groups.
type ServerWsRpc = RpcGroup.Rpcs<typeof ServerWsRpcGroup>;

const ORCHESTRATION_WS_RPC_PREFIXES = [
  "orchestration",
  "workflows",
  "scheduledTasks",
  "secrets",
  "guestShare",
  "peerLinks",
] as const;
type OrchestrationWsRpc = Extract<
  ServerWsRpc,
  { readonly _tag: `${(typeof ORCHESTRATION_WS_RPC_PREFIXES)[number]}.${string}` }
>;
const isOrchestrationWsRpc = (rpc: ServerWsRpc): rpc is OrchestrationWsRpc =>
  ORCHESTRATION_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`));

const VCS_AND_PR_WS_RPC_PREFIXES = [
  "pullRequests",
  "issues",
  "issueTrackers",
  "sourceControl",
  "vcs",
  "git",
  "review",
  "worktreeSetup",
] as const;
const VCS_AND_PR_WS_RPC_EXACT = [
  "subscribeVcsStatus",
  "subscribeVcsBranch",
  "subscribeWorktreeSetup",
] as const;
type VcsAndPullRequestWsRpc = Extract<
  ServerWsRpc,
  {
    readonly _tag:
      | `${(typeof VCS_AND_PR_WS_RPC_PREFIXES)[number]}.${string}`
      | (typeof VCS_AND_PR_WS_RPC_EXACT)[number];
  }
>;
const vcsAndPrExactSet: ReadonlySet<string> = new Set(VCS_AND_PR_WS_RPC_EXACT);
const isVcsAndPullRequestWsRpc = (rpc: ServerWsRpc): rpc is VcsAndPullRequestWsRpc =>
  VCS_AND_PR_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`)) ||
  vcsAndPrExactSet.has(rpc._tag);

const PREVIEW_DEVICE_TERMINAL_WS_RPC_PREFIXES = [
  "terminal",
  "preview",
  "device",
  "projects",
  "projectClone",
  "shell",
  "filesystem",
  "workspace",
  "agentSessions",
  "assets",
  "attachments",
] as const;
const PREVIEW_DEVICE_TERMINAL_WS_RPC_EXACT = [
  "subscribeTerminalMetadata",
  "subscribePreviewEvents",
  "subscribeDiscoveredLocalServers",
  "subscribeDeviceState",
  "subscribeProjectClones",
] as const;
type PreviewDeviceTerminalWsRpc = Extract<
  ServerWsRpc,
  {
    readonly _tag:
      | `${(typeof PREVIEW_DEVICE_TERMINAL_WS_RPC_PREFIXES)[number]}.${string}`
      | (typeof PREVIEW_DEVICE_TERMINAL_WS_RPC_EXACT)[number];
  }
>;
const previewDeviceTerminalExactSet: ReadonlySet<string> = new Set(
  PREVIEW_DEVICE_TERMINAL_WS_RPC_EXACT,
);
const isPreviewDeviceTerminalWsRpc = (rpc: ServerWsRpc): rpc is PreviewDeviceTerminalWsRpc =>
  PREVIEW_DEVICE_TERMINAL_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`)) ||
  previewDeviceTerminalExactSet.has(rpc._tag);

type ServerAndProviderWsRpc = Exclude<
  ServerWsRpc,
  OrchestrationWsRpc | VcsAndPullRequestWsRpc | PreviewDeviceTerminalWsRpc
>;
const isServerAndProviderWsRpc = (rpc: ServerWsRpc): rpc is ServerAndProviderWsRpc =>
  !isOrchestrationWsRpc(rpc) &&
  !isVcsAndPullRequestWsRpc(rpc) &&
  !isPreviewDeviceTerminalWsRpc(rpc);

const serverWsRpcs = Array.from(ServerWsRpcGroup.requests.values());

export const OrchestrationWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isOrchestrationWsRpc));
export const VcsAndPullRequestWsRpcGroup = RpcGroup.make(
  ...serverWsRpcs.filter(isVcsAndPullRequestWsRpc),
);
export const PreviewDeviceTerminalWsRpcGroup = RpcGroup.make(
  ...serverWsRpcs.filter(isPreviewDeviceTerminalWsRpc),
);
export const ServerAndProviderWsRpcGroup = RpcGroup.make(
  ...serverWsRpcs.filter(isServerAndProviderWsRpc),
);

export const makeRefreshGitStatus =
  (vcsStatusBroadcaster: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]) => (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

export const authorizeEffect = <A, E, R>(
  currentSession: EnvironmentAuth.AuthenticatedSession,
  requiredScope: AuthEnvironmentScope,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
  currentSession.scopes.includes(requiredScope)
    ? effect
    : Effect.fail(rpcAuthorizationError(requiredScope));

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

type EditorDiscovery = Pick<
  ExternalLauncher.ExternalLauncher["Service"],
  "resolveAvailableEditors" | "resolveFileManagerRevealKind"
>;

const resolveEditorConfig = Effect.fn("ws.resolveEditorConfig")(function* <E, R>(
  availableEditors: ReadonlyArray<EditorId>,
  revealKind: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) {
  const fileManagerRevealKind = availableEditors.includes("file-manager")
    ? yield* revealKind
    : undefined;
  return {
    availableEditors,
    ...(fileManagerRevealKind === undefined
      ? {}
      : {
          shellRevealInFileManager: true,
          shellRevealInFileManagerKind: fileManagerRevealKind,
        }),
  };
});

export const withLateConfigDiscovery = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
  remoteOpenTargets: RemoteOpenTargets.RemoteOpenTargets["Service"],
  directEndpoints: Pick<DirectEndpoints.DirectEndpoints["Service"], "resolve">,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Unbounded, unlike the snapshot: this exists to deliver a probe that
    // outlasts the snapshot's timeout.
    Stream.mapEffect((editors) =>
      resolveEditorConfig(editors, launcher.resolveFileManagerRevealKind()),
    ),
    Stream.filter(
      (editorConfig) =>
        editorConfig.availableEditors.join() !== config.availableEditors.join() ||
        editorConfig.shellRevealInFileManagerKind !== config.shellRevealInFileManagerKind,
    ),
    Stream.map((editorConfig) => ({ type: "editorsResolved" as const, editorConfig })),
  );

  const lateRemoteOpenTargets = Stream.fromEffect(remoteOpenTargets.resolveTargets()).pipe(
    Stream.filter(
      (targets) => JSON.stringify(targets) !== JSON.stringify(config.remoteOpenTargets ?? []),
    ),
    Stream.map((targets) => ({ type: "remoteOpenTargetsResolved" as const, targets })),
  );

  const lateDirectEndpoints = Stream.fromEffect(directEndpoints.resolve()).pipe(
    Stream.catchCause(() => Stream.empty),
    Stream.map((endpoints) => ({ type: "directEndpointsResolved" as const, endpoints })),
  );

  return Stream.merge(
    liveUpdates,
    Stream.merge(lateEditorConfig, Stream.merge(lateRemoteOpenTargets, lateDirectEndpoints)),
  ).pipe(
    Stream.mapAccum(
      (): ClientServerConfig => config,
      (current, event): readonly [ClientServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (event.type) {
          case "editorsResolved": {
            const {
              availableEditors: _editors,
              shellRevealInFileManager: _reveal,
              shellRevealInFileManagerKind: _revealKind,
              ...rest
            } = current;
            const next = { ...rest, ...event.editorConfig };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "remoteOpenTargetsResolved": {
            const next = { ...current, remoteOpenTargets: event.targets };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "directEndpointsResolved": {
            if (JSON.stringify(current.directEndpoints ?? []) === JSON.stringify(event.endpoints)) {
              return [current, []];
            }
            const next = { ...current, directEndpoints: event.endpoints };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "keybindingsUpdated":
            return [{ ...current, ...event.payload }, [event]];
          case "providerStatuses":
            return [{ ...current, providers: event.payload.providers }, [event]];
          case "settingsUpdated":
            return [{ ...current, settings: event.payload.settings }, [event]];
          // Themes and usage-limit sources survive snapshots because snapshots never include them.
          default:
            return [current, [event]];
        }
      },
    ),
  );
};

// Discoveries run side by side so the slowest one, not their sum, bounds the
// server config snapshot. Each degrades on timeout rather than failing it.
export const resolveOpenDiscoveryForConfig = <T, D, E1, R1, E2, R2, E3, R3, E4, R4>(discovery: {
  readonly editors: Effect.Effect<ReadonlyArray<EditorId>, E1, R1>;
  readonly fileManagerRevealKind: Effect.Effect<FileManagerRevealKind | undefined, E2, R2>;
  readonly remoteOpenTargets: Effect.Effect<ReadonlyArray<T>, E3, R3>;
  readonly directEndpoints: Effect.Effect<ReadonlyArray<D>, E4, R4>;
}) =>
  Effect.all(
    {
      editorConfig: resolveAvailableEditorsForConfig(discovery.editors).pipe(
        Effect.flatMap((availableEditors) =>
          resolveEditorConfig(
            availableEditors,
            resolveFileManagerRevealKindForConfig(discovery.fileManagerRevealKind),
          ),
        ),
      ),
      // Same discovery-with-timeout treatment as editors: a slow probe must
      // not stall server.getConfig, so it degrades to an empty list.
      remoteOpenTargets: resolveAvailableEditorsForConfig(discovery.remoteOpenTargets),
      directEndpoints: resolveAvailableEditorsForConfig(discovery.directEndpoints),
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map(({ editorConfig, ...endpoints }) => ({ ...editorConfig, ...endpoints })));
