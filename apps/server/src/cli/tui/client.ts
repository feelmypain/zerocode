// @effect-diagnostics nodeBuiltinImport:off - Needs node:crypto for command/entity IDs and node:child_process for spawning a quiet local server when none is running.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthGrantScope,
  CommandId,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ServerConfig,
} from "@zerocode/contracts";
import * as HostProcess from "@zerocode/shared/HostProcess";
import { reduceOrchestrationV2ThreadProjection } from "@zerocode/shared/orchestrationV2ProjectionReducer";
import {
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  joinSocketFrameParts,
} from "@zerocode/shared/socketFrameParts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfigService from "../../config.ts";
import { readLiveServerRuntimeState } from "../../serverRuntimeState.ts";

export class TuiConnectionError extends Schema.TaggedError<TuiConnectionError>()(
  "TuiConnectionError",
  {
    stage: Schema.Literals(["discover", "autostart", "auth", "websocket"]),
    origin: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const where = this.origin ? ` (${this.origin})` : "";
    return `ZeroCode CLI failed during ${this.stage}${where}: ${this.detail}`;
  }
}

export class TuiOperationError extends Schema.TaggedError<TuiOperationError>()(
  "TuiOperationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

const WsTicketResponse = Schema.Struct({
  ticket: Schema.String,
});
const decodeWsTicket = Schema.decodeUnknownEffect(WsTicketResponse);

const safeWebSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const makeWsClient = RpcClient.make(WsRpcGroup);
export type TuiRpcClient =
  typeof makeWsClient extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface TuiLiveConnection {
  readonly origin: string;
  readonly startedEmbeddedServer: boolean;
  readonly client: TuiRpcClient;
  readonly getInitialConfig: () => Effect.Effect<ServerConfig, TuiOperationError>;
  readonly ensureProject: (
    workspaceRoot: string,
    title: string,
  ) => Effect.Effect<ProjectId, TuiOperationError>;
  readonly launchThread: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly message: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly worktreeBaseRef?: string;
  }) => Effect.Effect<
    { readonly threadId: ThreadId; readonly projection: OrchestrationV2ThreadProjection },
    TuiOperationError
  >;
  readonly sendMessage: (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly modelSelection?: ModelSelection;
    readonly activeRunId: string | null;
  }) => Effect.Effect<void, TuiOperationError>;
  readonly interruptRun: (
    threadId: ThreadId,
    runId: string,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly stopThread: (threadId: ThreadId) => Effect.Effect<void, TuiOperationError>;
  readonly respondApproval: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly respondUserInput: (
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly setModelSelection: (
    threadId: ThreadId,
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly setRuntimeMode: (
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode,
  ) => Effect.Effect<void, TuiOperationError>;
  readonly getFullThreadDiff: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<string, TuiOperationError>;
}

function makeUuid(): string {
  return NodeCrypto.randomUUID();
}

function mapOperationError(operation: string) {
  return (cause: unknown) =>
    new TuiOperationError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

export function applyTextDeltaToProjection(
  projection: OrchestrationV2ThreadProjection,
  delta: {
    readonly target: "message" | "reasoning" | "proposed_plan";
    readonly id: string;
    readonly baseLength: number;
    readonly append: string;
  },
): OrchestrationV2ThreadProjection {
  if (delta.target === "message") {
    const messages = projection.messages.map((msg) =>
      msg.id === delta.id && msg.text.length === delta.baseLength
        ? { ...msg, text: msg.text + delta.append }
        : msg,
    );
    const visibleTurnItems = projection.visibleTurnItems.map((row) => {
      if (row.item.type === "assistant_message" && row.item.messageId === delta.id) {
        if (row.item.text.length === delta.baseLength) {
          return { ...row, item: { ...row.item, text: row.item.text + delta.append } };
        }
      }
      return row;
    });
    return { ...projection, messages, visibleTurnItems };
  }
  if (delta.target === "reasoning") {
    const visibleTurnItems = projection.visibleTurnItems.map((row) => {
      if (row.item.type === "reasoning" && row.item.id === delta.id) {
        if (row.item.text.length === delta.baseLength) {
          return { ...row, item: { ...row.item, text: row.item.text + delta.append } };
        }
      }
      return row;
    });
    return { ...projection, visibleTurnItems };
  }
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    if (row.item.type === "proposed_plan" && row.item.id === delta.id) {
      if (row.item.markdown.length === delta.baseLength) {
        return { ...row, item: { ...row.item, markdown: row.item.markdown + delta.append } };
      }
    }
    return row;
  });
  return { ...projection, visibleTurnItems };
}

export function applyThreadEventToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  return reduceOrchestrationV2ThreadProjection(projection, event, {
    applyThreadPullRequestLinkUpdate: (thread) => thread,
    visibleTurnItemsMode: "local-rebuild",
  }).projection;
}

