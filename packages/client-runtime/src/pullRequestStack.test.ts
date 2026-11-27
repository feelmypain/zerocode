import { ProjectId, type PullRequestStack, type ThreadPullRequestLink } from "@zerocode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { savedPullRequestStack } from "./pullRequestStack.ts";

const reference = {
  projectId: ProjectId.make("project"),
  host: "github.com",
  repository: "acme/web",
  number: 2,
};

const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "acme/web",
  number: 2,
  url: "https://github.com/acme/web/pull/2",
  source: "manual",
  linkedAt: "2026-09-09T10:00:00Z",
  snapshot: {
    title: "Top layer",
    headBranch: "top",
    baseBranch: "bottom",
    state: "open",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-09-09T10:00:00Z",
  },
  stack: {
    kind: "native",
    id: "stack",
    number: 3,
    url: "https://github.com/acme/web/pull/3",
    base: "main",
    layers: [
      { number: 1, headBranch: "bottom", state: "open" },
      { number: 2, headBranch: "top", state: "open" },
    ],
  },
};

describe("savedPullRequestStack", () => {
  it("preserves all native layers, enriches linked titles, and strips kind and headSha", () => {
    const withRevision = {
      ...link,
      stack: {
        ...link.stack!,
        layers: [
          { number: 1, headBranch: "bottom", state: "open" as const, headSha: "sha-1" },
          { number: 2, headBranch: "top", state: "open" as const, headSha: "sha-2" },
        ],
      } as unknown as ThreadPullRequestLink["stack"],
    };
    const saved: PullRequestStack | null = savedPullRequestStack([withRevision], reference);
    expect(saved).toEqual({
      id: "stack",
      number: 3,
      url: "https://github.com/acme/web/pull/3",
      base: "main",
      layers: [
        { number: 1, headBranch: "bottom", state: "open" },
        { number: 2, headBranch: "top", state: "open", title: "Top layer", isDraft: false },
      ],
    });
    expect(saved?.layers.every((layer) => layer.headSha === undefined)).toBe(true);
    expect(savedPullRequestStack([link], { ...reference, number: 1 })?.number).toBe(3);
  });

  it("does not borrow stacks across hosts or repositories", () => {
    expect(savedPullRequestStack([link], { ...reference, host: "enterprise.example" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, repository: "other/web" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, host: undefined })).toBeNull();
  });

  it("honors a newer saved removal rather than reviving an old stack", () => {
    expect(
      savedPullRequestStack(
        [
          link,
          {
            ...link,
            stack: null,
            snapshot: { ...link.snapshot!, syncedAt: "2026-09-09T11:00:00Z" },
          },
        ],
        reference,
      ),
    ).toBeNull();
  });
});
