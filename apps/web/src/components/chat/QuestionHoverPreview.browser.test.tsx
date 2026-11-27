import { EnvironmentId, RuntimeRequestId, ThreadId } from "@zerocode/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { QuestionHoverPreview } from "./QuestionHoverPreview";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const longHeader =
  "Authentication strategy and backwards compatibility details for migrated sessions";
const longQuestion =
  "Should the new desktop sign-in flow preserve existing local session tokens across restarts, or require users to re-authenticate when switching environments after upgrading?";

const longPrompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-hover-preview"),
  createdAt: "2026-11-27T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "auth-question",
      header: longHeader,
      question: longQuestion,
      options: [
        { label: "Preserve tokens", description: "Keep current session tokens" },
        { label: "Re-authenticate", description: "Prompt to sign in again" },
      ],
      multiSelect: false,
    },
  ],
};

it("reveals the full truncated header and collapsed question smoothly on hover", async () => {
  await using screen = await render(
    <div className="w-72 pt-44">
      <ComposerBanner.Root variant="info">
        <ComposerPendingUserInputPanel
          pendingUserInputs={[longPrompt]}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={vi.fn()}
          onAdvance={vi.fn()}
          onDismiss={vi.fn()}
        />
      </ComposerBanner.Root>
    </div>,
  );

  // Header truncates inside the narrow banner and opens the full preview on hover.
  await expect
    .poll(() => screen.container.querySelector("[data-question-truncated='true']"))
    .not.toBeNull();
  const headerTrigger = screen.container.querySelector("[data-question-truncated='true']")!;
  await userEvent.hover(headerTrigger);

  await expect
    .poll(() => document.querySelector("[data-question-hover-preview='true']")?.textContent?.trim())
    .toBe(longHeader);

  // Clicking the trigger collapses the banner and shows the truncated question preview.
  await userEvent.click(screen.getByTitle("Hide the question and its options"));

  await expect
    .poll(() => screen.container.querySelectorAll("[data-question-truncated='true']").length)
    .toBeGreaterThanOrEqual(2);
  const collapsedTriggers = screen.container.querySelectorAll("[data-question-truncated='true']");
  await userEvent.hover(collapsedTriggers[1]!);

  await expect
    .poll(() => document.querySelector("[data-question-hover-preview='true']")?.textContent?.trim())
    .toBe(longQuestion);
});

it("reveals a truncated timeline question row on hover", async () => {
  await using screen = await render(
    <div className="w-64 pt-44">
      <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
        <QuestionHoverPreview className="min-w-0 flex-1 truncate">
          {longQuestion}
        </QuestionHoverPreview>
      </p>
    </div>,
  );

  await expect
    .poll(() => screen.container.querySelector("[data-question-truncated='true']"))
    .not.toBeNull();
  await userEvent.hover(screen.container.querySelector("[data-question-truncated='true']")!);

  await expect
    .poll(() => document.querySelector("[data-question-hover-preview='true']")?.textContent?.trim())
    .toBe(longQuestion);
});

it("does not attach a hover preview when the question fits without truncation", async () => {
  await using screen = await render(
    <div className="w-96 pt-20">
      <QuestionHoverPreview className="block min-w-0 truncate">
        Short question?
      </QuestionHoverPreview>
    </div>,
  );

  expect(screen.container.querySelector("[data-question-truncated='true']")).toBeNull();
  await userEvent.hover(screen.getByText("Short question?"));
  expect(document.querySelector("[data-question-hover-preview='true']")).toBeNull();
});