function buildWebSocketUrl(origin: string, wsTicket: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", wsTicket);
  url.searchParams.set(SOCKET_FRAME_PARTS_QUERY_PARAM, "1");
  return url.toString();
}

const mintRemoteWsTicket = Effect.fn("cli.tui.mintRemoteWsTicket")(function* (
  origin: string,
  bearerToken: string,
) {
  const endpoint = new URL("/api/auth/websocket-ticket/rpc", origin).toString();
  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(bearerToken),
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* http.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new TuiConnectionError({
          stage: "auth",
          origin,
          detail: "Could not reach the remote server to mint a WebSocket ticket.",
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new TuiConnectionError({
      stage: "auth",
      origin,
      detail: `Server rejected authentication (HTTP ${response.status}). Check --token / ZEROCODE_TOKEN.`,
    });
  }
  const json = yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new TuiConnectionError({
          stage: "auth",
          origin,
          detail: "Invalid JSON from WebSocket ticket endpoint.",
          cause,
        }),
    ),
  );
  const decoded = yield* decodeWsTicket(json).pipe(
    Effect.mapError(
      (cause) =>
        new TuiConnectionError({
          stage: "auth",
          origin,
          detail: "Unexpected WebSocket ticket response shape.",
          cause,
        }),
    ),
  );
  return decoded.ticket;
});

const spawnQuietLocalServer = Effect.fn("cli.tui.spawnQuietLocalServer")(function* (
  config: ServerConfigService.ServerConfig["Service"],
) {
  const isExe = yield* HostProcess.IsExecutable;
  const execPath = yield* HostProcess.ExecutablePath;
  const argv = yield* HostProcess.Arguments;
  const scriptArgs = isExe ? [] : [argv[1] ?? ""];
  const args = [
    ...scriptArgs,
    "serve",
    "--base-dir",
    config.baseDir,
    "--host",
    "127.0.0.1",
    "--log-level",
    "error",
  ];
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        NodeChildProcess.spawn(execPath, args, {
          cwd: config.cwd,
          stdio: "ignore",
          detached: false,
          env: { ...process.env, ZEROCODE_NO_BROWSER: "1" },
        }),
      catch: (cause) =>
        new TuiConnectionError({
          stage: "autostart",
          detail: "Failed to start local ZeroCode server process.",
          cause,
        }),
    }),
    (proc) =>
      Effect.sync(() => {
        if (!proc.killed && proc.exitCode === null) {
          proc.kill("SIGTERM");
        }
      }),
  );

  // Poll serverRuntimeStatePath until the spawned server publishes its listening origin.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) {
      return yield* new TuiConnectionError({
        stage: "autostart",
        detail: `Local ZeroCode server exited unexpectedly with code ${child.exitCode}.`,
      });
    }
    const state = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isSome(state)) {
      return state.value.origin;
    }
    yield* Effect.sleep(Duration.millis(100));
  }
  return yield* new TuiConnectionError({
    stage: "autostart",
    detail: "Timed out waiting for local ZeroCode server to start.",
  });
});

