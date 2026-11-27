import { CollapsibleUserMessageBody } from "../CollapsibleUserMessageBody";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { toServerClock } from "@zerocode/client-runtime/clock";
import { formatDuration } from "@zerocode/shared/orchestrationTimingCopy";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import {
  idleCompactionOf,
  isOrchestrationV2WorkActive,
  ThreadId,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
} from "@zerocode/contracts";
import { useVisibleSecondClock } from "../use-visible-second-clock";
import { ThreadContextDivider } from "../thread-context-divider";
import { ThreadHandoffRow } from "../thread-handoff-row";
import { GuestBubbleTint, GuestMessageName } from "../guestMessageStyle";
import { ThreadGuestPendingMessage } from "../ThreadGuestShareBar";
import { LinkRequestCard } from "../LinkRequestCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import {
  WorktreeSetupCard,
  WorktreeSetupDetails,
  WorktreeSetupFoldChip,
  type WorktreeSetupCardProps,
} from "../worktree-setup-card";
import * as Haptics from "expo-haptics";
import type { LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@zerocode/client-runtime/environment";
import {
  IDLE_COMPACTING_LABELS,
  resolveUserMessageFileCards,
  resolveUserMessagePresentation,
} from "@zerocode/client-runtime/user-message";
import { canForkProjectedAssistantItem } from "@zerocode/client-runtime/state/thread-workflows";
import type { WorkflowOpening } from "@zerocode/client-runtime/state/subagentRuntime";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@zerocode/shared/promptLinks";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@zerocode/shared/composerContextReferences";
import { writeComposerContextClipboard } from "../../../lib/composerContextClipboard";
import type { CodexArtifactTemplate } from "@zerocode/shared/codexArtifactTemplates";
import { isAtomCommandInterrupted } from "@zerocode/client-runtime/state/runtime";
import { contextCompactionTokenCounts } from "@zerocode/client-runtime/work-log/presentation";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Image, Platform, Pressable, View, type ColorValue } from "react-native";
import { composerImageGallery } from "../../../lib/composerImageGallery";
import type { FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { hasWideMarkdownBlock } from "../../../lib/wideMarkdownBlocks";
import type {
  MarkdownImageRenderer,
  SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import { AppText as Text } from "../../../components/ui/AppText";
import { CopyTextButton } from "../CopyTextButton";
import { Menu } from "../../../components/ui/Menu";
import { copyPromptLink } from "../../prompt-links/prompt-link-actions";
import type { ReviewCommentColors } from "../../review/ReviewCommentCard";
import { cn } from "../../../lib/cn";
import type { deriveThreadWorkLogSizing } from "../../../lib/layout";
import { uuidv4 } from "../../../lib/uuid";
import {
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
} from "../../../lib/threadActivity";
import {
  useFeedRowExpanded,
  useFeedSetupDetailsOpen,
  type ThreadFeedInteractionStore,
} from "../thread-feed-interaction-store";
import type { ThreadWorkGroupScrollPosition } from "../thread-feed-scroll-position";
import {
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
} from "../thread-work-log";
import {
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import type { QueuedThreadMessage } from "../../../state/thread-outbox-model";
import { ThreadHtmlRender } from "../HtmlRenderWebView";
import { ThreadMcpApp } from "../McpAppWebView";
import { useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { threadEnvironment } from "../../../state/threads";
import { ThreadWorkflowOpening } from "../thread-workflow-opening";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useV2ItemSupport } from "../../../state/v2-item-support";
import { waitForThreadShell } from "../threadForkNavigation";
import { resolveUserMessageIntentBadge } from "../userMessageIntentBadge";
import { useOpenLinkedThread } from "../useOpenLinkedThread";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImageView,
} from "../ThreadMarkdownImage";
import { openSettings } from "../../settings/settings-navigation";
import { useSelectWorkspaceDetail } from "../../layout/workspace/useSelectWorkspaceDetail";
import type { PerfProbe } from "../../development/perf-probe-hooks";
import {
  MessageAttachmentFile,
  MessageAttachmentImage,
  MessageAttachmentList,
  MessageAttachmentUnknown,
  UserMessageMedia,
  isFileAttachment,
  isImageAttachment,
  isMediaAttachment,
} from "./ThreadFeedAttachments";
import {
  AssistantMarkdownContent,
  UserMessageContent,
  type MarkdownLinkHandlers,
  type MarkdownStyleSet,
  type MarkdownStyleSets,
} from "./ThreadFeedMarkdown";

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  // iOS blockquotes and selectable text measure separately; definite bubble width matches UIKit's drawing width.
  includeBlockquotes: Platform.OS === "ios",
  includeOrderedLists: Platform.OS === "android",
} as const;

const TURN_FOLD_HEIGHT = 42;
const VIEWED_IMAGE_GAP = 8;
const USER_BUBBLE_HORIZONTAL_PADDING = 3.5 * 3.5;
// Virtualization remounts old rows; only newly created content should replay an entrance.
const FRESH_ENTRY_WINDOW_MS = 3_000;

function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
  /** Loads earlier history down to the entry, in one request. */
  readonly onLoadThrough: (entryId: string) => void;
}

const USER_MESSAGE_COPY_MENU_ACTIONS = [
  { id: "copy-prompt-link", title: msg("Copy prompt link"), image: "link" },
];

function UserMessageCopyButton(props: {
  readonly text: string;
  readonly onCopy: (() => Promise<void>) | undefined;
  readonly tintColor: ColorValue;
}) {
  const gt = useGT();
  const m = useMessages();
  const button = (
    <CopyTextButton
      accessibilityLabel={gt("Copy message")}
      text={props.text}
      onCopy={props.onCopy}
      tintColor={props.tintColor}
      buttonSize={28}
      iconSize={13}
    />
  );
  const linkText = replaceComposerContextReferences(props.text, (reference) => reference.label);
  if (linkText.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return button;
  return (
    <Menu
      actions={USER_MESSAGE_COPY_MENU_ACTIONS.map((action) => ({
        ...action,
        title: m(action.title),
      }))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "copy-prompt-link") void copyPromptLink(linkText);
      }}
      shouldOpenOnLongPress
    >
      {button}
    </Menu>
  );
}

