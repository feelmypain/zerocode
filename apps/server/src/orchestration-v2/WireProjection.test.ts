import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  ContextHandoffId,
  ProviderSessionId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "@zerocode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { coalesceLiveUpdatedEvents } from "./ThreadLiveEventCoalescer.ts";
import {
  makeLiveBodyDeduper,
  makeLiveTextDeltaEncoder,
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
  projectStoredEventForWire,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import { MAX_TOOL_OUTPUT_IMAGES, toolOutputImages } from "@zerocode/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });

    const boundary = projectTurnItemForWire({
      ...base,
      input: { text: "a".repeat(149) + "😀" + "b".repeat(17_000) },
    });
    expect(boundary.type === "dynamic_tool" ? boundary.input : null).toEqual({
      summary: '{"text":"' + "a".repeat(149) + "…",
      truncated: true,
    });
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const marker = "\n… output truncated for transport";
    const prefixBytes = 32_768 - Buffer.byteLength(marker);
    const progress = "a".repeat(prefixBytes - 1) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "漢".repeat(12_000),
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(
      Buffer.byteLength(projected.type === "subagent" ? projected.prompt : ""),
    ).toBeLessThanOrEqual(32_768);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(prefixBytes - 1) + marker,
    );
    expect(item.progress).toBe(progress);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__zerocode__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item)).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);

    const zerocodeMcpApp = {
      attachmentId: "app-html",
      server: "repro",
      tool: "chart",
      resourceUri: "ui://repro/chart",
    };
    const text = { type: "text", text: "Rendered chart" };
    const appItem = {
      ...item,
      toolName: "repro.chart",
      output: {
        zerocodeMcpApp,
        result: { content: [text, { type: "image", mimeType: "image/png", data }] },
      },
    };
    expect(projectTurnItemForDetail(appItem)).toMatchObject({
      output: {
        zerocodeMcpApp,
        result: { content: [text, { type: "image", mimeType: "image/png" }] },
      },
    });
    const largeOutput = projectTurnItemForDetail(appItem);
    expect(
      JSON.stringify(largeOutput.type === "dynamic_tool" ? largeOutput.output : null),
    ).not.toContain(data);

    const smallApp = {
      zerocodeMcpApp,
      result: { content: [text, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
    };
    expect(projectTurnItemForDetail({ ...appItem, output: smallApp })).toMatchObject({
      output: smallApp,
    });

    const forged = projectTurnItemForDetail({
      ...appItem,
      output: {
        zerocodeMcpApp: { ...zerocodeMcpApp, resourceUri: data },
        result: { content: [text] },
      },
    });
    expect(
      JSON.stringify(forged.type === "dynamic_tool" ? forged.output : null).length,
    ).toBeLessThan(270_000);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item);
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output: %s", (output) => {
    const projected = projectTurnItemForWire({
      ...base,
      type: "command_execution" as const,
      input: "rg -n error logs fixtures",
      output,
      exitCode: 0,
    });
    expect(projected).not.toHaveProperty("outputIndicatesFailure");
    expect(projected).toMatchObject({ exitCode: 0, outputOmitted: true });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    expect(projectTurnItemForDetail(item)).toMatchObject({ diffStr: "+new code" });
    expect(projectTurnItemForDetail(item)).not.toHaveProperty("oldStr");
    expect(projectTurnItemForDetail(item)).not.toHaveProperty("newStr");
    const { diffStr: _diff, ...contentOnly } = item;
    expect(projectTurnItemForDetail(contentOnly)).toMatchObject({
      oldStr: "old code",
      newStr: "new code",
    });
    expect(projectTurnItemForWire(contentOnly)).not.toHaveProperty("newStr");
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("shares one wire projection per stored event", () => {
    const tool: OrchestrationV2StoredEvent = {
      sequence: 1,
      commandId: null,
      event: {
        id: EventId.make("shared-tool-event"),
        type: "turn-item.updated",
        threadId: base.threadId,
        occurredAt: base.updatedAt,
        payload: { ...base, output: { content: [{ type: "text", text: "PRIVATE_BODY" }] } },
      },
    };
    const projected = projectStoredEventForWire(tool);
    expect(projected).toEqual({ ...tool, event: projectDomainEventForWire(tool.event) });
    expect(projectStoredEventForWire(tool)).toBe(projected);
    const detached: OrchestrationV2StoredEvent = {
      sequence: 2,
      commandId: null,
      event: {
        id: EventId.make("detached-event"),
        type: "provider-session.detached",
        threadId: base.threadId,
        occurredAt: base.updatedAt,
        payload: {
          providerSessionId: ProviderSessionId.make("session"),
          detachedAt: base.updatedAt,
        },
      },
    };
    expect(projectStoredEventForWire(detached)).toBe(detached);
  });
});