export const connectTuiServer = Effect.fn("cli.tui.connectServer")(function* (input: {
  readonly serverConfig: ServerConfigService.ServerConfig["Service"];
  readonly remoteUrl: Option.Option<string>;
  readonly remoteToken: Option.Option<string>;
  readonly autoStartLocal: boolean;
}) {
  let origin: string;
  let wsTicket: string;
  let startedEmbeddedServer = false;

  if (Option.isSome(input.remoteUrl)) {
    origin = input.remoteUrl.value.replace(/\/+$/, "");
    const token = Option.getOrElse(
      input.remoteToken,
      () => process.env.ZEROCODE_TOKEN?.trim() ?? "",
    );
    if (!token) {
      return yield* new TuiConnectionError({
        stage: "auth",
        origin,
        detail: "Connecting to a remote --url requires --token or ZEROCODE_TOKEN.",
      });
    }
    wsTicket = yield* mintRemoteWsTicket(origin, token).pipe(Effect.provide(FetchHttpClient.layer));
  } else {
    const existing = yield* readLiveServerRuntimeState(input.serverConfig.serverRuntimeStatePath);
    if (Option.isSome(existing)) {
      origin = existing.value.origin;
    } else if (input.autoStartLocal) {
      origin = yield* spawnQuietLocalServer(input.serverConfig);
      startedEmbeddedServer = true;
    } else {
      return yield* new TuiConnectionError({
        stage: "discover",
        detail: `No running ZeroCode server in ${input.serverConfig.baseDir}. Run \`zerocode up\` or allow autostart.`,
      });
    }

    const authRuntime = EnvironmentAuth.layerRuntime.pipe(
      Layer.provide(ServerConfigService.layer(input.serverConfig)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
    );
    wsTicket = yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* Effect.acquireRelease(
        environmentAuth.issueSession({
          scopes: [...AuthGrantScope.literals],
          subject: "cli",
          label: "zerocode cli tui",
          ttl: Duration.hours(24),
        }),
        ({ sessionId }) => environmentAuth.revokeSession(sessionId).pipe(Effect.ignore),
      );
      const ticket = yield* environmentAuth.issueWebSocketTicket(
        { sessionId: issued.sessionId },
        { use: "rpc" },
      );
      return Redacted.value(ticket.ticket);
    }).pipe(
      Effect.provide(authRuntime),
      Effect.mapError(
        (cause) =>
          new TuiConnectionError({
            stage: "auth",
            origin,
            detail: "Failed to authenticate with local ZeroCode server.",
            cause,
          }),
      ),
    );
  }

  const socketUrl = buildWebSocketUrl(origin, wsTicket);
  const layerSocket = Layer.effect(
    Socket.Socket,
    Effect.map(Effect.service(Socket.Socket), joinSocketFrameParts),
  ).pipe(
    Layer.provide(Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" })),
    Layer.provide(safeWebSocketConstructor),
  );
  const layerProtocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      pingTimeout: "15 seconds",
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(Layer.provide(Layer.mergeAll(layerSocket, RpcSerialization.layerJson)));

  const protocolContext = yield* Layer.build(layerProtocol).pipe(
    Effect.mapError(
      (cause) =>
        new TuiConnectionError({
          stage: "websocket",
          origin,
          detail: "Failed to open WebSocket RPC connection.",
          cause,
        }),
    ),
  );
  const client = yield* makeWsClient.pipe(Effect.provide(protocolContext));

  const ensureProject = Effect.fn("cli.tui.ensureProject")(function* (
    workspaceRoot: string,
    title: string,
  ) {
    const projectId = ProjectId.make(makeUuid());
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: CommandId.make(makeUuid()),
      projectId,
      title,
      workspaceRoot,
    }).pipe(Effect.mapError(mapOperationError("create project")));
    return projectId;
  });

  const connection: TuiLiveConnection = {
    origin,
    startedEmbeddedServer,
    client,
    getInitialConfig: () =>
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapOperationError("load server config")),
      ),
    ensureProject,
    launchThread: (params) => {
      const payload: OrchestrationV2ThreadLaunchInput = {
        commandId: CommandId.make(makeUuid()),
        projectId: params.projectId,
        title: params.title,
        generateTitle: true,
        modelSelection: params.modelSelection,
        runtimeMode: params.runtimeMode,
        interactionMode: params.interactionMode,
        workspaceStrategy: params.worktreeBaseRef
          ? { type: "worktree", baseRef: params.worktreeBaseRef }
          : { type: "root" },
        initialMessage: {
          messageId: MessageId.make(makeUuid()),
          text: params.message,
          attachments: [],
        },
      };
      return client[ORCHESTRATION_V2_WS_METHODS.launchThread](payload).pipe(
        Effect.map((result) => ({ threadId: result.threadId, projection: result.projection })),
        Effect.mapError(mapOperationError("launch thread")),
      );
    },
    sendMessage: (params) => {
      const command: OrchestrationV2Command = {
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        commandId: CommandId.make(makeUuid()),
        threadId: params.threadId,
        messageId: MessageId.make(makeUuid()),
        text: params.text,
        attachments: [],
        ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
        dispatchMode:
          params.activeRunId !== null
            ? { type: "queue_after_active" }
            : { type: "start_immediately" },
      };
      return client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command).pipe(
        Effect.asVoid,
        Effect.mapError(mapOperationError("send message")),
      );
    },
    interruptRun: (threadId, runId) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "run.interrupt",
        commandId: CommandId.make(makeUuid()),
        threadId,
        runId: runId as never,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("interrupt run"))),
    stopThread: (threadId) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.stop",
        commandId: CommandId.make(makeUuid()),
        threadId,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("stop thread"))),
    respondApproval: (threadId, requestId, decision) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "runtime-request.respond",
        commandId: CommandId.make(makeUuid()),
        threadId,
        requestId: RuntimeRequestId.make(requestId),
        decision,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("respond approval"))),
    respondUserInput: (threadId, requestId, answers) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "runtime-request.respond",
        commandId: CommandId.make(makeUuid()),
        threadId,
        requestId: RuntimeRequestId.make(requestId),
        answers,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("respond question"))),
    setModelSelection: (threadId, modelSelection) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.model-selection.set",
        commandId: CommandId.make(makeUuid()),
        threadId,
        modelSelection,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("set model"))),
    setRuntimeMode: (threadId, runtimeMode) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(makeUuid()),
        threadId,
        runtimeMode,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("set runtime mode"))),
    setInteractionMode: (threadId, interactionMode) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(makeUuid()),
        threadId,
        interactionMode,
      }).pipe(Effect.asVoid, Effect.mapError(mapOperationError("set interaction mode"))),
    getFullThreadDiff: (threadId, toTurnCount) =>
      client[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
        threadId,
        toTurnCount: Math.max(0, toTurnCount),
      }).pipe(
        Effect.map((result) => {
          const parts: Array<string> = [];
          if (result.diff.trim().length > 0) parts.push(result.diff);
          for (const repo of result.repositories ?? []) {
            if (repo.diff.trim().length > 0) {
              parts.push(`# ${repo.name} (${repo.relativePath})\n${repo.diff}`);
            }
          }
          return parts.join("\n\n");
        }),
        Effect.mapError(mapOperationError("load thread diff")),
      ),
  };

  return connection;
});

