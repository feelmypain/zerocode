import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  HTTP_USAGE_LIMIT_SOURCES_CAPABILITY,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
} from "@zerocode/contracts";
import {
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  splitLargeSocketFrames,
} from "@zerocode/shared/socketFrameParts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ShellProjectionBroadcaster from "./orchestration-v2/ShellProjectionBroadcaster.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as PeerClientPairing from "./peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerThreadRelay from "./peer/PeerThreadRelay.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { requestUrl } from "./requestUrl.ts";
import type * as ServerSettings from "./serverSettings.ts";
import { withSocketHeartbeat } from "./socketHeartbeat.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { withOutputWindow } from "./terminal/OutputProtocol.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as LayoutCommandApprovalWrites from "./workspace/LayoutCommandApprovalWrites.ts";
import {
  makeOrchestrationHandlers,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
} from "./ws/wsOrchestrationHandlers.ts";
import { makePreviewDeviceTerminalHandlers } from "./ws/wsPreviewDeviceTerminalHandlers.ts";
import {
  ServerWsRpcGroup,
  resolveOpenDiscoveryForConfig,
  withLateConfigDiscovery,
} from "./ws/wsRpcShared.ts";
import { makeServerAndProviderHandlers } from "./ws/wsServerAndProviderHandlers.ts";
import { makeVcsAndPullRequestHandlers } from "./ws/wsVcsAndPullRequestHandlers.ts";

export {
  resolveOpenDiscoveryForConfig,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  withLateConfigDiscovery,
};

function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  return (
    url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
    String(ORCHESTRATION_PROTOCOL_VERSION)
  );
}

function readSettingsClient(url: URL) {
  const capabilities = url.searchParams.get(CLIENT_CAPABILITIES_QUERY_PARAM)?.split(",") ?? [];
  return {
    secretReferences: capabilities.includes(SETTINGS_SECRET_REFERENCES_CAPABILITY),
    httpUsageLimitSources: capabilities.includes(HTTP_USAGE_LIMIT_SOURCES_CAPABILITY),
  };
}

export const layerWsRpc = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  serverBrowser: ServerBrowser.ServerBrowser["Service"],
  reportProfiles: ServerBrowser.ProfileReporter,
  settingsClient: ServerSettings.SettingsClient,
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const orchestrationHandlers = yield* makeOrchestrationHandlers(currentSession);
      const vcsAndPullRequestHandlers = yield* makeVcsAndPullRequestHandlers(currentSession);
      const layoutCommandApprovalWrites =
        yield* LayoutCommandApprovalWrites.LayoutCommandApprovalWrites;
      const previewDeviceTerminalHandlers = yield* makePreviewDeviceTerminalHandlers({
        currentSession,
        serverBrowser,
        reportProfiles,
        setLayoutCommandApproval: layoutCommandApprovalWrites.set,
      });
      const serverAndProviderHandlers = yield* makeServerAndProviderHandlers({
        currentSession,
        settingsClient,
      });
      return Context.merge(
        Context.merge(orchestrationHandlers, vcsAndPullRequestHandlers),
        Context.merge(previewDeviceTerminalHandlers, serverAndProviderHandlers),
      );
    }),
  );

// Default socket-level Defect frames end every pending client request.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const npmRelease = yield* NpmRelease.NpmRelease;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const issues = yield* IssueService.IssueService;
    const threadIssues = yield* ThreadIssueService.ThreadIssueService;
    const issueTrackers = yield* IssueTrackerConnections.IssueTrackerConnections;
    const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
    const peerThreadRelay = yield* PeerThreadRelay.PeerThreadRelay;
    const peerClientPairing = yield* PeerClientPairing.PeerClientPairing;
    const shellBroadcaster = yield* ShellProjectionBroadcaster.ShellProjectionBroadcaster;
    const sql = yield* SqlClient.SqlClient;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc").pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        // Desktop bootstrap sessions connect to their own backend, including same-machine WSL.
        if (session.subject === "desktop-bootstrap") {
          delete NodeHttpServerRequest.toIncomingMessage(request).headers[
            "sec-websocket-extensions"
          ];
        }
        const reportProfiles = yield* serverBrowser.profileReporter;
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(RpcAuthorization.layer(session.scopes), rpcInstrumentationLayer),
            ),
            Effect.forkScoped,
          );
          return httpEffect;
        }).pipe(
          Effect.provide(
            layerWsRpc(session, serverBrowser, reportProfiles, readSettingsClient(url.value)).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              // Handler-context reporters see only request defects, not server-wide defects.
              Layer.provide(DefectReporter.layer),
              Layer.provide(AcpRegistrySessions.layer),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              // Installs outlive the connection that started them and lock across clients.
              Layer.provide(
                Layer.succeed(
                  ProviderMaintenanceRunner.ProviderMaintenanceRunner,
                  providerMaintenanceRunner,
                ),
              ),
              Layer.provide(Layer.succeed(NpmRelease.NpmRelease, npmRelease)),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // Share server-lifetime PR caches so WS mutations invalidate every client's HTTP diffs.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(Layer.succeed(IssueService.IssueService, issues)),
              Layer.provide(Layer.succeed(ThreadIssueService.ThreadIssueService, threadIssues)),
              Layer.provide(
                Layer.succeed(IssueTrackerConnections.IssueTrackerConnections, issueTrackers),
              ),
              Layer.provide(OtlpEndpointCheck.layer),
              Layer.provide(
                Layer.succeed(
                  PullRequestReviewGuideService.PullRequestReviewGuideService,
                  reviewGuides,
                ),
              ),
              Layer.provide(Layer.succeed(PeerLinks.PeerLinks, peerLinks)),
              Layer.provide(Layer.succeed(PeerLinkRequests.PeerLinkRequests, peerLinkRequests)),
              Layer.provide(Layer.succeed(PeerThreadRelay.PeerThreadRelay, peerThreadRelay)),
              Layer.provide(Layer.succeed(PeerClientPairing.PeerClientPairing, peerClientPairing)),
              Layer.provide(
                Layer.succeed(
                  ShellProjectionBroadcaster.ShellProjectionBroadcaster,
                  shellBroadcaster,
                ),
              ),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(SourceControlBuiltInDrivers.layer),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        const splitFrames = url.value.searchParams.has(SOCKET_FRAME_PARTS_QUERY_PARAM);
        const framedRpcWebSocketHttpEffect = rpcWebSocketHttpEffect.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            // The RPC server upgrades the request itself, so its socket is
            // wrapped through the request it reads.
            Object.create(request, {
              upgrade: {
                value: Effect.map(request.upgrade, (socket) =>
                  withSocketHeartbeat(splitFrames ? splitLargeSocketFrames(socket) : socket),
                ),
              },
            }),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () =>
            Effect.raceFirst(
              framedRpcWebSocketHttpEffect,
              sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint).pipe(
                Effect.as(HttpServerResponse.empty()),
                Effect.catchTags({
                  SessionCredentialVerificationError: (error) =>
                    failEnvironmentInternal("internal_error", error),
                }),
              ),
            ),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(Layer.provide(NpmRelease.layer), Layer.provide(ShellProjectionBroadcaster.layer));