describe("live body deduper", () => {
  const at = base.updatedAt;
  const messageId = MessageId.make("message-live");
  const event = (
    sequence: number,
    rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
  ): Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> => ({
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      threadId: base.threadId,
      occurredAt: at,
      ...rest,
    } as OrchestrationV2DomainEvent,
  });
  const message = (sequence: number, text: string) =>
    event(sequence, {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId: base.threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
  const reply = (sequence: number, text: string) =>
    event(sequence, {
      type: "turn-item.updated",
      payload: {
        ...base,
        status: "running",
        type: "assistant_message",
        messageId,
        text,
        streaming: true,
      },
    });
  const payloadOf = (item: OrchestrationV2ThreadStreamItem) =>
    item.kind === "event" ? item.event.payload : undefined;

  it("blanks a reply that repeats the message delivered before it, after coalescing", () => {
    const delivered = coalesceLiveUpdatedEvents([
      message(1, "a"),
      reply(2, "a"),
      message(3, "ab"),
      reply(4, "ab"),
    ]).map(makeLiveBodyDeduper());

    expect(
      delivered.map((item) => [item.kind === "event" && item.sequence, payloadOf(item)]),
    ).toEqual([
      [3, message(3, "ab").event.payload],
      [4, { ...reply(4, "ab").event.payload, text: "", textOmitted: true }],
    ]);
  });

  it("caps a large checkpoint's files for the wire and still dedupes its item", () => {
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `vendor/file-${index}.ts`,
      kind: "modified",
      additions: 2,
      deletions: 1,
    }));
    const checkpointId = CheckpointId.make("checkpoint-large");
    const scopeId = CheckpointScopeId.make("scope-large");
    const captured = event(1, {
      type: "checkpoint.captured",
      payload: {
        id: checkpointId,
        threadId: base.threadId,
        scopeId,
        runId: null,
        nodeId: NodeId.make("node-large"),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: null,
        ref: CheckpointRef.make("refs/zerocode/checkpoints/large"),
        status: "ready",
        files,
        capturedAt: at,
      },
    });
    const item = event(2, {
      type: "turn-item.updated",
      payload: { ...base, type: "checkpoint", checkpointId, scopeId, files },
    });
    const dedupe = makeLiveBodyDeduper();
    const [record, card] = [captured, item].map((streamed) =>
      dedupe({ ...streamed, event: projectDomainEventForWire(streamed.event) }),
    );

    const filesTotal = { count: 250, additions: 500, deletions: 250 };
    expect(payloadOf(record!)).toMatchObject({ files: files.slice(0, 200), filesTotal });
    expect(payloadOf(card!)).toMatchObject({ files: [], filesOmitted: true, filesTotal });
  });

  it("ships a reply whole when its message arrives after it", () => {
    const first = reply(1, "a");
    expect([first, message(2, "a")].map(makeLiveBodyDeduper())[0]).toBe(first);
  });
});

