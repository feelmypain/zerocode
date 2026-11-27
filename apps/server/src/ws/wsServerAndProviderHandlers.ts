// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure provider mapping.
import * as NodeCrypto from "node:crypto";
import {
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListSessionsInput,
  AcpRegistryOperationError,
  type AcpRegistrySetProviderInput,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  AuthSessionId,
  ProviderDriverKind,
  ProviderSetupError,
  ProviderUploadFeedbackError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  RpcClientId,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  WS_METHODS,
  authScopeResponse,
  serverProviderDeltas,
} from "@zerocode/contracts";
import * as AcpRegistryRuntimeCoordinator from "@zerocode/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@zerocode/provider-acp-registry/server/AcpRegistrySupport";
import * as SecretResolver from "@zerocode/secret-provider-core/server/SecretResolver";
import * as FeatureFlags from "@zerocode/shared/FeatureFlags";
import * as HostProcess from "@zerocode/shared/HostProcess";
import * as RelayClient from "@zerocode/shared/relayClient";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@zerocode/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import { remoteSshDeviceHosts } from "../device/localSshDeviceHost.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as Keybindings from "../keybindings.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as McpSignIn from "../mcpApps/McpSignIn.ts";
import * as EventLoopMonitor from "../observability/EventLoopMonitor.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ManagedProviders from "../policy/managedProviders.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import { subscribeChatGptHandoff } from "../provider/CodexChatGptHandoff.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import * as SecretCheck from "../secrets/SecretCheck.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import { invalidateSettingsSecrets } from "../sourceControl/sourceControlHostSecrets.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import {
  ServerAndProviderWsRpcGroup,
  resolveOpenDiscoveryForConfig,
  withLateConfigDiscovery,
} from "./wsRpcShared.ts";

const PROVIDER_STATUS_DEBOUNCE_MS = 200;
const isProviderUploadFeedbackError = Schema.is(ProviderUploadFeedbackError);

// A failed scan leaves no cwd snapshot, so a client without the machine catalog gets it
// as a pending snapshot, which it shows while it retries the scan.
function workspaceSnapshotOrCatalog(
  provider: ServerProvider,
  cwd: string,
  catalogOnDemand: boolean,
) {
  const snapshots = (provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd === cwd);
  if (snapshots.length > 0 || !catalogOnDemand) return snapshots;
  return [
    {
      cwd,
      checkedAt: provider.checkedAt,
      slashCommands: provider.slashCommands,
      slashCommandsPending: true,
      skills: provider.skills,
    },
  ];
}

// What an on-demand catalog client keeps of the machine catalog: full entries come from the
// cwd snapshot it fetches, and skill names and labels keep skill links working without one.
function machineCatalogNames(provider: Pick<ServerProvider, "slashCommands" | "skills">) {
  return {
    slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
    skills: provider.skills.map(({ description: _d, shortDescription: _s, ...skill }) => skill),
  };
}

// Stable across restarts, so a client's cached lists stay current until the catalog changes.
// It covers the full entries: a changed description or input hint must reach the client too.
const machineCatalogDigest = (provider: Pick<ServerProvider, "slashCommands" | "skills">) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.slashCommands, provider.skills]))
    .digest("hex")
    .slice(0, 16);

// Names, or the digest that stands for them, still change the config when the machine catalog
// does, so the client refetches its cwd snapshot.
function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  catalogsPerCwd: ReadonlySet<string> = new Set(),
  catalogDigests = false,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => {
    if (!catalogsPerCwd.has(provider.instanceId)) return provider;
    return catalogDigests
      ? {
          ...provider,
          slashCommands: [],
          skills: [],
          catalogDigest: machineCatalogDigest(provider),
        }
      : { ...provider, ...machineCatalogNames(provider) };
  });
}

// Deltas are taken from the list this client last received, which a late snapshot replaces.
const withProviderStatusDeltas = (sent: ReadonlyArray<ServerProvider>) =>
  Stream.mapAccum(
    () => sent,
    (
      previous,
      event: ServerConfigStreamEvent,
    ): readonly [ReadonlyArray<ServerProvider>, ReadonlyArray<ServerConfigStreamEvent>] => {
      if (event.type === "snapshot") return [event.config.providers, [event]];
      if (event.type !== "providerStatuses") return [previous, [event]];
      const { providers } = event.payload;
      return [
        providers,
        [
          {
            version: 1,
            type: "providerStatusDeltas",
            payload: { providers: serverProviderDeltas(previous, providers) },
          },
        ],
      ];
    },
  );