/** Runs a live shell stream in a scoped child fiber and invokes callbacks on updates. */
export const forkShellSubscription = (
  client: TuiRpcClient,
  callbacks: {
    readonly onSnapshot: (
      projects: ReadonlyArray<OrchestrationProjectShell>,
      threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    ) => void;
    readonly onProjectUpdated: (project: OrchestrationProjectShell) => void;
    readonly onProjectRemoved: (projectId: string) => void;
    readonly onThreadUpdated: (thread: OrchestrationV2ThreadShell) => void;
    readonly onThreadRemoved: (threadId: string) => void;
    readonly onDisconnect: (reason: string) => void;
  },
): Effect.Effect<Fiber.Fiber<void, never>, never, Scope.Scope> =>
  client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.runForEach((item) =>
      Effect.sync(() => {
        switch (item.kind) {
          case "snapshot":
            callbacks.onSnapshot(item.snapshot.projects, item.snapshot.threads);
            break;
          case "project.updated":
            callbacks.onProjectUpdated(item.project);
            break;
          case "project.removed":
            callbacks.onProjectRemoved(item.projectId);
            break;
          case "thread.updated":
            callbacks.onThreadUpdated(item.thread);
            break;
          case "thread.removed":
            callbacks.onThreadRemoved(item.threadId);
            break;
          default:
            break;
        }
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        callbacks.onDisconnect(error instanceof Error ? error.message : String(error));
      }),
    ),
    Effect.forkScoped,
  );