function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const gt = useGT();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const selectDetail = useSelectWorkspaceDetail();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Fork from this response")}
      disabled={busy}
      onPress={() => {
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (isAtomCommandInterrupted(result)) return;
            if (result._tag !== "Success") {
              Dialog.alert(
                gt("Could not confirm fork"),
                gt("Reconnect and check the thread list before trying again."),
              );
              return;
            }
            const targetThreadReady = await waitForThreadShell(
              scopeThreadRef(props.environmentId, targetThreadId),
            );
            if (!targetThreadReady) {
              Dialog.alert(
                gt("Fork created"),
                gt(
                  "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
                ),
              );
              return;
            }
            selectDetail({
              name: "Thread",
              params: { environmentId: props.environmentId, threadId: targetThreadId },
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={props.iconSize}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

/** Messages from other agents fold to one line so the user's own messages stay easy to find. */
function AgentMessageFoldHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId;
  /** A linked environment's sender title, for when this client cannot reach it. */
  readonly senderTitle?: string;
  readonly summary: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly iconSubtleColor: ColorValue;
}) {
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const gt = useGT();
  const label = senderShell?.title.trim() || props.senderTitle?.trim() || gt("Agent");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{label}: {summary}", { label, summary: props.summary })}
      accessibilityHint={
        props.expanded
          ? gt("Double tap to hide the message.")
          : gt("Double tap to show the message.")
      }
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={4}
      className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={14}
        weight="medium"
        tintColorClassName="accent-user-bubble-foreground-muted"
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className="max-w-[50%] shrink-0 font-zerocode-medium text-sm text-user-bubble-foreground-muted"
      >
        {label}
      </Text>
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
        {props.summary}
      </Text>
      <ThreadDisclosureChevron
        expanded={props.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconSubtleColor}
      />
    </Pressable>
  );
}

function OpenSenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId;
  /** In a linked environment, shown only when this client is connected to it. */
  readonly linked?: boolean;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const linkedEnvironment = useEnvironmentPresentation(props.linked ? props.environmentId : null);
  if (props.linked && linkedEnvironment.presentation === null) return null;
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(props.senderThreadId),
        })
      }
    >
      <Text className="font-zerocode-medium text-xs text-foreground-secondary">
        <T>Open thread</T>
      </Text>
    </Pressable>
  );
}

