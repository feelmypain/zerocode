import { describe, expect, it } from "vite-plus/test";

import {
  ZEROCODE_MCP_TOOL_NAMES,
  resolveZeroCodeMcpSummaryAction,
  resolveZeroCodeMcpToolDefinition,
  resolveZeroCodeMcpToolPresentation,
} from "./zeroCodeMcpToolPresentation.ts";

describe("resolveZeroCodeMcpToolPresentation", () => {
  it("recognizes every ZeroCode tool across provider prefixes and completion suffixes", () => {
    for (const tool of ZEROCODE_MCP_TOOL_NAMES) {
      const presentation = resolveZeroCodeMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__zerocode__",
        "mcp__zero_code__",
        "mcp__zero-code__",
        "Zero-code.",
        "zerocode.",
        "zerocode-direct.",
        "mcp__zerocode_direct__",
        "zero_code/",
        "zerocode:",
        "mcp_zerocode_",
        "ZeroCode ",
        "zerocode · ",
      ]) {
        expect(resolveZeroCodeMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveZeroCodeMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveZeroCodeMcpToolPresentation("zerocode-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveZeroCodeMcpToolPresentation("zerocode-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveZeroCodeMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveZeroCodeMcpToolDefinition("mcp__zerocode__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveZeroCodeMcpToolDefinition("preview_type")?.labels);
    expect(resolveZeroCodeMcpToolDefinition("zerocode_thread_transfer", { action: "fork" })?.displayName).toBe(
      resolveZeroCodeMcpToolDefinition("zerocode_thread_fork")?.displayName,
    );
    expect(resolveZeroCodeMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveZeroCodeMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveZeroCodeMcpSummaryAction("mcp__zerocode__zerocode_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveZeroCodeMcpSummaryAction("zerocode_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveZeroCodeMcpSummaryAction("zerocode_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveZeroCodeMcpSummaryAction("zerocode_thread_configure", {})).toBe("thread-configuration");
    expect(resolveZeroCodeMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveZeroCodeMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