function toAuthAccessStreamEvent(
  change: Exclude<
    PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
    { readonly type: "connectDevicesChanged" }
  >,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: { ...change.pairingLink, ...authScopeResponse(change.pairingLink.scopes) },
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          ...authScopeResponse(change.clientSession.scopes),
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

export const makeServerAndProviderHandlers = Effect.fn("ws.handlers.serverAndProvider")(
  function* (input: {
    readonly currentSession: EnvironmentAuth.AuthenticatedSession;
    readonly settingsClient: ServerSettings.SettingsClient;
  }) {
    const { currentSession, settingsClient } = input;
    const currentSessionId = currentSession.sessionId;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const eventLoopMonitor = yield* EventLoopMonitor.EventLoopMonitor;
    const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
    const mcpSignIn = yield* McpSignIn.McpSignIn;
    const deviceHostContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
    const usage = yield* UsageService.UsageService;
    const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
    const keybindings = yield* Keybindings.Keybindings;
    const featureFlags = yield* FeatureFlags.FeatureFlags;
    const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
    const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
    const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const acpRegistryRuntimeCoordinator =
      yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
    const acpRegistrySessions = yield* AcpRegistrySessions.AcpRegistrySessions;
    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const providerInstallation = yield* ProviderInstallation.ProviderInstallation;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const npmRelease = yield* NpmRelease.NpmRelease;
    const config = yield* ServerConfig.ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const storageCleanup = yield* StorageCleanup.StorageCleanup;
    const databaseStorage = yield* DatabaseStorage.DatabaseStorage;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const secretResolver = yield* SecretResolver.SecretResolver;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
    yield* Effect.addFinalizer(() =>
      Ref.get(rpcClientIds).pipe(
        Effect.flatMap((clientIds) =>
          Effect.forEach(
            clientIds,
            (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
            {
              discard: true,
            },
          ),
        ),
        Effect.ignore,
      ),
    );
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const secretCheck = yield* SecretCheck.SecretCheck;
    const otlpEndpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
    const textGenerators = yield* TextGenerators.TextGenerators;
    const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
    const sessions = yield* SessionStore.SessionStore;
    const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
    const triage = yield* TriageService.TriageService;
    const hostResources = yield* HostResources.HostResources;
    const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
    const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
    const relayClient = yield* RelayClient.RelayClient;

    const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
      input: AcpRegistryListSessionsInput,
    ) {
      const project = yield* acpRegistrySessions.project(input.projectId);
      const { instance, manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
      // Only a probed agent advertises listing, so a read never installs or first-starts one.
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (snapshot.nativeSessions?.canList !== true) {
        return yield* new AcpRegistryOperationError({
          reason: "session_list_unsupported",
          message: "The ACP agent does not advertise session listing.",
        });
      }
      const listed = yield* manager.listSessions({
        cwd: project.workspaceRoot,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const sessionRows = yield* Effect.forEach(
        listed.sessions,
        (session) => {
          const idInput = {
            driver: instance.driverKind,
            instanceId: input.instanceId,
            sessionId: session.sessionId,
          };
          return acpRegistrySessions.findOwner(idInput).pipe(
            Effect.flatMap((owner) => {
              const threadId = owner ?? AcpRegistrySessions.importedThreadId(idInput);
              return threadManagement.getThreadShell(threadId).pipe(
                Effect.map((thread) => ({
                  ...session,
                  importedThreadId: thread === null ? null : threadId,
                  ...(thread !== null &&
                  AgentSessionImporter.isNativeHistoryPending({
                    historyOrigin: thread.historyOrigin,
                    hasRun: thread.latestRunId !== null,
                  })
                    ? { nativeHistoryPending: true }
                    : {}),
                })),
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "session_import_failed",
                      message: "Could not inspect existing imported ACP sessions.",
                      cause,
                    }),
                ),
              );
            }),
          );
        },
        { concurrency: 16 },
      );
      return { ...listed, sessions: sessionRows };
    });

    const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
      input: AcpRegistryDeleteSessionInput,
    ) {
      return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
        Effect.gen(function* () {
          const project = yield* acpRegistrySessions.project(input.projectId);
          const { instance, manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
          const snapshot = yield* instance.snapshot.getSnapshot;
          if (snapshot.nativeSessions?.canDelete !== true) {
            return yield* new AcpRegistryOperationError({
              reason: "session_delete_unsupported",
              message: "The ACP agent does not advertise session deletion.",
            });
          }
          const idInput = {
            driver: instance.driverKind,
            instanceId: input.instanceId,
            sessionId: input.sessionId,
          };
          const threadId =
            (yield* acpRegistrySessions.findOwner(idInput)) ??
            AcpRegistrySessions.importedThreadId(idInput);
          const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new AcpRegistryOperationError({
                  reason: "session_delete_failed",
                  message: "Could not inspect the imported ACP session mapping.",
                  cause,
                }),
            ),
          );
          if (importedThread !== null) {
            return yield* new AcpRegistryOperationError({
              reason: "session_delete_failed",
              message:
                "Delete the imported ZeroCode thread before deleting its native ACP session.",
            });
          }
          yield* manager.deleteSession({
            cwd: project.workspaceRoot,
            sessionId: input.sessionId,
          });
          return { deleted: true } as const;
        }),
      );
    });

    const listAcpRegistryProviders = Effect.fn("ws.acpRegistry.listProviders")(function* (
      input: AcpRegistryListProvidersInput,
    ) {
      const project = yield* acpRegistrySessions.project(input.projectId);
      const { instance, manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (snapshot.configurableProviders !== true) {
        return yield* new AcpRegistryOperationError({
          reason: "providers_unsupported",
          message: "The ACP agent does not advertise provider configuration.",
        });
      }
      return yield* manager.listProviders(project.workspaceRoot);
    });

    const setAcpRegistryProvider = Effect.fn("ws.acpRegistry.setProvider")(function* (
      input: AcpRegistrySetProviderInput,
    ) {
      const project = yield* acpRegistrySessions.project(input.projectId);
      const { manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
      if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
        return yield* new AcpRegistryOperationError({
          reason: "provider_configuration_failed",
          message: "ACP provider configuration accepts at most 32 headers.",
        });
      }
      const listed = yield* manager.listProviders(project.workspaceRoot);
      const provider = listed.providers.find(
        (candidate) => candidate.providerId === input.providerId,
      );
      if (provider === undefined || !provider.supported.includes(input.apiType)) {
        return yield* new AcpRegistryOperationError({
          reason: "provider_configuration_failed",
          message: `Provider ${input.providerId} does not support ${input.apiType}.`,
        });
      }
      yield* providerSessionManager.closeInstance(input.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "Could not stop live sessions before updating the ACP provider.",
              cause,
            }),
        ),
      );
      yield* manager.setProvider({
        cwd: project.workspaceRoot,
        providerId: input.providerId,
        apiType: input.apiType,
        baseUrl: input.baseUrl,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      });
      yield* providerRegistry.refreshInstance(input.instanceId);
      return { configured: true } as const;
    });

    const disableAcpRegistryProvider = Effect.fn("ws.acpRegistry.disableProvider")(function* (
      input: AcpRegistryDisableProviderInput,
    ) {
      const project = yield* acpRegistrySessions.project(input.projectId);
      const { manager } = yield* acpRegistrySessions.sessionManager(input.instanceId);
      const listed = yield* manager.listProviders(project.workspaceRoot);
      const provider = listed.providers.find(
        (candidate) => candidate.providerId === input.providerId,
      );
      if (provider === undefined || provider.required) {
        return yield* new AcpRegistryOperationError({
          reason: "provider_configuration_failed",
          message:
            provider === undefined
              ? `Provider ${input.providerId} was not advertised by the ACP agent.`
              : `Provider ${input.providerId} is required and cannot be disabled.`,
        });
      }
      yield* providerSessionManager.closeInstance(input.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "Could not stop live sessions before disabling the ACP provider.",
              cause,
            }),
        ),
      );
      yield* manager.disableProvider({
        cwd: project.workspaceRoot,
        providerId: input.providerId,
      });
      yield* providerRegistry.refreshInstance(input.instanceId);
      return { disabled: true } as const;
    });

    const loadAuthAccessSnapshot = () =>
      Effect.all({
        pairingLinks: serverAuth.listPairingLinks(),
        clientSessions: serverAuth.listClientSessions(currentSessionId),
        connectDevices: serverAuth.listConnectDevices(),
      }).pipe(
        Effect.mapError(
          (error) =>
            new AuthAccessStreamError({
              message: error.message,
            }),
        ),
      );

    const loadServerConfig = Effect.fn("ws.loadServerConfig")(function* (options: {
      readonly usageLimitsCommand: boolean;
      readonly workspaceSnapshotsOnDemand: boolean;
      readonly deferNetworkDiscovery: boolean;
      readonly catalogsPerCwd?: ReadonlySet<string>;
      readonly catalogDigests?: boolean;
    }) {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const currentProviders = yield* providerRegistry.getProviders;
      const commandProviders = options.usageLimitsCommand
        ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
        : currentProviders;
      const providers = options.workspaceSnapshotsOnDemand
        ? withoutWorkspaceSnapshots(
            commandProviders,
            options.catalogsPerCwd,
            options.catalogDigests,
          )
        : commandProviders;
      const settings = ServerSettings.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
        settingsClient,
      );
      const environment = yield* serverEnvironment.getDescriptor;
      const auth = yield* serverAuth.getDescriptor();
      const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
      const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;
      const discovery = yield* resolveOpenDiscoveryForConfig({
        editors: externalLauncher.resolveAvailableEditors(),
        fileManagerRevealKind: externalLauncher.resolveFileManagerRevealKind(),
        remoteOpenTargets: options.deferNetworkDiscovery
          ? Effect.succeed([])
          : remoteOpenTargets.resolveTargets(),
        directEndpoints: options.deferNetworkDiscovery
          ? directEndpoints.resolveAvailable()
          : directEndpoints.resolve(),
      });

      return {
        environment,
        auth,
        cwd: config.cwd,
        hostname: yield* HostProcess.Hostname,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        ...discovery,
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined
            ? {
                otlpTracesUrl: config.otlpTracesUrl,
                otlpTracesSource: config.otlpTracesSource,
                otlpTracesVariable: config.otlpTracesVariable,
              }
            : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined
            ? {
                otlpMetricsUrl: config.otlpMetricsUrl,
                otlpMetricsSource: config.otlpMetricsSource,
                otlpMetricsVariable: config.otlpMetricsVariable,
              }
            : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          ...(config.otlpLogsUrl !== undefined
            ? {
                otlpLogsUrl: config.otlpLogsUrl,
                otlpLogsSource: config.otlpLogsSource,
                otlpLogsVariable: config.otlpLogsVariable,
              }
            : {}),
          otlpLogsEnabled: config.otlpLogsUrl !== undefined,
        },
        settings,
        ...(serverSettings.managedPolicy === undefined
          ? {}
          : { managedPolicy: serverSettings.managedPolicy }),
        shellResumeCompletionMarker: true,
        shellThreadFamilies: true,
        threadLinkMetadata: true,
        shellOlderSettled: true,
        threadResumeCompletionMarker: true,
        threadSnapshotPagination: true,
        threadFind: true,
        threadFindProgressive: true,
        secretProviderSettings: true,
        secretReferences: true,
        secretRequestReferences: true,
        featureFlags: {
          secretProviders: featureFlags.secretProviders,
          tanstackSource: featureFlags.tanstackSource,
        },
        ...Option.match(scratchWorkspaceRoot, {
          onNone: () => ({}),
          onSome: (root) => ({ scratchWorkspaceRoot: root }),
        }),
        newProjectsRoot: managedFolders.namedProjectsRoot,
        ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
        serverTime: DateTime.formatIso(yield* DateTime.now),
      };
    });

    const handlers = ServerAndProviderWsRpcGroup.of({
      [WS_METHODS.serverProbe]: (_input) =>
        Effect.map(DateTime.now, (now) => ({ serverTime: DateTime.formatIso(now) })),
      [WS_METHODS.serverGetConfig]: (_input) =>
        loadServerConfig({
          usageLimitsCommand: false,
          workspaceSnapshotsOnDemand: false,
          deferNetworkDiscovery: false,
        }),
      [WS_METHODS.serverSearchAcpRegistry]: (input) =>
        acpRegistryCatalog
          .search(input)
          .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
      [WS_METHODS.serverPrepareAcpRegistryAgent]: (input) =>
        Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const blocked = ManagedProviders.disallowedDriverReason(
                serverSettings.managedPolicy,
                ProviderDriverKind.make("acpRegistry"),
              );
              return blocked === undefined
                ? acpRegistryCatalog
                    .prepare(input)
                    .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError))
                : Effect.fail(
                    new AcpRegistryOperationError({ reason: "install_failed", message: blocked }),
                  );
            }),
          ),
        ),
      [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: (input) =>
        Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
          Effect.andThen(
            acpRegistryCatalog
              .uninstallManagedBinary(input)
              .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
          ),
        ),
      [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: (input) =>
        Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
          Effect.andThen(
            acpRegistryRuntimeCoordinator
              .acceptUrlAuthentication(input)
              .pipe(Effect.map((accepted) => ({ accepted }))),
          ),
        ),
      [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(listAcpRegistrySessions(input))),
      [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(acpRegistrySessions.importSession(input))),
      [WS_METHODS.serverDeleteAcpRegistrySession]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(deleteAcpRegistrySession(input))),
      [WS_METHODS.serverListAcpRegistryProviders]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(listAcpRegistryProviders(input))),
      [WS_METHODS.serverSetAcpRegistryProvider]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(setAcpRegistryProvider(input))),
      [WS_METHODS.serverDisableAcpRegistryProvider]: (input) =>
        Effect.annotateCurrentSpan({
          "provider.instance_id": input.instanceId,
          "project.id": input.projectId,
        }).pipe(Effect.andThen(disableAcpRegistryProvider(input))),
      [WS_METHODS.serverLogoutAcpRegistry]: (input) =>
        Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const { instance, manager } = yield* acpRegistrySessions.sessionManager(
                input.instanceId,
              );
              const snapshot = yield* instance.snapshot.getSnapshot;
              if (snapshot.auth.canLogout !== true) {
                return yield* new AcpRegistryOperationError({
                  reason: "logout_unsupported",
                  message: "The ACP agent does not advertise logout.",
                });
              }
              if (instance.auth) {
                yield* providerAuth.logout(input).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AcpRegistryOperationError({
                        reason: "logout_failed",
                        message: "Could not sign out of the ACP agent.",
                        cause,
                      }),
                  ),
                );
              } else {
                yield* providerSessionManager.closeInstance(input.instanceId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AcpRegistryOperationError({
                        reason: "logout_failed",
                        message: "Could not stop live sessions before ACP logout.",
                        cause,
                      }),
                  ),
                );
                yield* manager.logout(config.cwd);
              }
              yield* providerRegistry.refreshInstance(input.instanceId);
              return { loggedOut: true } as const;
            }),
          ),
        ),
      [WS_METHODS.serverRefreshProviders]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* (input) {
          if (input.modelCatalogOnly === true) {
            yield* providerRegistry.refreshModelCatalog;
            return { providers: [] };
          }
          if (input.refreshModels) {
            yield* providerRegistry.invalidateModelCaches({
              instanceId: input.instanceId,
              cwd: input.cwd,
              fresh: input.fresh,
            });
          }
          if (input.reloadSecrets === true && input.instanceId === undefined) {
            yield* invalidateSettingsSecrets(secretResolver, serverSettings.getSettings);
          }
          // Await refresh; RPC scope closure would interrupt a fork before the hub answered.
          if (input.instanceId === undefined) {
            yield* usageLimitSources.refresh;
          }
          let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
            ? providerRegistry.refreshWorkspaceSnapshot({
                instanceId: input.instanceId,
                cwd: input.cwd,
                scanCwd: yield* projectService.workspaceScanDirectory(input.cwd),
                fresh: input.fresh === true,
              })
            : input.reloadSecrets === true
              ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
              : input.instanceId !== undefined
                ? providerRegistry.refreshInstance(input.instanceId)
                : providerRegistry.refresh();
          if (input.refreshModels) {
            const instances = yield* providerInstances.listInstances;
            for (const instance of instances) {
              if (
                !instance.refreshModels ||
                (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                !providers.some(
                  (provider) =>
                    provider.instanceId === instance.instanceId &&
                    provider.enabled &&
                    provider.installed,
                )
              )
                continue;
              yield* instance.refreshModels().pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderSetupError({
                      instanceId: instance.instanceId,
                      operation: "refresh-models",
                      detail: error.detail,
                    }),
                ),
              );
              providers = yield* providerRegistry.refreshInstance(instance.instanceId);
            }
          }
          const { instanceId, cwd } = input;
          if (input.omitProviders === true && (instanceId === undefined || cwd === undefined)) {
            return { providers: [] };
          }
          if (input.workspaceSnapshotsOnDemand !== true) return { providers };
          const commandProviders =
            input.usageLimitsCommand === true
              ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
              : providers;
          if (instanceId === undefined || cwd === undefined) {
            return { providers: withoutWorkspaceSnapshots(commandProviders) };
          }
          const catalogOnDemand =
            input.providerCatalogsOnDemand === true &&
            (yield* providerInstances.getInstance(instanceId))?.snapshotForCwd !== undefined;
          return {
            providers: commandProviders
              .filter((provider) => provider.instanceId === instanceId)
              .map((provider) => {
                const catalog =
                  catalogOnDemand && input.machineCatalog === true
                    ? machineCatalogNames(provider)
                    : undefined;
                return {
                  ...provider,
                  // Callers read only the cwd snapshot; the config stream carries the rest.
                  models: [],
                  slashCommands: catalog?.slashCommands ?? [],
                  skills: catalog?.skills ?? [],
                  ...(catalog === undefined
                    ? {}
                    : { catalogDigest: machineCatalogDigest(provider) }),
                  workspaceSnapshots: workspaceSnapshotOrCatalog(provider, cwd, catalogOnDemand),
                };
              }),
          };
        }),
      [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
      [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
      [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
      [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
      [WS_METHODS.providerMcpSignInStart]: (input) => mcpSignIn.start(input),
      [WS_METHODS.providerMcpSignInComplete]: (input) => mcpSignIn.complete(input),
      [WS_METHODS.providerUploadFeedback]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(
          function* (input) {
            const projection = yield* threadManagement.getThreadRecords(input.threadId, [
              "providerThreads",
            ]);
            const providerThread =
              projection.providerThreads.find(
                (candidate) => candidate.id === projection.thread.activeProviderThreadId,
              ) ?? projection.providerThreads.at(-1);
            const providerSessionId = providerThread?.providerSessionId ?? null;
            if (providerThread === undefined || providerSessionId === null) {
              return yield* new ProviderUploadFeedbackError({
                threadId: input.threadId,
                cause: "No provider session has run in this thread yet.",
              });
            }
            const runtime = Option.getOrNull(yield* providerSessionManager.get(providerSessionId));
            if (runtime === null) {
              return yield* new ProviderUploadFeedbackError({
                threadId: input.threadId,
                cause: "The provider session is no longer running. Send a message first.",
              });
            }
            if (runtime.uploadFeedback === undefined) {
              return yield* new ProviderUploadFeedbackError({
                threadId: input.threadId,
                cause: `Provider '${runtime.driver}' does not support feedback uploads.`,
              });
            }
            return yield* runtime.uploadFeedback({
              providerThread,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            });
          },
          (effect, input) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isProviderUploadFeedbackError(cause)
                  ? cause
                  : new ProviderUploadFeedbackError({
                      threadId: input.threadId,
                      cause,
                    }),
              ),
            ),
        ),
      [WS_METHODS.serverUpdateProvider]: (input) => providerMaintenanceRunner.updateProvider(input),
      [WS_METHODS.providerConsumeResetCredit]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* (input) {
          if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
          const instance = yield* providerInstances.getInstance(input.instanceId);
          if (instance === undefined || !instance.enabled) {
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "consume-reset-credit",
              detail: instance ? "This provider is disabled." : "Provider instance not found.",
            });
          }
          if (instance.consumeResetCredit === undefined) {
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "consume-reset-credit",
              detail: "This provider does not bank reset credits.",
            });
          }
          const outcome = yield* instance.consumeResetCredit(input.creditId).pipe(
            Effect.mapError(
              (error) =>
                new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: error.detail,
                  cause: error,
                }),
            ),
          );
          return { outcome };
        }),
      [WS_METHODS.providerAuthStart]: (input) => providerAuth.start(input, currentSessionId),
      [WS_METHODS.providerAuthRespond]: (input) =>
        Effect.annotateCurrentSpan({ instanceId: input.instanceId }).pipe(
          Effect.andThen(providerAuth.respond(input, currentSessionId)),
        ),
      [WS_METHODS.providerAuthComplete]: (input) => providerAuth.complete(input, currentSessionId),
      [WS_METHODS.chatGptReconnectProfile]: (input) => providerAuth.reconnectProfile(input),
      [WS_METHODS.chatGptImportProfile]: (input) => providerAuth.importProfile(input),
      [WS_METHODS.chatGptHandoffSubscribe]: (input) =>
        subscribeChatGptHandoff(input, currentSessionId),
      [WS_METHODS.providerAuthCancel]: (input) => providerAuth.cancel(input, currentSessionId),
      [WS_METHODS.providerAuthRemoveMethod]: (input) => providerAuth.removeMethod(input),
      [WS_METHODS.providerAuthLogout]: (input) => providerAuth.logout(input),
      [WS_METHODS.providerAuthSubscribe]: (input) =>
        providerAuth.subscribe(input, currentSessionId),
      [WS_METHODS.providerInstallStart]: (input) => providerInstallation.start(input),
      [WS_METHODS.providerInstallCancel]: (input) => providerInstallation.cancel(input),
      [WS_METHODS.providerInstallSubscribe]: (input) => providerInstallation.subscribe(input),
      [WS_METHODS.providerInstallRemove]: (input) => providerInstallation.remove(input),
      [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),
      [WS_METHODS.serverGetNpmRelease]: (input) => npmRelease.get(input),
      [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
        ServerSelfUpdate.updateProgressStream(serverSelfUpdate, input),
      [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
        serverSelfUpdate.commitDesktopUpdate(input.requestId),
      [WS_METHODS.serverUpsertKeybinding]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* (rule) {
          return yield* keybindings.upsertKeybindingRule(rule);
        }),
      [WS_METHODS.serverRemoveKeybinding]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* (rule) {
          return yield* keybindings.removeKeybindingRule(rule);
        }),
      [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
      [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
      [WS_METHODS.serverGetDatabaseStorage]: () => databaseStorage.status,
      [WS_METHODS.serverReclaimDatabaseSpace]: () => databaseStorage.requestReclaim,
      [WS_METHODS.serverGetSettings]: (_input) =>
        Effect.map(serverSettings.getSettings, (settings) =>
          ServerSettings.redactServerSettingsForClient(settings, settingsClient),
        ),
      [WS_METHODS.serverUpdateSettings]:
        /* Request instrumentation already owns the span; keep this helper in that context. */
        Effect.fnUntraced(function* ({ patch, providerInstanceMutation }) {
          const deviceHosts = patch.deviceHosts
            ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(Effect.provide(deviceHostContext))
            : undefined;
          const nextPatch = { ...patch, ...(deviceHosts ? { deviceHosts } : {}) };
          const settings = yield* providerInstanceMutation === undefined
            ? serverSettings.updateSettings(nextPatch)
            : serverSettings.updateProviderInstance(providerInstanceMutation, nextPatch);
          return ServerSettings.redactServerSettingsForClient(settings, settingsClient);
        }),
      [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
      [WS_METHODS.serverCheckSecretSource]: (input) => secretCheck.check(input.source),
      [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
        TraceDiagnostics.readTraceDiagnostics({
          traceFilePath: config.serverTracePath,
          maxFiles: config.traceMaxFiles,
        }),
      [WS_METHODS.serverGetProcessDiagnostics]: (_input) => processDiagnostics.read,
      [WS_METHODS.serverGetHostResources]: (_input) => hostResources.read,
      [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
        processResourceMonitor.readHistory(input),
      [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
        resourceTelemetry.readHistory(input),
      [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
      [WS_METHODS.serverRefreshUsageRates]: (_input) => usage.refreshRates,
      [WS_METHODS.serverRetryResourceTelemetry]: (_input) => resourceTelemetry.retry,
      [WS_METHODS.serverCheckOtlpEndpoint]: (input) => otlpEndpointCheck.check(input),
      [WS_METHODS.serverListTextGeneratorModels]: (input) => textGenerators.listModels(input),
      [WS_METHODS.serverPrepareTriage]: (input) => triage.prepare(input),
      [WS_METHODS.serverSignalProcess]: (input) => processDiagnostics.signal(input),
      [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
        Ref.update(rpcClientIds, (clientIds) => {
          const next = new Set(clientIds);
          next.add(RpcClientId.make(metadata.client.id));
          return next;
        }).pipe(
          Effect.andThen(
            backgroundPolicy.reportClientActivity(
              currentSessionId,
              RpcClientId.make(metadata.client.id),
              input,
            ),
          ),
        ),
      [WS_METHODS.cloudGetRelayClientStatus]: (_input) => relayClient.resolve,
      [WS_METHODS.cloudInstallRelayClient]: (_input) =>
        Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
          relayClient
            .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
            .pipe(
              Effect.flatMap((status) =>
                Queue.offer(queue, {
                  type: "complete",
                  status,
                }),
              ),
              Effect.catchTags({
                RelayClientInstallError: (error) =>
                  Queue.fail(
                    queue,
                    new RelayClientInstallFailedError({
                      reason: error.reason,
                      message: error.message,
                    }),
                  ),
              }),
              Effect.andThen(Queue.end(queue)),
              Effect.forkScoped,
            ),
        ),
      [WS_METHODS.subscribeServerConfig]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const usageLimitsCommand = input.usageLimitsCommand === true;
            const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
            // Only providers that can scan a cwd answer the client's on-demand catalog fetch.
            // Read per update, since a replaced instance can change that.
            const currentCatalogsPerCwd =
              workspaceSnapshotsOnDemand && input.providerCatalogsOnDemand === true
                ? providerInstances.listInstances.pipe(
                    Effect.map(
                      (instances) =>
                        new Set(
                          instances
                            .filter((instance) => instance.snapshotForCwd !== undefined)
                            .map((instance) => instance.instanceId),
                        ),
                    ),
                  )
                : Effect.succeed(new Set<string>());
            const catalogDigests = input.providerCatalogDigests === true;
            // Buffer changes through discovery and the initial snapshot's send.
            const keybindingsChanges = yield* keybindings.subscribeChanges;
            const settingsChanges = yield* serverSettings.subscribeChanges;
            const remoteTargets = yield* Effect.forkScoped(remoteOpenTargets.resolveTargets(), {
              startImmediately: true,
            });
            const directResult = yield* Effect.forkScoped(
              directEndpoints
                .resolve()
                .pipe(Effect.catchCause(() => directEndpoints.resolveAvailable())),
              { startImmediately: true },
            );
            const serverConfig = yield* loadServerConfig({
              usageLimitsCommand,
              workspaceSnapshotsOnDemand,
              deferNetworkDiscovery: true,
              catalogsPerCwd: yield* currentCatalogsPerCwd,
              catalogDigests,
            });
            const keybindingsUpdates = keybindingsChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  keybindings: event.keybindings,
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = Stream.zipLatestWith(
              // Seed the changes-only stream so early source refreshes pair with current providers.
              Stream.concat(
                Stream.fromEffect(providerRegistry.getProviders),
                providerRegistry.streamChanges,
              ),
              usageLimitSources.streamChanges.pipe(
                Stream.changesWith(usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true),
              ),
              (providers, sources) =>
                usageLimitsCommand ? withUsageLimitsCommands(providers, sources) : providers,
            ).pipe(
              // Stripped before the de-dupe below, so snapshot-only changes send nothing.
              Stream.mapEffect((commandProviders) =>
                workspaceSnapshotsOnDemand
                  ? currentCatalogsPerCwd.pipe(
                      Effect.map((catalogsPerCwd) =>
                        withoutWorkspaceSnapshots(commandProviders, catalogsPerCwd, catalogDigests),
                      ),
                    )
                  : Effect.succeed(commandProviders),
              ),
              // Compare initial paired values with the snapshot; blindly dropping them loses changes between snapshot and subscription.
              (updates) => Stream.concat(rpcInitialItems([serverConfig.providers]), updates),
              Stream.changesWith(
                (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
              ),
              Stream.drop(1),
              Stream.map((providers) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers },
              })),
              Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
            );
            // Gate capability-specific events; older clients reject them and lose their config subscription.
            const environmentThemeUpdates =
              input.environmentThemes === true
                ? environmentTheme.streamChanges.pipe(
                    Stream.map((themes) => ({
                      version: 1 as const,
                      type: "environmentThemesUpdated" as const,
                      payload: { themes },
                    })),
                  )
                : Stream.empty;
            const usageLimitSourceUpdates =
              input.usageLimitSources === true
                ? usageLimitSources.streamChanges.pipe(
                    Stream.map((sources) => ({
                      version: 1 as const,
                      type: "usageLimitSourcesUpdated" as const,
                      payload: { sources },
                    })),
                  )
                : Stream.empty;
            const settingsUpdates = settingsChanges.pipe(
              Stream.map((settings) =>
                ServerSettings.redactServerSettingsForClient(settings, settingsClient),
              ),
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );

            const liveUpdates = Stream.merge(
              keybindingsUpdates,
              Stream.merge(
                providerStatuses,
                Stream.merge(
                  settingsUpdates,
                  Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                ),
              ),
            );

            const remoteResult = yield* Effect.sync(() => remoteTargets.pollUnsafe());
            const initialConfig =
              remoteResult?._tag === "Success"
                ? { ...serverConfig, remoteOpenTargets: remoteResult.value }
                : serverConfig;
            const updates = withLateConfigDiscovery(
              initialConfig,
              liveUpdates,
              externalLauncher,
              {
                resolveTargets: () => Fiber.join(remoteTargets),
              },
              { resolve: () => Fiber.join(directResult) },
            );
            return Stream.concat(
              rpcInitialItems([
                { version: 1 as const, type: "snapshot" as const, config: initialConfig },
              ]),
              input.providerStatusDeltas === true
                ? updates.pipe(withProviderStatusDeltas(initialConfig.providers))
                : updates,
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
            yield* Effect.forkScoped(
              lifecycleEvents.stream.pipe(
                Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
              ),
              { startImmediately: true },
            );
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = Stream.fromQueue(liveBuffer).pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(rpcInitialItems(snapshotEvents), liveEvents);
          }),
        ),
      [WS_METHODS.subscribeAuthAccess]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const liveBuffer = yield* Queue.unbounded<
              PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
            >();
            // Each store subscribes only when consumed, so start both before the snapshot read.
            yield* Effect.forkScoped(
              Stream.runForEach(bootstrapCredentials.streamChanges, (change) =>
                Queue.offer(liveBuffer, change),
              ),
              { startImmediately: true },
            );
            yield* Effect.forkScoped(
              Stream.runForEach(sessions.streamChanges, (change) =>
                Queue.offer(liveBuffer, change),
              ),
              { startImmediately: true },
            );
            const initialSnapshot = yield* loadAuthAccessSnapshot();
            const revisionRef = yield* Ref.make(1);

            const liveEvents: Stream.Stream<AuthAccessStreamEvent, AuthAccessStreamError> =
              Stream.fromQueue(liveBuffer).pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.flatMap((revision) =>
                      // Device trust has no incremental event older clients could decode.
                      change.type === "connectDevicesChanged"
                        ? loadAuthAccessSnapshot().pipe(
                            Effect.map((payload): AuthAccessStreamEvent => ({
                              version: 1,
                              revision,
                              type: "snapshot",
                              payload,
                            })),
                          )
                        : Effect.succeed(
                            toAuthAccessStreamEvent(change, revision, currentSessionId),
                          ),
                    ),
                  ),
                ),
              );

            return Stream.concat(
              rpcInitialItems([
                {
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                },
              ]),
              liveEvents,
            );
          }),
        ),
      [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
        Stream.unwrap(
          Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
            Stream.concat(Stream.make(latest), changes),
          ),
        ),
    });

    return yield* ServerAndProviderWsRpcGroup.toHandlers(handlers);
  },
);