/** Automation prompts are long, repeated runbooks; a folded bubble keeps them out of the way. */
function ThreadAutomationMessageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  readonly timestampLabel: string;
  readonly interactionStore: ThreadFeedInteractionStore;
  readonly rowId: string;
  readonly onToggle: () => void;
  readonly bubbleColor: ColorValue;
  readonly bubbleMaxWidth: number | "85%";
  readonly contentMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const expanded = useFeedRowExpanded(props.interactionStore, props.rowId);
  const tasks = useEnvironmentQuery(
    props.scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const taskTitle = tasks.data?.tasks.find((task) => task.id === props.scheduledTaskId)?.title;
  const summary = taskTitle ?? props.text.trim().split(/\r?\n/, 1)[0] ?? "";

  return (
    <View className="mb-2 items-end">
      <View
        className="min-w-0 rounded-[20px]"
        style={{
          backgroundColor: props.bubbleColor,
          maxWidth: props.bubbleMaxWidth,
          ...(expanded ? { width: props.bubbleMaxWidth } : null),
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Automation: {summary}", { summary })}
          accessibilityHint={
            expanded ? gt("Double tap to hide the prompt.") : gt("Double tap to show the prompt.")
          }
          accessibilityState={{ expanded }}
          hitSlop={4}
          className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
          onPress={() => {
            void Haptics.selectionAsync();
            props.onToggle();
          }}
        >
          <SymbolView
            name="calendar.badge.clock"
            size={14}
            weight="medium"
            tintColorClassName="accent-user-bubble-foreground-muted"
            type="monochrome"
          />
          <Text className="font-zerocode-medium text-sm text-user-bubble-foreground-muted">
            <T>Automation</T>
          </Text>
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
            {summary}
          </Text>
          <ThreadDisclosureChevron
            expanded={expanded}
            collapsedDirection="down"
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
        {expanded ? (
          <View className="px-3.5 pb-2.5">
            <MarkdownImageAvailableWidthContext value={props.contentMaxWidth}>
              <UserMessageContent
                text={props.text}
                environmentId={props.environmentId}
                context={props.context}
                markdownStyles={props.markdownStyles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                linkHandlers={props.linkHandlers}
                renderImage={props.renderImage}
              />
            </MarkdownImageAvailableWidthContext>
          </View>
        ) : null}
      </View>
      {expanded ? (
        <View className="mt-1 flex-row items-center justify-end gap-2 pr-0.5">
          {props.scheduledTaskId ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={6}
              onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
            >
              <Text className="font-zerocode-medium text-xs text-foreground-secondary">
                <T>Open automation</T>
              </Text>
            </Pressable>
          ) : null}
          <Text className="font-zerocode-medium text-xs tabular-nums text-foreground-secondary">
            {props.timestampLabel}
          </Text>
          <UserMessageCopyButton
            text={props.text}
            onCopy={undefined}
            tintColor={props.iconSubtleColor}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Leads with why ZeroCode compacted, when it did so without being asked. */
function compactionLabel(
  label: string,
  title: string | undefined,
  item: OrchestrationV2ProjectedTurnItem["item"],
  m: ReturnType<typeof useMessages>,
) {
  const compacted =
    item.type === "compaction" &&
    item.status !== "failed" &&
    item.status !== "cancelled" &&
    item.status !== "interrupted" &&
    !isOrchestrationV2WorkActive(item.status);
  const tokens = compacted ? contextCompactionTokenCounts(item) : null;
  const text =
    title === undefined || !compacted
      ? label
      : tokens
        ? m(msg("{title} {before} → {after} tokens", { title, ...tokens }))
        : title;
  // Non-breaking spaces keep "549K → 16.8K tokens" on one line when the label wraps.
  return text.replace(/ (→|tokens)/g, "\u00A0$1").replace(/→ /g, "→\u00A0");
}

function RunFoldWorking(props: {
  environmentId: EnvironmentId;
  startedAt: string;
  rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
}) {
  const nowMs = toServerClock(props.environmentId, useVisibleSecondClock(true));
  const seconds = Math.floor((nowMs - Date.parse(props.startedAt)) / 1_000);
  const gt = useGT();
  const messages = useMessages();
  return (
    <View
      className="min-h-11 min-w-0 flex-1 flex-row items-center"
      style={{ minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, props.rowSizing.estimatedRowHeight) }}
    >
      <Text
        key={props.rowSizing.textSizeKey}
        numberOfLines={1}
        className="shrink font-zerocode-medium text-sm tabular-nums text-foreground-muted"
      >
        {gt("Working for {duration}", {
          duration:
            seconds > 0
              ? formatDuration(seconds * 1_000, messages)
              : gt("{seconds}s", { seconds: 0 }),
        })}
      </Text>
    </View>
  );
}

function RunFoldButton({
  entry,
  environmentId,
  threadId,
  onToggle,
  rowSizing,
  iconColor,
}: {
  entry: Extract<ThreadFeedEntry, { type: "run-fold" }>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onToggle: (runId: RunId) => void;
  rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  iconColor: ColorValue;
}) {
  const gt = useGT();
  const loadWork = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const anchorsKey = entry.deferredWorkItemIds?.join("\n") ?? "";
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!anchorsKey) return;
    void Promise.all(
      anchorsKey
        .split("\n")
        .map((workAnchorId) => loadWork({ environmentId, input: { threadId, workAnchorId } })),
    ).then((results) =>
      setFailed(
        results.some((result) => result._tag === "Failure" || result.value._tag === "error"),
      ),
    );
  };
  const loadOnExpand = useEffectEvent(load);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- Restored expanded folds load their deferred server history on mount.
  useEffect(() => {
    if (entry.expanded && anchorsKey && environmentId && threadId) loadOnExpand();
  }, [entry.expanded, anchorsKey, environmentId, threadId]);
  const error = anchorsKey && failed ? gt("Couldn't load work. Tap to retry.") : null;
  const loading = entry.expanded && anchorsKey !== "" && !failed;
  const toggle = () => {
    setFailed(false);
    if (error && entry.expanded) load();
    else onToggle(entry.runId);
  };

  return (
    <View className="min-w-0 flex-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded, busy: loading }}
        onPress={toggle}
        hitSlop={4}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
        style={{ minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, rowSizing.estimatedRowHeight) }}
      >
        <Text
          key={rowSizing.textSizeKey}
          numberOfLines={1}
          className="shrink font-zerocode-medium text-sm tabular-nums text-foreground-muted"
        >
          {entry.label}
          {error ? ` · ${error}` : ""}
        </Text>
        <ThreadDisclosureChevron
          expanded={entry.expanded}
          collapsedDirection="right"
          size={15}
          tintColor={iconColor}
        />
      </Pressable>
      {loading ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          className="gap-2 px-1 pb-2"
        >
          {(["40%", "60%", "33%"] as const).map((width) => (
            <View key={width} className="flex-row items-center gap-2">
              <View className="size-3 rounded bg-subtle-strong" />
              <View className="h-2.5 rounded-full bg-subtle-strong" style={{ width }} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function FeedWorktreeSetupCard(
  props: WorktreeSetupCardProps & {
    readonly threadId: ThreadId;
    readonly interactionStore: ThreadFeedInteractionStore;
    readonly onOpenDetails: () => void;
  },
) {
  const { threadId, interactionStore, onOpenDetails, ...setupProps } = props;
  const detailsOpen = useFeedSetupDetailsOpen(interactionStore, threadId, true);
  return (
    <WorktreeSetupCard {...setupProps} detailsOpen={detailsOpen} onOpenDetails={onOpenDetails} />
  );
}

function FeedWorktreeSetupFoldChip(
  props: WorktreeSetupCardProps & {
    readonly threadId: ThreadId;
    readonly interactionStore: ThreadFeedInteractionStore;
    readonly onOpenDetails: () => void;
  },
) {
  const { threadId, interactionStore, onOpenDetails, ...setupProps } = props;
  const detailsOpen = useFeedSetupDetailsOpen(interactionStore, threadId, true);
  return (
    <WorktreeSetupFoldChip
      {...setupProps}
      detailsOpen={detailsOpen}
      onOpenDetails={onOpenDetails}
    />
  );
}

export function FeedWorktreeSetupDetails(props: {
  readonly worktreeSetup: WorktreeSetupCardProps | null | undefined;
  readonly threadId: ThreadId;
  readonly interactionStore: ThreadFeedInteractionStore;
}) {
  const detailsOpen = useFeedSetupDetailsOpen(
    props.interactionStore,
    props.threadId,
    Boolean(props.worktreeSetup),
  );
  if (!detailsOpen || !props.worktreeSetup) return null;
  return (
    <WorktreeSetupDetails
      {...props.worktreeSetup}
      onClose={() => props.interactionStore.setSetupDetailsThreadId(null)}
    />
  );
}

function FeedCollapsibleUserMessageBody(props: {
  readonly interactionStore: ThreadFeedInteractionStore;
  readonly rowId: string;
  readonly collapsible: boolean;
  readonly onToggle: () => void;
  readonly bubbleColor: ColorValue;
  readonly children: ReactNode;
}) {
  const expanded = useFeedRowExpanded(props.interactionStore, props.rowId);
  return (
    <CollapsibleUserMessageBody
      collapsible={props.collapsible}
      expanded={expanded}
      onToggle={props.onToggle}
      bubbleColor={props.bubbleColor}
    >
      {props.children}
    </CollapsibleUserMessageBody>
  );
}

function FeedRowExpandedSlot(props: {
  readonly interactionStore: ThreadFeedInteractionStore;
  readonly rowId: string;
  readonly children: (expanded: boolean) => ReactNode;
}) {
  return props.children(useFeedRowExpanded(props.interactionStore, props.rowId));
}

export interface RenderFeedEntryProps {
  readonly environmentId: EnvironmentId;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  readonly onCiteAssistantText?: (citation: AssistantCitation) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onEditPendingMessage: ((message: QueuedThreadMessage) => void) | null;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null;
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  /** The fold row of the turn the worktree setup handed off to. */
  readonly setupFoldRowId: string | null;
  readonly onOpenSetupDetails: () => void;
  readonly pendingFoldMessageId: string | null;
  readonly formatMessageTime: (input: string) => string;
  readonly interactionStore: ThreadFeedInteractionStore;
  readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
  readonly terminalAssistantMessageIds: ReadonlySet<string>;
  readonly unsettledTurnId: RunId | null;
  readonly compactionLabelsByEntryId: ReadonlyMap<string, { title: string; compacting: string }>;
  readonly failedRunIds: ReadonlySet<RunId>;
  readonly onCopyWorkRow: (rowId: string, value: string) => void;
  readonly onToggleWorkGroup: (groupId: string, anchorKey?: string) => void;
  readonly onToggleWorkRow: (rowId: string, anchorKey?: string, groupId?: string) => void;
  readonly onToggleUserMessage: (rowId: string, anchorKey: string) => void;
  readonly onToggleTurnFold: (runId: RunId) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
  readonly markdownLinkHandlers: MarkdownLinkHandlers;
  readonly renderMarkdownImage: MarkdownImageRenderer;
  readonly renderViewedImage: MarkdownImageRenderer;
  readonly renderReasoning: (text: string) => ReactNode;
  readonly iconSubtleColor: string | ColorValue;
  readonly replyActionSize: { readonly button: number; readonly icon: number };
  readonly screenColor: string;
  readonly userBubbleColor: string | ColorValue;
  readonly markdownStyles: MarkdownStyleSets;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly reviewCommentBubbleWidth: number;
  readonly themeAppearance: "light" | "dark";
  readonly duoColumns: boolean;
  readonly userBubbleMaxWidth: number;
  readonly markdownContentWidth: number;
  readonly contentWidth: number;
  readonly threadTitle: string;
  readonly workflowOpening: WorkflowOpening | null;
  readonly userMessageGrouping: GroupedThreadFeedRow["userMessageGrouping"];
  readonly m: ReturnType<typeof useMessages>;
}

export function renderFeedEntry(
  info: { item: ThreadFeedRow; index: number },
  props: RenderFeedEntryProps,
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor, m } = props;

  if (entry.type === "guest-pending") {
    return (
      <ThreadGuestPendingMessage
        threadRef={scopeThreadRef(props.environmentId, props.threadId)}
        guestName={entry.guestName}
        message={entry.message}
        bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
        renderAttachments={(attachments) => (
          <MessageAttachmentList
            attachments={attachments}
            environmentId={props.environmentId}
            onPressPreview={props.onPressPreview}
            onPlaybackStart={props.onPlaybackStart}
          />
        )}
      />
    );
  }

  if (entry.type === "pending-fold") {
    return (
      <View className="mb-1 flex-row items-center border-b border-border-subtle px-2">
        <View
          className="min-h-11 min-w-0 flex-1 flex-row items-center"
          style={{
            minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, props.workRowSizing.estimatedRowHeight),
          }}
        >
          <Text
            key={props.workRowSizing.textSizeKey}
            numberOfLines={1}
            className="shrink font-zerocode-medium text-sm text-foreground-muted"
          >
            {m(msg("Pending", { $context: "message not yet sent" }))}
          </Text>
        </View>
      </View>
    );
  }

  if (entry.type === "run-fold") {
    return (
      <View className="mb-1 flex-row items-center border-b border-border-subtle px-2">
        {entry.workingSince ? (
          <RunFoldWorking
            environmentId={props.environmentId}
            startedAt={entry.workingSince}
            rowSizing={props.workRowSizing}
          />
        ) : (
          <RunFoldButton
            key={entry.id}
            entry={entry}
            environmentId={props.environmentId}
            threadId={props.threadId}
            onToggle={props.onToggleTurnFold}
            rowSizing={props.workRowSizing}
            iconColor={iconSubtleColor}
          />
        )}
        {props.worktreeSetup && entry.id === props.setupFoldRowId ? (
          <FeedWorktreeSetupFoldChip
            {...props.worktreeSetup}
            threadId={props.threadId}
            interactionStore={props.interactionStore}
            onOpenDetails={props.onOpenSetupDetails}
          />
        ) : null}
      </View>
    );
  }

  if (entry.type === "thinking") {
    return (
      <ThreadThinkingRow
        rowSizing={props.workRowSizing}
        iconSubtleColor={iconSubtleColor}
        label={entry.label}
        providerStartingLabel={entry.providerStartingLabel}
        providerStartingDriver={entry.providerStartingDriver}
      />
    );
  }

  if (entry.type === "html-render") {
    return (
      <ThreadHtmlRender
        environmentId={props.environmentId}
        threadId={props.threadId}
        render={entry.render}
        frameWidth={props.contentWidth}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "sent-message") {
    return (
      <View className="mb-1 px-1">
        <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
          <AssistantMarkdownContent
            markdown={entry.text}
            environmentId={props.environmentId}
            iconSubtleColor={iconSubtleColor}
            markdownStyles={markdownStyles.assistant}
            linkHandlers={props.markdownLinkHandlers}
            onUseArtifactTemplate={props.onUseArtifactTemplate}
            renderImage={props.renderMarkdownImage}
            skills={props.skills}
          />
        </MarkdownImageAvailableWidthContext>
      </View>
    );
  }

  if (entry.type === "viewed-images") {
    const thumbnailWidth = Math.floor((props.contentWidth - VIEWED_IMAGE_GAP) / 2);
    return (
      <View className="flex-row flex-wrap pb-2" style={{ gap: VIEWED_IMAGE_GAP }}>
        {entry.images.map(({ path, pending }) => (
          <View key={path} style={{ width: thumbnailWidth }}>
            {pending ? (
              // The running Read may not have written the file yet, so hold its frame unrequested.
              <ThreadMarkdownImageView
                uri={null}
                sourceKey={path}
                unavailable={false}
                alt={null}
                onPressPreview={props.onPressPreview}
              />
            ) : (
              props.renderViewedImage({ href: path, alt: null, title: null })
            )}
          </View>
        ))}
      </View>
    );
  }

  if (entry.type === "mcp-app") {
    return (
      <ThreadMcpApp
        key={entry.app.attachmentId}
        environmentId={props.environmentId}
        threadId={entry.sourceThreadId}
        conversationThreadId={props.threadId}
        itemId={entry.itemId}
        revision={entry.revision}
        app={entry.app}
        width={props.contentWidth}
      />
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        environmentId={props.environmentId}
        rowSizing={props.workRowSizing}
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        summary={entry.summary}
        summaryKind={entry.summaryKind}
        themeAppearance={props.themeAppearance}
        toolSurface={entry.toolSurface}
        toolIcon={entry.toolIcon}
        summaryToolIcon={entry.summaryToolIcon}
        hasFailure={entry.hasFailure}
        shimmer={entry.shimmer}
        thought={entry.thought}
        onToggle={() => props.onToggleWorkGroup(entry.groupId, entry.id)}
      />
    );
  }

  if (entry.type === "activity-group" && isContextHandoffActivityGroup(entry)) {
    return (
      <ThreadHandoffRow
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
        surfaceColor={props.screenColor}
      />
    );
  }

  if (entry.type === "activity-group" && isSecretRequestActivityGroup(entry)) {
    return (
      <SecretRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isLinkRequestActivityGroup(entry)) {
    return (
      <LinkRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) {
    const label = entry.activities[0]!.summary;
    const item = entry.activities[0]!.projectedItem.item;
    const active =
      props.unsettledTurnId !== null &&
      entry.runId === props.unsettledTurnId &&
      item.status === "running";
    const labels = props.compactionLabelsByEntryId.get(entry.id);
    const failure =
      item.type === "compaction" && item.status === "failed" ? item.summary?.trim() : undefined;
    return (
      <ThreadContextDivider
        label={
          failure
            ? `${label} · ${failure}`
            : active && labels
              ? labels.compacting
              : compactionLabel(label, labels?.title, item, m)
        }
        icon={
          item.status === "failed" ? "exclamationmark.circle" : "arrow.down.right.and.arrow.up.left"
        }
        iconColor={iconSubtleColor}
        active={active}
        failed={item.status === "failed"}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const presentation = resolveUserMessagePresentation(message);
    const renderedText = presentation.text;
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = props.formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = presentation.text.includes("<review_comment");
    // Android does not reposition children after maxWidth clamps bubbles; definite width prevents wide-block overlap.
    const hasWideBlock = hasWideMarkdownBlock(renderedText, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.runId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser && props.workflowOpening?.messageId === message.id) {
      return (
        <ThreadWorkflowOpening
          environmentId={props.environmentId}
          threadId={props.threadId}
          opening={props.workflowOpening}
        />
      );
    }
    if (isCompactionCommandFeedEntry(entry)) {
      // Stands in for the compaction item until the provider reports it.
      const active = props.unsettledTurnId !== null && message.runId === props.unsettledTurnId;
      const reason = idleCompactionOf(message);
      return (
        <ThreadContextDivider
          label={
            !active
              ? m(msg("Context compaction"))
              : reason === undefined
                ? m(msg("Compacting context"))
                : props.m(IDLE_COMPACTING_LABELS[reason])
          }
          icon="arrow.down.right.and.arrow.up.left"
          iconColor={iconSubtleColor}
          active={active}
        />
      );
    }
    if (isUser && presentation.attribution === "automation") {
      const rowId = `automation:${message.id}`;
      return (
        <ThreadAutomationMessageRow
          environmentId={props.environmentId}
          text={presentation.text}
          context={message.context}
          scheduledTaskId={presentation.scheduledTaskId}
          timestampLabel={timestampLabel}
          interactionStore={props.interactionStore}
          rowId={rowId}
          onToggle={() => props.onToggleWorkRow(rowId, entry.id)}
          bubbleColor={userBubbleColor}
          bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
          contentMaxWidth={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
          iconSubtleColor={iconSubtleColor}
          markdownStyles={markdownStyles.user}
          reviewCommentColors={props.reviewCommentColors}
          skills={props.skills}
          linkHandlers={props.markdownLinkHandlers}
          renderImage={props.renderMarkdownImage}
        />
      );
    }
    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      const foldRowId = presentation.attribution === "agent" ? `agent:${message.id}` : null;
      // A linked environment's agent sent it from a thread there.
      const senderRef =
        message.linkedSender ??
        (message.senderThreadId
          ? scopeThreadRef(props.environmentId, message.senderThreadId)
          : null);
      const intentBadge = props.userMessageGrouping.continuesSteer
        ? null
        : resolveUserMessageIntentBadge(
            message.inputIntent,
            message.projectedItem?.item.status === "pending",
            props.m,
          );
      const referenceIds = new Set(
        collectComposerContextReferences(message.text).map((reference) => reference.contextId),
      );
      const inlineAttachmentIds = new Set(
        message.context?.records.flatMap((record) =>
          "attachmentId" in record && referenceIds.has(record.contextId)
            ? [record.attachmentId]
            : [],
        ),
      );
      const standaloneMedia = foldRowId === null && presentation.attribution !== "guest";
      const mediaAttachments = standaloneMedia ? attachments.filter(isMediaAttachment) : [];
      const visibleAttachments = attachments.filter(
        (attachment) =>
          !(standaloneMedia && isMediaAttachment(attachment)) &&
          (isImageAttachment(attachment) || !inlineAttachmentIds.has(attachment.id)),
      );
      const pendingAttachments = entry.pendingMessage?.attachments ?? [];
      const pendingMedia = standaloneMedia ? pendingAttachments.filter(isMediaAttachment) : [];
      const pendingBubbleAttachments = standaloneMedia
        ? pendingAttachments.filter(
            (attachment) =>
              !isMediaAttachment(attachment) && !inlineAttachmentIds.has(attachment.id),
          )
        : pendingAttachments;
      const fileCards = standaloneMedia
        ? resolveUserMessageFileCards({
            text: presentation.text,
            attachments: attachments.length > 0 ? attachments : pendingAttachments,
            context: message.context,
          })
        : null;
      const hasBubble =
        fileCards === null &&
        (foldRowId !== null ||
          presentation.text.trim().length > 0 ||
          visibleAttachments.length + pendingBubbleAttachments.length > 0);
      const renderUserBubbleAndFooter = (foldExpanded: boolean) => {
        const bubbleBodyVisible = foldRowId === null || foldExpanded;
        return (
          <>
            {hasBubble ? (
              <View
                className="min-w-0 rounded-[20px]"
                style={{
                  backgroundColor: userBubbleColor,
                  maxWidth: props.duoColumns ? "85%" : props.userBubbleMaxWidth,
                  ...(!bubbleBodyVisible
                    ? null
                    : hasReviewCommentContext
                      ? { width: props.reviewCommentBubbleWidth }
                      : hasWideBlock || foldExpanded
                        ? { width: props.duoColumns ? "85%" : props.userBubbleMaxWidth }
                        : null),
                }}
              >
                {presentation.attribution === "guest" ? <GuestBubbleTint /> : null}
                {foldRowId !== null ? (
                  <AgentMessageFoldHeader
                    environmentId={senderRef?.environmentId ?? props.environmentId}
                    senderThreadId={senderRef?.threadId}
                    {...(message.linkedSender ? { senderTitle: message.linkedSender.title } : {})}
                    summary={
                      replaceComposerContextReferences(presentation.text, (ref) => ref.label)
                        .split(/\r?\n/)
                        .find((line) => line.trim().length > 0)
                        ?.trim() ?? ""
                    }
                    expanded={foldExpanded}
                    onToggle={() => props.onToggleWorkRow(foldRowId, entry.id)}
                    iconSubtleColor={iconSubtleColor}
                  />
                ) : null}
                {bubbleBodyVisible ? (
                  <View className={cn("gap-2 px-3.5 pb-2.5", foldRowId === null && "pt-2.5")}>
                    {pendingBubbleAttachments.map((attachment) =>
                      attachment.type === "image" && attachment.uploadedAttachmentId ? (
                        <MessageAttachmentImage
                          key={attachment.id}
                          environmentId={props.environmentId}
                          attachmentId={attachment.uploadedAttachmentId}
                          name={attachment.name}
                          mimeType={attachment.mimeType}
                          className="h-[140px] w-[180px] rounded-[14px]"
                          onPressPreview={props.onPressPreview}
                        />
                      ) : attachment.type === "image" ? (
                        <Pressable
                          key={attachment.id}
                          accessibilityRole="imagebutton"
                          accessibilityLabel={m(msg("Open {name}", { name: attachment.name }))}
                          onPress={() => {
                            const source = composerImageGallery([attachment])[0];
                            if (source)
                              props.onPressPreview({
                                ...source,
                                gallery: composerImageGallery(
                                  entry.pendingMessage?.attachments ?? [],
                                  props.environmentId,
                                ),
                              });
                          }}
                        >
                          <Image
                            source={{ uri: attachment.previewUri }}
                            style={{ width: 180, height: 140, borderRadius: 14 }}
                          />
                        </Pressable>
                      ) : (
                        <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                      ),
                    )}
                    {/* An empty container still takes a gap, which pads every attachment-free bubble. */}
                    {visibleAttachments.length > 0 ? (
                      <View
                        className={inlineAttachmentIds.size ? "flex-row flex-wrap gap-2" : "gap-2"}
                      >
                        {visibleAttachments.map((attachment) => {
                          return isImageAttachment(attachment) ? (
                            <MessageAttachmentImage
                              key={attachment.id}
                              environmentId={props.environmentId}
                              attachmentId={attachment.id}
                              name={attachment.name}
                              mimeType={attachment.mimeType}
                              className={
                                inlineAttachmentIds.size
                                  ? "h-24 w-24 rounded-[14px] bg-user-bubble-foreground/15"
                                  : "aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
                              }
                              onPressPreview={props.onPressPreview}
                            />
                          ) : isFileAttachment(attachment) ? (
                            <MessageAttachmentFile
                              key={attachment.id}
                              environmentId={props.environmentId}
                              attachment={attachment}
                              onPressPreview={props.onPressPreview}
                              onPlaybackStart={props.onPlaybackStart}
                            />
                          ) : (
                            <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                          );
                        })}
                      </View>
                    ) : null}
                    {presentation.text.trim().length > 0 ? (
                      <MarkdownImageAvailableWidthContext
                        value={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
                      >
                        <FeedCollapsibleUserMessageBody
                          interactionStore={props.interactionStore}
                          rowId={`message:${message.id}`}
                          collapsible={foldRowId === null}
                          onToggle={() =>
                            props.onToggleUserMessage(`message:${message.id}`, entry.id)
                          }
                          bubbleColor={userBubbleColor}
                        >
                          <UserMessageContent
                            text={renderedText}
                            environmentId={props.environmentId}
                            context={message.context}
                            markdownStyles={styles}
                            reviewCommentColors={props.reviewCommentColors}
                            skills={props.skills}
                            linkHandlers={props.markdownLinkHandlers}
                            renderImage={props.renderMarkdownImage}
                          />
                        </FeedCollapsibleUserMessageBody>
                      </MarkdownImageAvailableWidthContext>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            {bubbleBodyVisible ? (
              <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
                {foldRowId !== null && senderRef ? (
                  <OpenSenderThreadButton
                    environmentId={senderRef.environmentId}
                    senderThreadId={senderRef.threadId}
                    linked={message.linkedSender !== undefined}
                  />
                ) : null}
                {intentBadge ? (
                  <View
                    accessible
                    accessibilityLabel={intentBadge.accessibilityLabel}
                    className="flex-row items-center gap-1"
                  >
                    <SymbolView name="arrow.uturn.forward" size={12} tintColor={iconSubtleColor} />
                    <Text className="font-zerocode-medium text-xs text-foreground-secondary">
                      {intentBadge.label}
                    </Text>
                  </View>
                ) : null}
                {intentBadge ? (
                  <Text
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    className="font-zerocode-medium text-xs text-foreground-secondary"
                  >
                    ·
                  </Text>
                ) : null}
                <Text className="font-zerocode-medium text-xs tabular-nums text-foreground-secondary">
                  {entry.pendingMessage &&
                  !entry.acknowledged &&
                  entry.id !== props.pendingFoldMessageId
                    ? m(msg("Pending", { $context: "message not yet sent" }))
                    : timestampLabel}
                </Text>
                {props.onEditPendingMessage !== null &&
                entry.pendingMessage &&
                !entry.acknowledged &&
                !entry.pendingMessage.creation &&
                entry.pendingMessage.messageId !== props.dispatchingMessageId ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={m(msg("Edit pending message"))}
                    hitSlop={8}
                    className="size-7 items-center justify-center"
                    onPress={() => {
                      if (entry.pendingMessage && props.onEditPendingMessage) {
                        props.onEditPendingMessage(entry.pendingMessage);
                      }
                    }}
                  >
                    <SymbolView name="pencil" size={14} tintColor={iconSubtleColor} />
                  </Pressable>
                ) : null}
                {presentation.text.trim().length > 0 ? (
                  <UserMessageCopyButton
                    text={presentation.text}
                    onCopy={
                      message.context && presentation.attribution !== "guest"
                        ? () =>
                            writeComposerContextClipboard(message.text, {
                              version: 1,
                              source: { environmentId: props.environmentId, messageId: message.id },
                              records: message.context!.records,
                            })
                        : undefined
                    }
                    tintColor={iconSubtleColor}
                  />
                ) : null}
              </View>
            ) : null}
          </>
        );
      };
      return (
        <Animated.View
          // A prompt sits close to its own response; the answer's margin separates turns.
          className={cn("items-end", props.userMessageGrouping.groupedWithNext ? "mb-1" : "mb-2")}
          {...(enterAnimated ? { entering: FadeInDown.duration(220) } : {})}
        >
          {presentation.attribution === "zerocode" ? (
            <Text className="mb-1 pr-1 font-zerocode-medium text-2xs text-foreground-muted opacity-60">
              {m(msg("Sent by ZeroCode"))}
            </Text>
          ) : null}
          {presentation.guestName !== undefined ? (
            <GuestMessageName name={presentation.guestName} />
          ) : null}
          {mediaAttachments.length + pendingMedia.length > 0 ? (
            <View
              className={hasBubble ? "mb-2" : undefined}
              style={{ width: props.duoColumns ? "85%" : props.userBubbleMaxWidth }}
            >
              <UserMessageMedia
                messageId={message.id}
                attachments={mediaAttachments}
                pendingAttachments={pendingMedia}
                environmentId={props.environmentId}
                maxWidth={props.userBubbleMaxWidth}
                onPressPreview={props.onPressPreview}
                onPlaybackStart={props.onPlaybackStart}
              />
            </View>
          ) : null}
          {fileCards ? (
            <View
              className="items-end"
              style={{ maxWidth: props.duoColumns ? "85%" : props.userBubbleMaxWidth }}
            >
              {fileCards.map((file) => {
                const pendingFile = pendingAttachments.find(
                  (attachment) => attachment.id === file.id,
                );
                return (
                  <MessageAttachmentFile
                    key={file.id}
                    environmentId={props.environmentId}
                    attachment={
                      pendingFile?.uploadedAttachmentId
                        ? { ...file, id: pendingFile.uploadedAttachmentId }
                        : file
                    }
                    available={
                      pendingFile === undefined || pendingFile.uploadedAttachmentId !== undefined
                    }
                    onPressPreview={props.onPressPreview}
                    onPlaybackStart={props.onPlaybackStart}
                    standaloneFile
                  />
                );
              })}
            </View>
          ) : null}
          {foldRowId !== null ? (
            <FeedRowExpandedSlot interactionStore={props.interactionStore} rowId={foldRowId}>
              {renderUserBubbleAndFooter}
            </FeedRowExpandedSlot>
          ) : (
            renderUserBubbleAndFooter(false)
          )}
        </Animated.View>
      );
    }

    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(
          showAssistantMeta && !(message.runId && props.failedRunIds.has(message.runId))
            ? "mb-5 px-1"
            : "mb-1 px-1",
          hasWideBlock && "w-full",
        )}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <AssistantMarkdownContent
              markdown={renderedText}
              streaming={message.streaming}
              environmentId={props.environmentId}
              iconSubtleColor={iconSubtleColor}
              citationSource={{ threadId: props.threadId, messageId: message.id }}
              onCiteAssistantText={props.onCiteAssistantText}
              markdownStyles={styles}
              linkHandlers={props.markdownLinkHandlers}
              reply={message.projectedItem}
              onUseArtifactTemplate={props.onUseArtifactTemplate}
              renderImage={props.renderMarkdownImage}
              skills={props.skills}
            />
          </MarkdownImageAvailableWidthContext>
        ) : null}
        <MessageAttachmentList
          attachments={attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
          onPlaybackStart={props.onPlaybackStart}
        />
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel={m(msg("Copy message"))}
              text={renderedText}
              tintColor={iconSubtleColor}
              buttonSize={props.replyActionSize.button}
              iconSize={props.replyActionSize.icon}
            />
            {message.projectedItem ? (
              <AssistantForkButton
                environmentId={props.environmentId}
                iconColor={iconSubtleColor}
                buttonSize={props.replyActionSize.button}
                iconSize={props.replyActionSize.icon}
                projectedItem={message.projectedItem}
                sourceTitle={props.threadTitle}
              />
            ) : null}
            <Text className="font-zerocode-medium text-xs tabular-nums text-foreground-secondary">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      continuesWorkLog={entry.continuesWorkLog}
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      anchorKey={entry.id}
      interactionStore={props.interactionStore}
      rowSizing={props.workRowSizing}
      scrollPositions={props.workGroupScrollPositions}
      iconSubtleColor={iconSubtleColor}
      edgeFadeColor={props.screenColor}
      themeAppearance={props.themeAppearance}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      renderImage={props.renderViewedImage}
      renderReasoning={props.renderReasoning}
      onPressPreview={props.onPressPreview}
    />
  );
}

export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-zerocode-bold text-lg text-foreground">
          {props.title}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

export type DisclosureLayout = {
  /** Each row's top relative to the anchor row's top, before the toggle. */
  positions: ReadonlyMap<string, number>;
  anchorIndex: number;
  /** Distance from the anchor's top to the end of the content, before the toggle. */
  anchorToEnd: number;
  list: LegendListRef;
  playing: boolean;
};

export const DISCLOSURE_DETAIL_DELAY_MS = 135;
export const DISCLOSURE_DETAIL_FADE_MS = 70;
const unsubscribeNothing = () => {};

export function feedContentEnd(state: ReturnType<LegendListRef["getState"]>): number | undefined {
  const last = state.data.length - 1;
  if (last < 0) return undefined;
  const position = state.positionAtIndex(last);
  return position === undefined ? undefined : position + state.sizeAtIndex(last);
}

export function DisclosureRow(props: {
  itemKey: string;
  index: number;
  layout: DisclosureLayout | null;
  children: ReactNode;
}) {
  const { itemKey, layout } = props;
  const previous = layout?.positions.get(itemKey);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!layout || layout.playing || previous === undefined) return unsubscribeNothing;
      const state = layout.list.getState();
      const stops = [
        state.listenToPosition(itemKey, notify),
        state.listen("totalSize", notify),
        state.listen("isAtEnd", notify),
        state.listen("isFollowingEnd", notify),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    [itemKey, layout, previous],
  );
  // Rows hold their old screen spot relative to whatever stays still: the content end
  // while the feed sits at the bottom (end follow, or a collapse that clamps the scroll),
  // otherwise the anchored disclosure row.
  const getOffset = () => {
    if (!layout || layout.playing || previous === undefined) return 0;
    const state = layout.list.getState();
    const position = state.positionAtIndex(props.index);
    if (position === undefined) return 0;
    if (state.isFollowingEnd || state.isAtEnd) {
      const end = feedContentEnd(state);
      return end === undefined ? 0 : previous - layout.anchorToEnd - (position - end);
    }
    if (previous <= 0) return 0;
    const anchor = state.positionAtIndex(layout.anchorIndex);
    return anchor === undefined ? 0 : previous - (position - anchor);
  };
  const offset = useSyncExternalStore(subscribe, getOffset, getOffset);
  const entering = !!layout && previous === undefined;
  return (
    <Animated.View
      collapsable={false}
      style={
        layout
          ? {
              opacity: entering && !layout.playing ? 0 : 1,
              transform: [{ translateY: offset }],
              transitionProperty: layout?.playing ? (entering ? "opacity" : "transform") : "none",
              transitionDuration: entering
                ? DISCLOSURE_DETAIL_FADE_MS
                : THREAD_DISCLOSURE_TRANSITION_MS,
              transitionDelay: entering ? DISCLOSURE_DETAIL_DELAY_MS : 0,
              transitionTimingFunction: "ease-out",
            }
          : undefined
      }
    >
      {props.children}
    </Animated.View>
  );
}

/** Tells mobile:metrics' probe the commit that first showed this thread's rows. */
export function PerfContentMark(props: { readonly probe: PerfProbe; readonly thread: string }) {
  const { probe, thread } = props;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- reports the visible commit to the dev-only perf probe
  useLayoutEffect(() => probe.contentShown(thread), [probe, thread]);
  return null;
}

export function ThreadFeedLoadEarlierControl(
  props: ThreadFeedHistoryControls & { readonly mutedColor: ColorValue },
) {
  const gt = useGT();
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <View className="self-center">
          <Button
            label={props.loading ? gt("Loading earlier activity…") : gt("Load earlier activity")}
            tone="secondary"
            accessibilityLabel={gt("Load earlier activity")}
            disabled={props.loading}
            onPress={props.onLoadEarlier}
            icon="chevron.up"
            loading={props.loading}
          />
        </View>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: props.mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
