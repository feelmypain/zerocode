import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@zerocode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDER_ORDER,
  mergeAnsweredUsage,
  refreshableUsageEnvironmentIds,
  usageReportingState,
  usageWindowKey,
  type EnvironmentUsageStatus,
} from "./usageView.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const sinceDay = UsageDay.make("2026-05-01");
const untilDay = UsageDay.make("2026-05-07");

const sampleSummary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-05-07T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay,
  untilDay,
  buckets: [
    {
      day: sinceDay,
      provider: "codex",
      model: "gpt-5",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
      },
      costUsd: 0.01,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "host-a",
        provider: "codex",
        resolvedHomePath: "/home/dev/.codex",
        volumeId: "vol-1",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: {
    status: "fresh",
    source: "builtin",
    fetchedAt: null,
    knownModels: 1,
  },
  scanDurationMs: 1,
};

describe("usageView helpers", () => {
  it("exposes consistent provider order and labels and deterministic window keys", () => {
    expect(USAGE_PROVIDER_ORDER).toEqual(Object.keys(USAGE_PROVIDER_LABELS));
    const input: UsageSummaryInput = {
      sinceDay,
      untilDay,
      timeZone: "UTC",
      resolution: "day",
    };
    expect(usageWindowKey(input)).toBe(
      JSON.stringify({
        sinceDay: "2026-05-01",
        untilDay: "2026-05-07",
        timeZone: "UTC",
        resolution: "day",
        sinceTime: undefined,
        untilTime: undefined,
      }),
    );
  });

  it("computes reporting counts, pending/partial flags, refreshable ids, and merged usage", () => {
    const statuses: readonly EnvironmentUsageStatus[] = [
      {
        environmentId: envA,
        label: "Laptop",
        isPending: false,
        canReadDiagnostics: true,
        isConnected: true,
        error: null,
        summary: sampleSummary,
      },
      {
        environmentId: envB,
        label: "Server",
        isPending: true,
        canReadDiagnostics: true,
        isConnected: true,
        error: null,
        summary: null,
      },
    ];
    expect(usageReportingState(statuses)).toEqual({
      answeredCount: 1,
      stillReporting: 1,
      isPending: false,
      isPartial: true,
    });
    expect(usageReportingState([statuses[1]!])).toEqual({
      answeredCount: 0,
      stillReporting: 1,
      isPending: true,
      isPartial: false,
    });
    expect(refreshableUsageEnvironmentIds(statuses, (id) => id === envA)).toEqual([envA]);
    expect(mergeAnsweredUsage(statuses).contributingEnvironments).toEqual([envA]);
    expect(
      mergeAnsweredUsage(statuses, (bucket) => bucket.provider === "claude")
        .contributingEnvironments,
    ).toEqual([]);
  });
});