describe("live text delta encoder", () => {
  const at = base.updatedAt;
  const later = DateTime.add(at, { milliseconds: 50 });
  const messageId = MessageId.make("message-delta");
  const reasoningId = TurnItemId.make("reasoning-delta");
  const planItemId = TurnItemId.make("plan-item-delta");
  const event = (
    sequence: number,
    rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">,
  ): Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> => ({
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-delta-${sequence}`),
      threadId: base.threadId,
      occurredAt: at,
      ...rest,
    } as OrchestrationV2DomainEvent,
  });
  const message = (
    sequence: number,
    text: string,
    options?: { readonly streaming?: boolean; readonly updatedAt?: DateTime.Utc },
  ) =>
    event(sequence, {
      type: "message.updated",
      payload: {
        id: messageId,
        threadId: base.threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: options?.streaming ?? true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: options?.updatedAt ?? at,
      },
    });
  const reasoning = (
    sequence: number,
    text: string,
    options?: {
      readonly streaming?: boolean;
      readonly status?: "running" | "completed";
      readonly updatedAt?: DateTime.Utc;
    },
  ) =>
    event(sequence, {
      type: "turn-item.updated",
      payload: {
        ...base,
        id: reasoningId,
        type: "reasoning",
        status: options?.status ?? "running",
        text,
        streaming: options?.streaming ?? true,
        updatedAt: options?.updatedAt ?? at,
      },
    });
  const proposedPlan = (
    sequence: number,
    markdown: string,
    options?: { readonly streaming?: boolean; readonly updatedAt?: DateTime.Utc },
  ) =>
    event(sequence, {
      type: "turn-item.updated",
      payload: {
        ...base,
        id: planItemId,
        type: "proposed_plan",
        planId: "plan-1" as never,
        status: "running",
        markdown,
        streaming: options?.streaming ?? true,
        updatedAt: options?.updatedAt ?? at,
      },
    });

  it("emits text-delta for streaming appends and falls back to full events on edits or completion", () => {
    const encode = makeLiveTextDeltaEncoder();
    const initial = message(1, "Hello");
    const appended = message(2, "Hello world", { updatedAt: later });
    const rewritten = message(3, "Hi world", { updatedAt: later });
    const appendedAfterRewrite = message(4, "Hi world!", { updatedAt: later });
    const completed = message(5, "Hi world!!", { streaming: false, updatedAt: later });

    expect(encode(initial)).toBe(initial);
    expect(encode(appended)).toEqual({
      kind: "text-delta",
      sequence: 2,
      target: "message",
      id: messageId,
      baseLength: 5,
      append: " world",
      updatedAt: later,
    });
    expect(encode(rewritten)).toBe(rewritten);
    expect(encode(appendedAfterRewrite)).toEqual({
      kind: "text-delta",
      sequence: 4,
      target: "message",
      id: messageId,
      baseLength: 8,
      append: "!",
      updatedAt: later,
    });
    expect(encode(completed)).toBe(completed);
  });

  it("emits text-delta for streaming reasoning and proposed_plan items and falls back on status change", () => {
    const encode = makeLiveTextDeltaEncoder();
    const firstReasoning = reasoning(1, "Step 1");
    const nextReasoning = reasoning(2, "Step 1\nStep 2", { updatedAt: later });
    const statusChange = reasoning(3, "Step 1\nStep 2\nDone", {
      status: "completed",
      streaming: true,
      updatedAt: later,
    });
    const firstPlan = proposedPlan(4, "# Plan");
    const nextPlan = proposedPlan(5, "# Plan\n- Item 1", { updatedAt: later });

    expect(encode(firstReasoning)).toBe(firstReasoning);
    expect(encode(nextReasoning)).toEqual({
      kind: "text-delta",
      sequence: 2,
      target: "reasoning",
      id: reasoningId,
      baseLength: 6,
      append: "\nStep 2",
      updatedAt: later,
    });
    expect(encode(statusChange)).toBe(statusChange);
    expect(encode(firstPlan)).toBe(firstPlan);
    expect(encode(nextPlan)).toEqual({
      kind: "text-delta",
      sequence: 5,
      target: "proposed_plan",
      id: planItemId,
      baseLength: 6,
      append: "\n- Item 1",
      updatedAt: later,
    });
  });

  it("composes with makeLiveBodyDeduper so paired assistant_message items still omit text", () => {
    const dedupe = makeLiveBodyDeduper();
    const encodeDelta = makeLiveTextDeltaEncoder();
    const reply = (sequence: number, text: string) =>
      event(sequence, {
        type: "turn-item.updated",
        payload: {
          ...base,
          status: "running",
          type: "assistant_message",
          messageId,
          text,
          streaming: true,
        },
      });
    const out = [
      message(1, "Hello"),
      reply(2, "Hello"),
      message(3, "Hello world", { updatedAt: later }),
      reply(4, "Hello world"),
    ].map((item) => encodeDelta(dedupe(item)));

    expect(out[0]).toEqual(message(1, "Hello"));
    expect(out[1]?.kind === "event" ? out[1].event.payload : undefined).toMatchObject({
      text: "",
      textOmitted: true,
    });
    expect(out[2]).toEqual({
      kind: "text-delta",
      sequence: 3,
      target: "message",
      id: messageId,
      baseLength: 5,
      append: " world",
      updatedAt: later,
    });
    expect(out[3]?.kind === "event" ? out[3].event.payload : undefined).toMatchObject({
      text: "",
      textOmitted: true,
    });
  });
});
