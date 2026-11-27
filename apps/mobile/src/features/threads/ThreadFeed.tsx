import { useGT, useLocale, useMessages } from "gt-react-native";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { enrichedThreadLinkCustomization } from "../../native/useEnrichedLinkVariants";
import {
  enrichedSkillInstructionsPath,
  enrichedSkillReference,
} from "../../lib/enrichedLinkPresentation";
import { formatProviderSkillDisplayName } from "@zerocode/shared/inlineSkills";
import {
  ThreadContextDivider,
  ThreadStatusLine,
  type ThreadStatusLineModel,
} from "./thread-context-divider";
import { ThreadHandoffDivider, ThreadModelSwitchDivider } from "./thread-handoff-row";
import { useThreadGuestShare } from "./ThreadGuestShareBar";
import {
  WorktreePreparingHeader,
  worktreeSetupHandedOff,
  type WorktreeSetupCardProps,
} from "./worktree-setup-card";
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@zerocode/client-runtime/environment";
import type { HandoffEndpoints } from "@zerocode/client-runtime/handoff";
import { resolveUserMessagePresentation } from "@zerocode/client-runtime/user-message";
import {
  AuthFilesystemReadScope,
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@zerocode/contracts";
import type { ToolCallVisibility } from "@zerocode/contracts/settings";
import { hostedThreadLink, parseThreadLinkHref } from "@zerocode/shared/threadLinks";
import type { CodexArtifactTemplate } from "@zerocode/shared/codexArtifactTemplates";
import { executeAtomQuery } from "@zerocode/client-runtime/state/runtime";
import { classifyMarkdownImageSource } from "@zerocode/client-runtime/markdown-images";
import {
  resolveViewedImageAsset,
  viewedImageMarkdownSource,
} from "@zerocode/client-runtime/work-log/presentation";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListAnchoredEndSpace,
} from "@zerocode/shared/chatList";
import { useFocusEffect, useIsFocused, useNavigation } from "@react-navigation/native";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType } from "../../native/native-layout-metrics";
import { isDuoDevice } from "../../lib/device-type";
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type RefObject,
} from "react";
import {
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useReduceMotionEnabled } from "../../lib/appState";
import { FilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { isPdfFile } from "../../lib/filePreview";
import { ThreadInlineFilePreview } from "./ThreadInlineFilePreview";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import Animated, { type SharedValue } from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type {
  MarkdownImageRenderer,
  SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { AppText as Text } from "../../components/ui/AppText";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { markdownFileEmbedLabel, resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useBarInset, useContentTopInset } from "../../components/ui/useBarInset";
import { useReviewCommentColors } from "../review/ReviewCommentCard";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../lib/layout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { createThreadFeedInteractionStore } from "./thread-feed-interaction-store";
import type { ThreadWorkGroupScrollPosition } from "./thread-feed-scroll-position";
import { collapsedWorkLogHeight, WORK_GROUP_TOGGLE_HEIGHT } from "./thread-work-log";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createPendingTurnAppender,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "./pending-thread-feed";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";
import { htmlRenderFrameHeight } from "@zerocode/shared/htmlRender";
import { htmlRenderRowHeight } from "./HtmlRenderWebView";
import { readEnvironmentScope } from "../../state/session";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import {
  agentWorkingDirectories,
  findAgentDirectoryMatch,
  needsWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@zerocode/client-runtime/workspace-basename-lookup";
import { resolveThreadLink, useEnvironmentPreviewTunnelOff } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useWorkflowOpening } from "./thread-workflow-opening";
import {
  fileRoutePathSegments,
  isAbsolutePath,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { fileChipClipboardPath, fileChipMenu, resolveFileChipTarget } from "./fileChipMenu";
import { useFileChipShare } from "./useFileChipShare";
import { useOpenThreadLink } from "./useOpenThreadLink";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { loopbackUrlForDevice } from "../browser/browserTabs";
import { useOpenLocalPreview } from "../browser/useOpenLocalPreview";
import {
  THREAD_FEED_MAINTAIN_SCROLL_AT_END,
  THREAD_FEED_MAINTAIN_SCROLL_AT_END_THRESHOLD,
} from "./threadFeedEndFollow";
import { useMessageTimeFormatter } from "./useMessageTimeFormatter";
import { perfProbe } from "../development/perf-probe-hooks";
import {
  EMPTY_FILE_PREVIEW_GALLERY,
  ThreadMediaVisibility,
  buildMessageGalleriesById,
} from "./feed/ThreadFeedAttachments";
import {
  AssistantMarkdownContent,
  useMarkdownStyles,
  type MarkdownLinkHandlers,
  type MarkdownLinkReply,
} from "./feed/ThreadFeedMarkdown";
import {
  DISCLOSURE_DETAIL_DELAY_MS,
  DISCLOSURE_DETAIL_FADE_MS,
  DisclosureRow,
  FeedWorktreeSetupCard,
  FeedWorktreeSetupDetails,
  PerfContentMark,
  ThreadFeedLoadEarlierControl,
  ThreadFeedPlaceholder,
  feedContentEnd,
  renderFeedEntry,
  type DisclosureLayout,
  type ThreadFeedHistoryControls,
} from "./feed/ThreadFeedRows";

export type { ThreadFeedHistoryControls };

const FEED_PADDING_TOP = 12;
const ASSISTANT_ROW_HORIZONTAL_PADDING = 3.5;

export interface ThreadFeedProps {
  readonly toolCallVisibility?: ToolCallVisibility;
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly preparingWorktree?: boolean;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onEditPendingMessage: ((message: QueuedThreadMessage) => void) | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Null while the thread's creation is queued: reading detail then caches a not-found as deleted. */
  readonly detailRef: ScopedThreadRef | null;
  readonly threadTitle: string;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  /** Thread states that close the feed: background work, then snooze or settle. */
  readonly statusLines?: ReadonlyArray<ThreadStatusLineModel>;
  readonly contentPresentation: ThreadContentPresentation;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  /** A message to scroll to once it is in the feed; see `onJumpedToMessage`. */
  readonly jumpToMessageId?: MessageId | null;
  readonly onJumpedToMessage?: () => void;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly keyboardOffset: number;
  readonly sendingWithKeyboard?: boolean;
  readonly fitShortFeedToViewport?: boolean;
  readonly contentBottomInset?: number;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly contentMaxWidth?: number;
  readonly contentSideInsets?: { readonly left: number; readonly right: number };
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onIsAtEndChange?: (isAtEnd: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  readonly onCiteAssistantText?: (citation: AssistantCitation) => void;
}

// LegendList only computes hook visibility when the list has a viewability config.
const THREAD_MEDIA_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

// The composer and overlays beside the feed keep UIKit from finding it on its own, so
// register it with the screen controller. Header minimization observes this scroll view.
function ThreadFeedScrollView(props: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <Animated.ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}

// A hook's return value is frozen to the compiler, so ThreadFeed's later
// hooks can't drag this derivation into an uncached scope.
function useThreadFeedPresentation(
  props: ThreadFeedProps,
  expandedTurnIds: ReadonlySet<RunId>,
  expandedWorkGroups: Record<string, boolean>,
  revealedMessageId: MessageId | null,
) {
  const [feedCache] = useState(createThreadFeedCache);
  const messages = useMessages();
  const locale = useLocale();
  return appendPendingThreadMessages(
    deriveThreadFeedPresentation(
      props.feed,
      props.latestRun,
      expandedTurnIds,
      new Set(
        Object.entries(expandedWorkGroups)
          .filter(([, expanded]) => expanded)
          .map(([groupId]) => groupId),
      ),
      props.activeWorkStartedAt,
      props.runlessWorkActive ?? false,
      feedCache,
      { toolCallVisibility: props.toolCallVisibility ?? "showAll", revealedMessageId },
      messages,
      locale,
    ),
    props.feed,
    props.queuedMessages,
  );
}

// A thread switch remounts the feed. Starting from the last split pane's size lays rows out once,
// instead of at width 0 and again when the new feed's own layout reports the same width.
let lastSplitViewport: { windowWidth: number; width: number; height: number } | null = null;

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const gt = useGT();
  const m = useMessages();
  const formatMessageTime = useMessageTimeFormatter();
  const { listRef, onIsAtEndChange, onHeaderMaterialVisibilityChange } = props;
  const workflowOpening = useWorkflowOpening(props.detailRef);
  const guestShare = useThreadGuestShare(props.detailRef);
  const deviceType = useDeviceType();
  const duoColumns = useNativeWorkspaceColumnsSupported() && isDuoDevice(deviceType);
  const openPullRequest = useOpenPullRequest();
  const navigation = useNavigation();
  const openThreadLink = useOpenThreadLink(props.environmentId);
  const openLocalPreview = useOpenLocalPreview();
  const previewTunnelOff = useEnvironmentPreviewTunnelOff(props.environmentId);
  // Without the tunnel, loopback links fall through to the system browser like any other link.
  const deviceLoopbackUrl = (href: string) =>
    previewTunnelOff ? null : loopbackUrlForDevice(href);
  // Recycling a row disposes its native audio player, so a started clip's row stays rendered.
  const [retainedMediaRowId, setRetainedMediaRowId] = useState<string | null>(null);
  const focused = useIsFocused();
  if (!focused && retainedMediaRowId !== null) setRetainedMediaRowId(null);
  const { themeAppearance } = useAppearancePreferences();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = deriveThreadWorkLogSizing({
    baseFontSize: appearance.baseFontSize,
    fontScale,
  });
  const settledPaneWidth = useWorkspaceSettledContentWidth();
  const splitLayout = (props.layoutVariant ?? "compact") !== "compact";
  const [initialSplitViewport] = useState(() =>
    splitLayout && lastSplitViewport?.windowWidth === windowWidth ? lastSplitViewport : null,
  );
  const [measuredViewportWidth, setViewportWidth] = useState(() =>
    splitLayout ? (initialSplitViewport?.width ?? 0) : windowWidth,
  );
  const viewportWidth =
    settledPaneWidth !== null ? Math.round(settledPaneWidth) : measuredViewportWidth;
  const [viewportHeight, setViewportHeight] = useState(() => initialSplitViewport?.height ?? 0);
  const [disclosureLayout, setDisclosureLayout] = useState<DisclosureLayout | null>(null);
  const disclosureMotionRef = useRef<DisclosureLayout | null>(null);
  const disclosureMotionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const reduceMotion = useReduceMotionEnabled();
  const [interactionStore] = useState(createThreadFeedInteractionStore);
  const [interactionState, setInteractionState] = useState<{
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<RunId>;
    readonly revealedMessageId: MessageId | null;
  }>({
    expandedWorkGroups: {},
    expandedTurnIds: new Set(),
    revealedMessageId: null,
  });
  const { expandedWorkGroups, expandedTurnIds, revealedMessageId } = interactionState;
  const markdownLinkRequest = useRef<AbortController | null>(null);
  const onInlinePlaybackStart = () => {
    markdownLinkRequest.current?.abort();
  };
  useFocusEffect(useCallback(() => () => markdownLinkRequest.current?.abort(), []));
  // A preview belongs to the thread and presentation it was opened from: a change closes it and
  // aborts a pending lookup.
  const markdownLinkScope = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.contentPresentation.kind,
  ]);
  // oxlint-disable-next-line react/exhaustive-effect-dependencies, zerocode/no-unreasoned-state-sync -- A scope change (thread or presentation) aborts the pending link lookup opened from the old scope.
  useLayoutEffect(() => () => markdownLinkRequest.current?.abort(), [markdownLinkScope]);
  const [preview, setPreview] = useState<{
    readonly scope: string;
    readonly file: FilePreviewSource | null;
    readonly video: VideoPreviewSource | null;
  } | null>(null);
  if (preview !== null && preview.scope !== markdownLinkScope) setPreview(null);
  const expandedFile = preview?.scope === markdownLinkScope ? preview.file : null;
  const expandedVideo = preview?.scope === markdownLinkScope ? preview.video : null;
  const openPreview = (
    scope: string,
    media: { file: FilePreviewSource } | { video: VideoPreviewSource },
  ) =>
    setPreview((current) => {
      const live = current?.scope === scope ? current : null;
      return {
        scope,
        file: "file" in media ? media.file : (live?.file ?? null),
        video: "video" in media ? media.video : (live?.video ?? null),
      };
    });
  const closeFilePreview = () =>
    setPreview((current) => (current === null ? null : { ...current, file: null }));
  const closeVideoPreview = () =>
    setPreview((current) => (current === null ? null : { ...current, video: null }));
  const fileShareSourceIdentifier = useId();
  const shareFileChip = useFileChipShare(
    props.environmentId,
    props.threadId,
    fileShareSourceIdentifier,
  );
  const horizontalPadding = splitLayout ? 20 : 16;
  const contentLeftInset = props.contentSideInsets?.left ?? 0;
  const contentRightInset = props.contentSideInsets?.right ?? 0;
  const usableViewportWidth = Math.max(0, viewportWidth - contentLeftInset - contentRightInset);
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth: usableViewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, usableViewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const markdownContentWidth = Math.max(0, contentWidth - ASSISTANT_ROW_HORIZONTAL_PADDING * 2);
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const barInset = useBarInset();
  const columnTopInset = useContentTopInset();
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  // Without the native contentInset, a list-header spacer clears the bar the column lays content under.
  const topContentInset = usesNativeAutomaticInsets ? 0 : columnTopInset;
  const anchorTopInset = usesNativeAutomaticInsets ? barInset : topContentInset;

  const theme = useUniwindTheme();
  const iconSubtleColor = theme["--color-icon-subtle"];
  const { buttonSize: androidButtonSize, smallIconSize: androidIconSize } =
    useAndroidControlSizing();
  const replyActionSize = useMemo(
    () =>
      Platform.OS === "android"
        ? { button: androidButtonSize, icon: androidIconSize }
        : { button: 28, icon: 13 },
    [androidButtonSize, androidIconSize],
  );
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];
  const openSkillInstructions = (path: string) => {
    void Haptics.selectionAsync();
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(path),
    });
  };
  const resolveLinkedThread = (href: string) => {
    const link = parseThreadLinkHref(href);
    if (!link) return null;
    const resolved = resolveThreadLink(
      (atom) => appAtomRegistry.get(atom),
      link,
      props.environmentId,
    );
    if (resolved !== null || link.environmentId !== null) return resolved;
    // A v1 link names no environment, so it falls back to this message's.
    return scopeThreadRef(props.environmentId, link.threadId);
  };
  // Prefer the thread workspace before looking across projects or in agent directories.
  const findFileLinkTarget = async (
    linkPath: string,
    path: string,
    signal: AbortSignal,
    reply: MarkdownLinkReply | undefined,
  ): Promise<string> => {
    const relativePath = resolveWorkspaceRelativeFilePath(props.workspaceRoot, path);
    if (
      !props.workspaceRoot ||
      !relativePath ||
      /[\\/]$/.test(linkPath) ||
      workspaceLinkLookupQuery(linkPath, props.workspaceRoot) === null ||
      !readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
    ) {
      return relativePath ?? path;
    }
    const workspaceRoot = props.workspaceRoot;
    const basenameLookup = needsWorkspaceBasenameLookup(relativePath);
    const originalPath = resolveWorkspaceFilePath(workspaceRoot, relativePath);
    const queryOptions = { signal, reportFailure: false, reportDefect: false };
    const searchRoot = (root: string) =>
      executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.searchEntries({
          environmentId: props.environmentId,
          input: {
            cwd: root,
            query: workspaceLinkLookupQuery(relativePath, root) ?? relativePath,
            kind: "file",
            limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          },
        }),
        queryOptions,
      ).then((result) => ({
        root,
        entries: result._tag === "Success" ? result.value.entries : [],
      }));
    const metadataOf = (target: string) =>
      executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.fileMetadata({
          environmentId: props.environmentId,
          input: { path: target },
        }),
        queryOptions,
      );
    const lookup = async () => {
      const own = await searchRoot(workspaceRoot);
      let match = pickWorkspaceLinkMatch(relativePath, workspaceRoot, own.entries);
      const otherProject = match === null;
      if (otherProject) {
        const threadProjectId = appAtomRegistry.get(
          environmentThreadShells.threadShellAtom(
            scopeThreadRef(props.environmentId, props.threadId),
          ),
        )?.projectId;
        const otherRoots = appAtomRegistry
          .get(environmentProjects.projectsAtom)
          .flatMap((project) =>
            project.environmentId === props.environmentId &&
            project.id !== threadProjectId &&
            project.workspaceRoot !== workspaceRoot
              ? [project.workspaceRoot]
              : [],
          );
        if (otherRoots.length > 0) {
          const projectSearches = await Promise.all(otherRoots.map(searchRoot));
          match = pickProjectLinkMatch(relativePath, [own, ...projectSearches]);
        }
      }
      if (match === null && reply !== undefined && !signal.aborted) {
        // An unresolved project lookup falls back to the agent's working directories.
        const agentRoots = agentWorkingDirectories(
          appAtomRegistry.get(
            environmentThreadDetails.quietThreadAtom(
              scopeThreadRef(props.environmentId, props.threadId),
            ),
          )?.projection.visibleTurnItems ?? [],
          reply,
        ).filter((root) => root !== workspaceRoot);
        const agentPaths = agentRoots.map((root) => resolveWorkspaceFilePath(root, relativePath));
        if (agentPaths.length === 0) return relativePath;
        const [original, ...found] = await Promise.all(
          [originalPath, ...agentPaths].map(metadataOf),
        );
        if (original?._tag !== "Success" || original.value !== null) return relativePath;
        const index = found.findIndex(
          (result) => result._tag === "Success" && result.value?.kind === "file",
        );
        const literal = agentPaths[index];
        if (literal !== undefined || !basenameLookup) {
          return literal ?? relativePath;
        }
        return (
          (await findAgentDirectoryMatch(relativePath, agentRoots, searchRoot)) ?? relativePath
        );
      }
      if (!match || match === relativePath || signal.aborted) return relativePath;
      const metadata = await metadataOf(originalPath);
      // Another project's file never replaces a thread-local file the search missed.
      return metadata._tag === "Success" &&
        (basenameLookup && !otherProject
          ? metadata.value?.kind !== "directory"
          : metadata.value === null)
        ? match
        : relativePath;
    };
    return lookup().catch(() => relativePath);
  };
  const onMarkdownLinkPress = (
    href: string,
    imageEmbed = false,
    reply?: MarkdownLinkReply,
    withGallery?: (source: FilePreviewSource) => FilePreviewSource,
  ) => {
    markdownLinkRequest.current?.abort();
    const request = new AbortController();
    markdownLinkRequest.current = request;
    const skill = enrichedSkillReference(href, props.skills);
    if (skill) {
      const instructionsPath = enrichedSkillInstructionsPath(skill);
      if (instructionsPath) openSkillInstructions(instructionsPath);
      return;
    }
    // Safari would open the phone's own localhost, so these open on the device by default.
    const deviceUrl = deviceLoopbackUrl(href);
    if (deviceUrl) {
      openLocalPreview(
        { environmentId: String(props.environmentId), threadId: String(props.threadId) },
        deviceUrl,
      );
      return;
    }
    if (parseThreadLinkHref(href)) {
      const target = resolveLinkedThread(href);
      if (target) openThreadLink(target);
      return;
    }
    const media = resolveMarkdownMediaPreview(href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed,
    });
    if (media && media.kind !== "file") {
      void Haptics.selectionAsync();
      const scope = markdownLinkScope;
      const openMediaPreview = () => {
        if (request.signal.aborted) return;
        openPreview(
          scope,
          media.kind === "video"
            ? { video: media.source }
            : { file: withGallery ? withGallery(media.source) : media.source },
        );
      };
      const resource = "resource" in media.source ? media.source.resource : null;
      const mediaPath = resource && "path" in resource ? resource.path : null;
      if (
        typeof mediaPath === "string" &&
        readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
      ) {
        void executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.fileMetadata({
            environmentId: props.environmentId,
            input: { path: mediaPath },
          }),
          { signal: request.signal, reportFailure: false, reportDefect: false },
        ).then((result) => {
          if (request.signal.aborted) return;
          if (result._tag === "Success" && result.value?.kind === "directory") {
            navigation.navigate("ThreadFile", {
              environmentId: String(props.environmentId),
              threadId: String(props.threadId),
              path: fileRoutePathSegments(mediaPath),
            });
          } else openMediaPreview();
        }, openMediaPreview);
      } else openMediaPreview();
      return;
    }

    const presentation = resolveMarkdownLinkPresentation(href);
    if (presentation.kind === "file") {
      const path = resolveFileLinkPath(props.workspaceRoot, presentation.path);
      if (path === null) return;
      void findFileLinkTarget(presentation.path, path, request.signal, reply).then((target) => {
        if (request.signal.aborted) return;
        void Haptics.selectionAsync();
        navigation.navigate("ThreadFile", {
          environmentId: String(props.environmentId),
          threadId: String(props.threadId),
          path: fileRoutePathSegments(target),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
      });
      return;
    }

    if (presentation.href) {
      if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
        openPreview(markdownLinkScope, {
          file: { kind: "pdf", uri: presentation.href, name: "Document.pdf" },
        });
        return;
      }
      void openPullRequest(presentation.href);
    }
  };
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot ?? null,
  });
  const markdownLinkHandlers: MarkdownLinkHandlers = {
    fileEmbedLabel: (href, standalone) =>
      markdownFileEmbedLabel(
        href,
        {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
        },
        standalone,
      ),
    onLinkPress: (href, reply) => onMarkdownLinkPress(href, false, reply),
    linkCustomization: enrichedThreadLinkCustomization,
    onImagePress: (href, withGallery) => onMarkdownLinkPress(href, true, undefined, withGallery),
    resolveImageSource,
    fileContextMenu: (href) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        return {
          title: formatProviderSkillDisplayName(skill),
          actions: [
            {
              id: "open-skill",
              title: gt("View instructions"),
              disabled: !enrichedSkillInstructionsPath(skill),
            },
            { id: "copy-skill", title: gt("Copy skill") },
          ],
        };
      }
      const thread = resolveLinkedThread(href);
      if (thread) {
        return {
          title:
            appAtomRegistry.get(environmentThreadShells.threadShellAtom(thread))?.title ??
            gt("Thread"),
          actions: [
            { id: "open-thread", title: gt("Open thread") },
            { id: "copy-thread-link", title: gt("Copy link") },
          ],
        };
      }
      // The environment's localhost, which this device can only reach through the tunnel.
      if (deviceLoopbackUrl(href)) {
        return {
          title: href,
          actions: [
            { id: "open-on-device", title: gt("Open on this device") },
            { id: "copy-link", title: gt("Copy link") },
          ],
        };
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      return target ? fileChipMenu(target) : undefined;
    },
    onFileContextMenuAction: (href, actionId, reply) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        const instructionsPath = enrichedSkillInstructionsPath(skill);
        if (actionId === "open-skill" && instructionsPath) openSkillInstructions(instructionsPath);
        else if (actionId === "copy-skill") copyTextWithHaptic(`$${skill.name}`);
        return;
      }
      const thread = resolveLinkedThread(href);
      if (thread) {
        if (actionId === "open-thread") onMarkdownLinkPress(href);
        else if (actionId === "copy-thread-link") copyTextWithHaptic(hostedThreadLink(thread));
        return;
      }
      const deviceUrl = deviceLoopbackUrl(href);
      if (deviceUrl) {
        if (actionId === "open-on-device") {
          markdownLinkRequest.current?.abort();
          openLocalPreview(
            { environmentId: String(props.environmentId), threadId: String(props.threadId) },
            deviceUrl,
          );
        } else if (actionId === "copy-link") copyTextWithHaptic(href);
        return;
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      if (!target) return;
      switch (actionId) {
        case "copy-full-path":
        case "copy-relative-path": {
          const presentation = resolveMarkdownLinkPresentation(href);
          const path =
            presentation.kind === "file"
              ? resolveFileLinkPath(props.workspaceRoot, presentation.path)
              : null;
          if (presentation.kind !== "file" || path === null) return;
          markdownLinkRequest.current?.abort();
          const request = new AbortController();
          markdownLinkRequest.current = request;
          void findFileLinkTarget(presentation.path, path, request.signal, reply).then((found) => {
            if (request.signal.aborted) return;
            const fullPath =
              props.workspaceRoot && !isAbsolutePath(found)
                ? resolveWorkspaceFilePath(props.workspaceRoot, found)
                : found;
            const clipboardPath = fileChipClipboardPath(
              {
                ...target,
                ...(target.fullPath ? { fullPath } : {}),
                ...(target.relativePath
                  ? {
                      relativePath:
                        resolveWorkspaceRelativeFilePath(props.workspaceRoot, fullPath) ??
                        target.relativePath,
                    }
                  : {}),
              },
              actionId,
            );
            if (clipboardPath !== undefined) copyTextWithHaptic(clipboardPath);
          });
          return;
        }
        case "open-file":
          onMarkdownLinkPress(href, false, reply);
          return;
        case "save":
          shareFileChip(target);
          return;
      }
    },
  };
  const renderMarkdownImage: MarkdownImageRenderer = (image) => {
    const media = resolveMarkdownMediaPreview(image.href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed: true,
    });
    if (media?.kind === "video") {
      return (
        <ThreadMarkdownVideo
          key={image.href}
          source={{ ...media.source, name: image.alt ?? media.source.name }}
          onPlaybackStart={onInlinePlaybackStart}
        />
      );
    }
    if (media?.kind === "audio") {
      return (
        <ThreadInlineFilePreview
          key={image.href}
          source={media.source}
          onOpen={() => onMarkdownLinkPress(image.href, true)}
          onPlaybackStart={onInlinePlaybackStart}
        />
      );
    }
    const fileLink = resolveMarkdownLinkPresentation(image.href);
    if (
      (media && (media.kind === "pdf" || media.kind === "document" || media.kind === "file")) ||
      (fileLink.kind === "file" && fileLink.line !== undefined)
    ) {
      const name =
        media?.source.name ?? (fileLink.kind === "file" ? fileLink.label : gt("Open file"));
      return (
        <Text
          accessibilityRole="link"
          accessibilityLabel={gt("Open {name}", { name })}
          onPress={() => onMarkdownLinkPress(image.href, true)}
          style={{
            color: markdownStyles.assistant.nativeTextStyle.linkColor,
            fontSize: markdownStyles.assistant.nativeTextStyle.fontSize,
            lineHeight: markdownStyles.assistant.nativeTextStyle.lineHeight,
          }}
        >
          {name}
        </Text>
      );
    }
    const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);
    if (imageSource._tag === "Direct") {
      return (
        <ThreadMarkdownImageView
          uri={normalizeNativeMarkdownUrl(imageSource.uri)}
          sourceKey={imageSource.uri}
          format={
            /\.svg(?:[?#]|$)/i.test(imageSource.uri) ||
            imageSource.uri.startsWith("data:image/svg+xml")
              ? "svg"
              : undefined
          }
          unavailable={false}
          alt={image.alt}
          actionsSource={media?.source.actionsSource}
          onPressPreview={onPressPreview}
        />
      );
    }
    if (
      media?.kind !== "image" ||
      !("resource" in media.source) ||
      media.source.resource._tag !== "media-file"
    ) {
      return <ThreadMarkdownImageUnavailable alt={image.alt} />;
    }
    return (
      <ThreadMarkdownImage
        environmentId={media.source.environmentId}
        resource={media.source.resource}
        alt={image.alt}
        srcFragment={media.source.srcFragment}
        actionsSource={media.source.actionsSource}
        onPressPreview={onPressPreview}
      />
    );
  };
  const renderViewedImage: MarkdownImageRenderer = (image) => {
    const viewedImage = resolveViewedImageAsset(image.href, {
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
    });
    const media = viewedImage
      ? resolveMarkdownMediaPreview(viewedImageMarkdownSource(image.href), {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
          imageEmbed: true,
        })
      : null;
    const actionsSource = media?.source.actionsSource;
    return viewedImage ? (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={viewedImage.resource}
        alt={viewedImage.alt}
        srcFragment={viewedImage.srcFragment}
        actionsSource={
          actionsSource && "resource" in actionsSource
            ? { ...actionsSource, resource: viewedImage.resource }
            : undefined
        }
        onPressPreview={onPressPreview}
      />
    ) : null;
  };
  const markdownStyles = useMarkdownStyles(theme);
  const renderReasoning = (text: string) => (
    <AssistantMarkdownContent
      markdown={text}
      environmentId={props.environmentId}
      iconSubtleColor={iconSubtleColor}
      markdownStyles={markdownStyles.assistant}
      linkHandlers={markdownLinkHandlers}
      renderImage={renderMarkdownImage}
      skills={props.skills}
    />
  );
  const reviewCommentColors = useReviewCommentColors();
  const unsettledTurnId = threadFeedRunIsUnsettled(props.latestRun) ? props.latestRun.runId : null;
  const compactionLabelsByEntryId = useMemo(
    () => threadFeedCompactionLabels(props.feed, m),
    [props.feed, m],
  );
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Include turn completion so unchanged message rows reveal their footer and spacing
  // even when the final message update arrives before the turn settles.
  // One sheet for the setup's card, chip, and summary row, so it stays open as setup moves between them.
  const openSetupDetails = () => interactionStore.setSetupDetailsThreadId(props.threadId);
  const listAppearanceData = {
    gt,
    disclosureLayout,
    reduceMotion,
    onCiteAssistantText: props.onCiteAssistantText,
    formatMessageTime,
    worktreeSetup: props.worktreeSetup,
    preparingWorktree: props.preparingWorktree,
    dispatchingMessageId: props.dispatchingMessageId,
    unsettledTurnId,
    workRowSizing,
    iconSubtleColor,
    markdownStyles,
    reviewCommentColors,
    themeAppearance,
    userBubbleColor,
    viewportWidth,
    contentWidth,
    skills: props.skills,
    workspaceRoot: props.workspaceRoot,
    workflowOpening,
  };
  const reportHeaderMaterialVisibility = (visible: boolean) => {
    if (headerMaterialVisibleRef.current === visible) {
      return;
    }
    headerMaterialVisibleRef.current = visible;
    onHeaderMaterialVisibilityChange?.(visible);
  };
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const [landedListKey, setLandedListKey] = useState<string | null>(null);
  // LegendList reports ready, and shows its rows, while rows measured during its initial scroll can
  // still leave it hundreds of points short of the end; isAtEnd stays true through that.
  const settling = props.feed.length > 0 && landedListKey !== feedThreadKey;
  const landingFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportMetrics = (ready: boolean) => {
    const state = listRef.current?.getState();
    if (!state) return;
    if (
      settling &&
      ready &&
      (state.distanceFromEnd <= 2 || !state.isFollowingEnd || props.jumpToMessageId)
    ) {
      setLandedListKey(feedThreadKey);
    }
    // Offset 0 before the first positioning, and the gaps while rows measure in, are not the
    // user leaving the end; only a scroll away stops end following.
    onIsAtEndChange?.(settling || state.isAtEnd || state.isFollowingEnd);
  };
  const handleMetricsChange = () => reportMetrics(loadedListKey === feedThreadKey);
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    reportHeaderMaterialVisibility(
      event.nativeEvent.contentOffset.y + (usesNativeAutomaticInsets ? barInset : 0) > 6,
    );
    handleMetricsChange();
  };
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- subscribes to the list's end state to report it to the parent
  useLayoutEffect(() => {
    const state = listRef.current?.getState();
    if (!state) return;
    handleMetricsChange();
    const stops = [
      state.listen("isAtEnd", handleMetricsChange),
      state.listen("isFollowingEnd", handleMetricsChange),
      state.listen("totalSize", handleMetricsChange),
      state.listen("footerSize", handleMetricsChange),
      state.listen("headerSize", handleMetricsChange),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [listRef, handleMetricsChange]);
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- clears the landing fallback timer when the feed unmounts
  useEffect(
    () => () => {
      if (landingFallback.current !== null) clearTimeout(landingFallback.current);
    },
    [],
  );
  const [workGroupScrollPositions] = useState(
    () => new Map<string, ThreadWorkGroupScrollPosition>(),
  );

  // Opening at a message: once the filled list has loaded, the render that sees
  // the jump unfolds a run hiding the message and stops following the end, so
  // the committed list holds the target row with end maintenance off.
  const { jumpToMessageId } = props;
  const jumpReady = !!jumpToMessageId && loadedListKey === feedThreadKey;
  if (jumpReady && revealedMessageId !== jumpToMessageId) {
    setInteractionState((current) => ({ ...current, revealedMessageId: jumpToMessageId }));
  }
  const [appendPendingTurn] = useState(createPendingTurnAppender);
  const presentedFeed = appendGuestPendingMessages(
    appendPendingTurn(
      useThreadFeedPresentation(props, expandedTurnIds, expandedWorkGroups, revealedMessageId),
      { zen: props.toolCallVisibility === "zen" },
      m,
    ),
    guestShare,
    m,
  );
  const pendingFoldMessageId =
    presentedFeed.findLast((entry) => entry.type === "pending-fold")?.messageId ?? null;
  const jumpRunId =
    jumpReady &&
    !presentedFeed.some((entry) => entry.type === "message" && entry.id === jumpToMessageId)
      ? messageFoldRunId(props.feed, jumpToMessageId, presentedFeed)
      : null;
  if (jumpRunId && !expandedTurnIds.has(jumpRunId)) {
    setInteractionState((current) => ({
      ...current,
      expandedTurnIds: new Set(current.expandedTurnIds).add(jumpRunId),
    }));
  }
  const setupAnchorIndex = presentedFeed.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  // As on web, setup still running after the agent took the turn rides on the live Working row.
  const setupFoldRowId =
    props.worktreeSetup &&
    worktreeSetupHandedOff(props.worktreeSetup) &&
    props.worktreeSetup.snapshot.phase === "running"
      ? (presentedFeed.find(
          (entry, index) =>
            index > setupAnchorIndex &&
            entry.type === "run-fold" &&
            entry.workingSince !== undefined,
        )?.id ?? null)
      : null;
  const [groupFeed] = useState(createThreadFeedGrouping);
  const groupedFeed = groupFeed(presentedFeed, {
    workflowOpeningMessageId: workflowOpening?.messageId,
    setupAnchorIndex: props.worktreeSetup || props.preparingWorktree ? setupAnchorIndex : undefined,
  });
  const { environmentId, threadId, workspaceRoot } = props;
  const messageGalleriesById = buildMessageGalleriesById(
    groupedFeed,
    environmentId,
    threadId,
    workspaceRoot,
  );
  const { contentInsetEndAdjustment } = props;
  const attachList = (list: LegendListRef | null) => {
    listRef.current = list;
    const bottom = contentInsetEndAdjustment.get();
    if (list && bottom > 0) list.reportContentInset({ bottom });
  };
  const jumpIndex = jumpReady
    ? presentedFeed.findIndex((entry) => entry.type === "message" && entry.id === jumpToMessageId)
    : null;
  const landJump = useEffectEvent((index: number) => {
    const list = listRef.current;
    if (!list) return;
    let cancelled = false;
    const positioning =
      index === -1 ? undefined : list.scrollToIndex({ index, viewPosition: 0.2, animated: false });
    void Promise.resolve(positioning).then(() => {
      if (!cancelled && listRef.current === list) props.onJumpedToMessage?.();
    });
    return () => {
      cancelled = true;
    };
  });
  // A jump can unfold a run; keep end maintenance off until its position settles.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- scrolls the native list to the jump target after the commit that rendered its row
  useEffect(() => {
    if (jumpIndex !== null) return landJump(jumpIndex);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Jumping to a different message whose row index is unchanged must still land the jump.
  }, [jumpToMessageId, jumpIndex]);

  const handleViewportLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    if (splitLayout) lastSplitViewport = { windowWidth, width: nextWidth, height: nextHeight };
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  };

  const anchoredEndSpace = resolveChatListAnchoredEndSpace(
    presentedFeed,
    props.anchorMessageId,
    (entry) => (entry.type === "message" ? entry.id : null),
    { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
  );
  const failedRunIds = failedFeedRunIds(props.feed, props.latestRun);
  const terminalAssistantMessageIds = (() => {
    const terminalIdsByTurn = new Map<RunId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
        terminalIdsByTurn.set(entry.message.runId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  })();
  // An interrupted run unfolds; a run that is no longer latest folds back.
  const [previousLatestRun, setPreviousLatestRun] = useState(props.latestRun);
  if (previousLatestRun !== props.latestRun) {
    setPreviousLatestRun(props.latestRun);
    const latest = props.latestRun;
    const previous = previousLatestRun;
    if (latest && previous) {
      if (latest.runId !== previous.runId) {
        if (expandedTurnIds.has(previous.runId)) {
          setInteractionState((current) => {
            const next = new Set(current.expandedTurnIds);
            next.delete(previous.runId);
            return { ...current, expandedTurnIds: next };
          });
        }
      } else if (previous.status === "running" && latest.status === "interrupted") {
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(latest.runId),
        }));
      }
    }
  }

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- clears copy feedback, disclosure timers/frames, and per-feed interaction atoms on unmount
  useEffect(
    () => () => {
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
      if (disclosureMotionTimer.current !== null) clearTimeout(disclosureMotionTimer.current);
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
      interactionStore.dispose();
    },
    [interactionStore],
  );

  const settleDisclosureAfterLayout = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        const motion = disclosureMotionRef.current;
        if (motion && !motion.playing) {
          const playing = { ...motion, playing: true };
          disclosureMotionRef.current = playing;
          setDisclosureLayout(playing);
          disclosureMotionTimer.current = setTimeout(
            () => {
              disclosureMotionRef.current = null;
              setDisclosureLayout(null);
              disclosureMotionTimer.current = null;
            },
            DISCLOSURE_DETAIL_DELAY_MS + DISCLOSURE_DETAIL_FADE_MS + 16,
          );
        }
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  };

  const preserveDisclosurePosition = (anchorKey: string | null) => {
    const list = listRef.current;
    const working = props.activeWorkStartedAt !== null || props.runlessWorkActive === true;
    // An anchor ends end-follow until the reader scrolls, so a streaming turn keeps the live end.
    if (anchorKey !== null && list && !(working && list.getState().isFollowingEnd)) {
      list.cancelScroll();
      list.anchorVisibleContent({ key: anchorKey });
    }
    if (list && anchorKey && !reduceMotion) {
      const state = list.getState();
      const anchorIndex = state.indexByKey(anchorKey);
      if (anchorIndex !== undefined) {
        const anchor = state.positionAtIndex(anchorIndex);
        const anchorTop = state.elementAtIndex(anchorIndex)?.getBoundingClientRect().top;
        const positions = new Map<string, number>();
        for (let i = state.startBuffered; i <= state.endBuffered; i++) {
          const item = groupedFeed[i];
          if (!item) continue;
          const displayed =
            disclosureMotionRef.current &&
            state.elementAtIndex(i)?.firstElementChild?.getBoundingClientRect().top;
          positions.set(
            item.id,
            displayed != null && anchorTop !== undefined
              ? displayed - anchorTop
              : state.positionAtIndex(i) - anchor,
          );
        }
        const motion = {
          positions,
          anchorIndex,
          anchorToEnd: (feedContentEnd(state) ?? anchor) - anchor,
          list,
          playing: false,
        };
        if (disclosureMotionTimer.current !== null) clearTimeout(disclosureMotionTimer.current);
        disclosureMotionRef.current = motion;
        setDisclosureLayout(motion);
        settleDisclosureAfterLayout();
      }
    }
  };

  const handleItemSizeChanged = () => {
    if (disclosureMotionRef.current && !disclosureMotionRef.current.playing) {
      settleDisclosureAfterLayout();
    }
  };

  const onCopyWorkRow = (rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    interactionStore.setCopiedRowId(rowId);
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      if (interactionStore.isRowCopied(rowId)) {
        interactionStore.setCopiedRowId(null);
      }
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  };

  const onToggleWorkGroup = (groupId: string, anchorKey?: string) => {
    preserveDisclosurePosition(anchorKey ?? `work-toggle:${groupId}`);
    setInteractionState((current) => ({
      ...current,
      expandedWorkGroups: {
        ...current.expandedWorkGroups,
        [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
      },
    }));
  };

  // Lone rows share their group's disclosure state so opened details survive a second call joining.
  const onToggleWorkRow = (rowId: string, anchorKey?: string, groupId?: string) => {
    preserveDisclosurePosition(anchorKey ?? null);
    const expanded = interactionStore.toggleWorkRow(rowId);
    if (groupId !== undefined) {
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: { ...current.expandedWorkGroups, [groupId]: expanded },
      }));
    }
  };

  const onToggleUserMessage = (rowId: string, anchorKey: string) => {
    const list = listRef.current;
    if (interactionStore.isRowExpanded(rowId) && list) {
      const anchor = list.anchorVisibleContent({ key: anchorKey, hold: false });
      const nextKey = groupedFeed[groupedFeed.findIndex((item) => item.id === anchorKey) + 1]?.id;
      // Once the message top is scrolled away, collapse toward it like the web: what follows stays put.
      if (anchor && anchor.offset > 0 && nextKey) {
        onToggleWorkRow(rowId, nextKey);
        return;
      }
    }
    onToggleWorkRow(rowId, anchorKey);
  };

  const onToggleTurnFold = (runId: RunId) => {
    preserveDisclosurePosition(`run-fold:${runId}`);
    setInteractionState((current) => {
      const next = new Set(current.expandedTurnIds);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return { ...current, expandedTurnIds: next };
    });
  };

  const onPressPreview = (source: FilePreviewSource) => {
    markdownLinkRequest.current?.abort();
    openPreview(markdownLinkScope, { file: source });
  };

  // Without this, every row above the viewport is assumed to be
  // estimatedItemSize tall, and scrolling up through unmeasured content
  // corrects each row's height as it mounts — the feed visibly jumps.
  const getFixedItemSize = (entry: ThreadFeedRow) => {
    if (entry.type === "guest-pending") return undefined;
    if (entry.type === "pending-fold") {
      return workRowSizing.fixedRowHeight === undefined
        ? undefined
        : resolveThreadFeedFixedItemSize("run-fold");
    }
    if (entry.type === "html-render") {
      return htmlRenderRowHeight(htmlRenderFrameHeight(entry.render, contentWidth));
    }
    if (workRowSizing.fixedRowHeight === undefined) {
      return undefined;
    }
    switch (entry.type) {
      case "run-fold":
        return resolveThreadFeedFixedItemSize(entry.type);
      case "work-toggle":
        return entry.thought ? undefined : WORK_GROUP_TOGGLE_HEIGHT;
      case "thinking":
        return WORK_GROUP_TOGGLE_HEIGHT;
      case "activity-group":
        if (entry.activities[0]?.projectedItem.item.type === "subagent") {
          return undefined;
        }
        if (isContextCompactionActivityGroup(entry) || isContextHandoffActivityGroup(entry)) {
          return undefined;
        }
        if (
          entry.activities[0]?.groupedToolDetail &&
          entry.activities.every((activity) => activity.workEntry.itemType === "reasoning")
        ) {
          return undefined;
        }
        return entry.activities.some(
          (activity) => activity.prominent || interactionStore.isRowExpanded(activity.id),
        )
          ? undefined
          : collapsedWorkLogHeight(entry.activities, entry.continuesWorkLog);
      default:
        return undefined;
    }
  };
  // Row geometry inputs mostly arrive as props with no handler here. LegendList
  // reads getFixedItemSize only when it renders, so its size cache is cleared
  // after the commit that hands it rows at the new geometry; clearing earlier
  // re-caches old sizes.
  const { textSizeKey } = workRowSizing;
  const hasHtmlRenders = presentedFeed.some((entry) => entry.type === "html-render");
  const previousRowGeometry = useRef({ textSizeKey, contentWidth });
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- clears LegendList size caches after the commit that brings new row geometry
  useLayoutEffect(() => {
    const previous = previousRowGeometry.current;
    if (previous.textSizeKey === textSizeKey && previous.contentWidth === contentWidth) return;
    previousRowGeometry.current = { textSizeKey, contentWidth };
    if (previous.textSizeKey !== textSizeKey || hasHtmlRenders) {
      listRef.current?.clearCaches({ mode: "sizes" });
    }
  }, [textSizeKey, contentWidth, hasHtmlRenders, listRef]);

  const renderItem = (info: { item: GroupedThreadFeedRow; index: number }) => (
    <DisclosureRow
      key={info.item.id}
      itemKey={info.item.id}
      index={info.index}
      layout={disclosureLayout}
    >
      <FilePreviewGallery
        value={messageGalleriesById.get(info.item.id) ?? EMPTY_FILE_PREVIEW_GALLERY}
      >
        <ThreadMediaVisibility rowId={info.item.id} setRetainedRowId={setRetainedMediaRowId}>
          {info.item.type === "message" &&
          info.item.message.projectedItem?.item.type === "user_message" &&
          info.item.message.projectedItem.item.freshContext ? (
            <ThreadContextDivider
              label={gt("New session")}
              icon="arrow.clockwise"
              iconColor={iconSubtleColor}
            />
          ) : null}
          {info.item.type === "message" &&
          !isCompactionCommandFeedEntry(info.item) &&
          info.item.message.projectedItem?.item.type === "user_message" &&
          info.item.message.projectedItem.item.modelSwitch ? (
            <ThreadModelSwitchDivider
              environmentId={props.environmentId}
              modelSwitch={info.item.message.projectedItem.item.modelSwitch}
              iconColor={iconSubtleColor}
            />
          ) : null}
          {renderFeedEntry(info, {
            m,
            userMessageGrouping: info.item.userMessageGrouping,
            formatMessageTime,
            environmentId: props.environmentId,
            dispatchingMessageId: props.dispatchingMessageId,
            pendingFoldMessageId,
            setupFoldRowId,
            worktreeSetup: props.worktreeSetup,
            onOpenSetupDetails: openSetupDetails,
            onEditPendingMessage: props.onEditPendingMessage,
            onUseArtifactTemplate: props.onUseArtifactTemplate,
            onCiteAssistantText: props.onCiteAssistantText,
            threadId: props.threadId,
            interactionStore,
            workRowSizing,
            workGroupScrollPositions,
            terminalAssistantMessageIds,
            unsettledTurnId,
            compactionLabelsByEntryId,
            failedRunIds,
            onCopyWorkRow,
            onToggleWorkGroup,
            onToggleWorkRow,
            onToggleUserMessage,
            onToggleTurnFold,
            onPressPreview,
            onPlaybackStart: onInlinePlaybackStart,
            markdownLinkHandlers,
            renderMarkdownImage,
            renderViewedImage,
            renderReasoning,
            iconSubtleColor,
            replyActionSize,
            screenColor,
            userBubbleColor,
            markdownStyles,
            reviewCommentColors,
            reviewCommentBubbleWidth,
            themeAppearance,
            duoColumns,
            userBubbleMaxWidth,
            markdownContentWidth,
            contentWidth,
            threadTitle: props.threadTitle,
            skills: props.skills,
            workspaceRoot: props.workspaceRoot,
            workflowOpening,
          })}
          {props.worktreeSetup && info.index === setupAnchorIndex ? (
            <FeedWorktreeSetupCard
              key={props.threadId}
              {...props.worktreeSetup}
              threadId={props.threadId}
              interactionStore={interactionStore}
              onOpenDetails={openSetupDetails}
            />
          ) : props.preparingWorktree && info.index === setupAnchorIndex ? (
            <WorktreePreparingHeader />
          ) : null}
        </ThreadMediaVisibility>
      </FilePreviewGallery>
    </DisclosureRow>
  );

  if (props.contentPresentation.kind === "unavailable" && props.queuedMessages.length === 0) {
    return (
      <View style={{ flex: 1, marginLeft: contentLeftInset, marginRight: contentRightInset }}>
        <ThreadFeedPlaceholder
          title={props.contentPresentation.title}
          detail={props.contentPresentation.detail}
          topInset={topContentInset}
          bottomInset={bottomContentInset}
          horizontalPadding={horizontalPadding}
        />
      </View>
    );
  }

  return (
    <PresentationSource identifier={fileShareSourceIdentifier} style={{ flex: 1 }}>
      <View className="flex-1" onLayout={handleViewportLayout}>
        {/* In a split, rows only re-wrap in the render that hands the list its new width. A native
            column resize would re-wrap them first, and the list would place the taller or shorter
            rows at their old offsets until their measurements came back. */}
        <View
          className="flex-1"
          style={splitLayout && viewportWidth > 0 ? { width: viewportWidth } : undefined}
        >
          {perfProbe && !settling && props.feed.length > 0 ? (
            <PerfContentMark key={feedThreadKey} probe={perfProbe} thread={feedThreadKey} />
          ) : null}
          {/* oxlint-disable-next-line zerocode/require-registered-list-scroll -- ThreadFeedScrollView is passed through the iOS-only spread below; the prop rejects undefined. */}
          <KeyboardAwareLegendList
            ref={attachList}
            dataKey={feedThreadKey}
            style={settling ? { flex: 1, opacity: 0 } : { flex: 1 }}
            // RN 0.81+ drops inset-area touches (facebook/react-native#54123), making blank post-send space unscrollable.
            applyWorkaroundForContentInsetHitTestBug
            {...(Platform.OS === "ios" ? { ScrollViewComponent: ThreadFeedScrollView } : {})}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            scrollIndicatorInsets={{ top: anchorTopInset, bottom: 0 }}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            keyboardOffset={props.keyboardOffset}
            {...(usesNativeAutomaticInsets ? { contentInset: { top: anchorTopInset } } : {})}
            freeze={props.freeze}
            maintainScrollAtEnd={jumpReady ? false : THREAD_FEED_MAINTAIN_SCROLL_AT_END}
            maintainScrollAtEndThreshold={THREAD_FEED_MAINTAIN_SCROLL_AT_END_THRESHOLD}
            maintainVisibleContentPosition
            data={groupedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) => {
              // Same container as the live fold that replaces it.
              if (entry.type === "pending-fold") return "run-fold";
              if (entry.type !== "message") return entry.type;
              if (isCompactionCommandFeedEntry(entry)) return "message:compaction";
              if (
                entry.message.role === "assistant" &&
                !terminalAssistantMessageIds.has(entry.message.id)
              ) {
                return "message:assistant-progress";
              }
              const { attribution } = resolveUserMessagePresentation(entry.message);
              return attribution === "automation" || attribution === "agent"
                ? `message:${attribution}`
                : `message:${entry.message.role}`;
            }}
            getFixedItemSize={getFixedItemSize}
            drawDistance={500}
            {...(retainedMediaRowId ? { alwaysRender: { keys: [retainedMediaRowId] } } : {})}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            // Android scrolls a tapped selectable message into view when it takes focus, which reads
            // as a user scroll and drops end following before the keyboard closes.
            scrollsChildToFocus={false}
            keyboardLiftBehavior={props.sendingWithKeyboard ? "persistent" : "whenAtEnd"}
            // Seed the initial viewport before native onLayout.
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            scrollToOverflowEnabled
            estimatedItemSize={180}
            alignItemsAtEnd
            initialScrollAtEnd
            onReady={() => {
              setLoadedListKey(feedThreadKey);
              reportMetrics(true);
              // Never leave the feed hidden if end following stalls short of the end.
              landingFallback.current = setTimeout(() => setLandedListKey(feedThreadKey), 1000);
            }}
            onLayout={handleMetricsChange}
            onItemSizeChanged={handleItemSizeChanged}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            ListHeaderComponent={
              <>
                {usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />}
                {setupAnchorIndex < 0 && props.worktreeSetup ? (
                  <FeedWorktreeSetupCard
                    key={props.threadId}
                    {...props.worktreeSetup}
                    threadId={props.threadId}
                    interactionStore={interactionStore}
                    onOpenDetails={openSetupDetails}
                  />
                ) : setupAnchorIndex < 0 && props.preparingWorktree ? (
                  <WorktreePreparingHeader />
                ) : null}
                {props.historyControls ? (
                  <ThreadFeedLoadEarlierControl
                    {...props.historyControls}
                    mutedColor={iconSubtleColor}
                  />
                ) : null}
              </>
            }
            ListFooterComponent={
              props.pendingHandoff || props.statusLines?.length ? (
                <>
                  {props.pendingHandoff ? (
                    <ThreadHandoffDivider
                      environmentId={props.environmentId}
                      endpoints={props.pendingHandoff}
                      iconColor={iconSubtleColor}
                      surfaceColor={screenColor}
                      label={gt("Context handoff pending")}
                    />
                  ) : null}
                  {props.statusLines?.map((line) => (
                    <ThreadStatusLine key={line.key} line={line} iconColor={iconSubtleColor} />
                  ))}
                </>
              ) : null
            }
            contentContainerStyle={{
              ...(props.fitShortFeedToViewport ? { minHeight: "100%" } : {}),
              paddingTop: FEED_PADDING_TOP,
              paddingLeft: contentHorizontalPadding + contentLeftInset,
              paddingRight: contentHorizontalPadding + contentRightInset,
            }}
          />
        </View>
        {presentedFeed.length === 0 &&
        !props.worktreeSetup &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { left: contentLeftInset, right: contentRightInset }]}
          >
            <ThreadFeedPlaceholder
              title={gt("No conversation yet")}
              detail={gt(
                "Ask the agent to inspect the repo, run a command, or continue the active thread.",
              )}
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
        <VideoPreviewModal source={expandedVideo} onRequestClose={closeVideoPreview} />
        <FeedWorktreeSetupDetails
          worktreeSetup={props.worktreeSetup}
          threadId={props.threadId}
          interactionStore={interactionStore}
        />
        <FilePreviewModal source={expandedFile} onRequestClose={closeFilePreview} />
      </View>
    </PresentationSource>
  );
});
