import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@zerocode/client-runtime/environment";
import type {
  ResponseContextRecord,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@zerocode/contracts";
import { assistantCitationLabel } from "@zerocode/shared/assistantCitations";
import { T, useGT, useMessages, Var } from "gt-react";
import { BuildingIcon, ReplyIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { readThreadShell } from "~/state/entities";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import type { PendingUserInput } from "../../session-logic";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { HELD_COMPOSER_SEND_BANNER_ID } from "./ComposerHeldSendBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { runtimeModeConfig } from "./runtimeModeConfig";

interface ChatComposerBannerDockProps {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly routeThreadRef: ScopedThreadRef;
  readonly gitCwd: string | null;
  readonly canOperateThread: boolean;
  readonly bannerItems: readonly ComposerBannerStackItem[];
  readonly replyTo: ResponseContextRecord | null;
  readonly hasActivePendingProgress: boolean;
  readonly runtimeModeCeilingDenial: string | undefined;
  readonly runtimeModeCeilingFallback: RuntimeMode | undefined;
  readonly handleRuntimeModeChange: (mode: RuntimeMode) => void;
  readonly pendingUserInputs: PendingUserInput[];
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingIsResponding: boolean;
  readonly respondingRequestIds: RuntimeRequestId[];
  readonly activePendingDraftAnswers: ComponentProps<
    typeof ComposerPendingUserInputPanel
  >["answers"];
  readonly activePendingQuestionIndex: number;
  readonly onSelectActivePendingUserInputOption: (questionId: string, optionValue: string) => void;
  readonly onAdvanceActivePendingUserInput: () => void;
  readonly onDismissActivePendingUserInput: (requestId: RuntimeRequestId) => void;
  readonly stashCount: number;
  readonly isStashMenuOpen: boolean;
  readonly stashPulseKey: number;
  readonly onToggleStashMenu: () => void;
}

export function ChatComposerBannerDock(props: ChatComposerBannerDockProps) {
  const {
    composerDraftTarget,
    routeThreadRef,
    gitCwd,
    canOperateThread,
    bannerItems: incomingBannerItems,
    replyTo,
    hasActivePendingProgress,
    runtimeModeCeilingDenial,
    runtimeModeCeilingFallback,
    handleRuntimeModeChange,
    pendingUserInputs,
    activePendingUserInput,
    activePendingIsResponding,
    respondingRequestIds,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    stashCount,
    isStashMenuOpen,
    stashPulseKey,
    onToggleStashMenu,
  } = props;
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const setComposerDraftReplyTo = useComposerDraftStore((store) => store.setReplyTo);

  const hasBlockingComposerTopDrawer = pendingUserInputs.length > 0;
  const showComposerTopDrawer = pendingUserInputs.length > 0;

  const replyBannerItems: readonly ComposerBannerStackItem[] = replyTo
    ? [
        {
          id: "reply-to",
          variant: "default",
          icon: <ReplyIcon />,
          title: replyTo.subagents
            ? gt("Replying to {titles}", {
                titles: replyTo.subagents.map((subagent) => subagent.title).join(", "),
              })
            : gt("Replying to", {
                $context: "banner title; the message being replied to follows",
              }),
          description: (
            <button
              type="button"
              className="cursor-pointer hover:text-foreground"
              onClick={() => {
                const { citation } = replyTo;
                const source = readThreadShell(
                  scopeThreadRef(citation.environmentId, citation.threadId),
                );
                void navigate(assistantCitationNavigation(citation, source));
              }}
            >
              {assistantCitationLabel(replyTo.citation)}
            </button>
          ),
          dismissLabel: gt("Cancel reply"),
          onDismiss: () => setComposerDraftReplyTo(composerDraftTarget, null),
        },
      ]
    : [];

  const bannerItems: readonly ComposerBannerStackItem[] =
    runtimeModeCeilingDenial === undefined || hasActivePendingProgress
      ? [...incomingBannerItems, ...replyBannerItems]
      : [
          ...incomingBannerItems,
          ...replyBannerItems,
          {
            id: "managed-runtime-mode",
            variant: "warning",
            icon: <BuildingIcon />,
            title: runtimeModeCeilingDenial,
            ...(runtimeModeCeilingFallback === undefined
              ? {}
              : {
                  actions: (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleRuntimeModeChange(runtimeModeCeilingFallback)}
                    >
                      <T>
                        Switch to{" "}
                        <Var>{m(runtimeModeConfig[runtimeModeCeilingFallback].label)}</Var>
                      </T>
                    </Button>
                  ),
                }),
          },
        ];

  // An open question owns the space above the composer. Only a machine problem,
  // which is why an answer could not go through, stays beside it.
  const shelfItems = hasBlockingComposerTopDrawer
    ? bannerItems.filter(
        (item) =>
          item.id === HELD_COMPOSER_SEND_BANNER_ID ||
          (item.group === "environment" &&
            (item.variant === "error" || item.variant === "warning")),
      )
    : bannerItems;

  return (
    <ComposerBanner.Dock>
      <ComposerBanner.Column>
        <ComposerBannerStack items={shelfItems} />
        {showComposerTopDrawer ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
              {pendingUserInputs.length > 0 ? (
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  cwd={gitCwd ?? undefined}
                  threadRef={routeThreadRef}
                  disabled={!canOperateThread}
                  respondingRequestIds={
                    activePendingIsResponding && activePendingUserInput
                      ? [...respondingRequestIds, activePendingUserInput.requestId]
                      : respondingRequestIds
                  }
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                  onDismiss={onDismissActivePendingUserInput}
                />
              ) : null}
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
      </ComposerBanner.Column>
      <ComposerStashBadge
        count={stashCount}
        menuOpen={isStashMenuOpen}
        pulseKey={stashPulseKey}
        onToggleMenu={onToggleStashMenu}
      />
    </ComposerBanner.Dock>
  );
}
