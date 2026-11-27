import { useGT, useMessages } from "gt-react-native";
import { Sheet } from "../../../components/ui/Sheet";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListSection } from "../../../components/ui/ListSection";
import { collectMobileAssistantTextSelectors } from "../../../lib/assistantCitationSelection";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type OrchestrationV2ProjectedTurnItem,
} from "@zerocode/contracts";
import {
  enrichedContextLinkCustomization,
  withChipIcon,
} from "../../../native/useEnrichedLinkVariants";
import * as Haptics from "expo-haptics";
import { scopeThreadRef } from "@zerocode/client-runtime/environment";
import { encodeComposerContextFragment } from "@zerocode/shared/composerContextClipboard";
import { hasThreadLinks, threadLinkRefs } from "@zerocode/shared/threadLinks";
import {
  parseComposerContextHref,
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@zerocode/shared/composerContextReferences";
import { ComposerContextSheet } from "../../../components/ComposerContextSheet";
import { writeComposerContextClipboard } from "../../../lib/composerContextClipboard";
import type { CodexArtifactTemplate } from "@zerocode/shared/codexArtifactTemplates";
import { codexArtifactTemplatePresentationLabel } from "@zerocode/shared/codexArtifactTemplatesCopy";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@zerocode/shared/codexMarkdownDirectives";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { textDirection } from "@zerocode/shared/textDirection";
import { useNavigation } from "@react-navigation/native";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ColorValue } from "react-native";
import { useFilePreviewGallery } from "../../../components/ui/FilePreviewGallery";
import type { FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import {
  flattenThemeColor,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../../lib/mobileTheme";
import { FONT_FAMILIES } from "../../../lib/fontFamilies";
import { splitMarkdownDetails } from "../../../lib/markdownDetails";
import {
  markdownReferenceDefinitions,
  withReferenceDefinitions,
} from "../../../lib/markdownDocument";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import { AppText as Text } from "../../../components/ui/AppText";
import { parseReviewCommentMessageSegments } from "../../review/reviewCommentSelection";
import { ReviewCommentCard, type ReviewCommentColors } from "../../review/ReviewCommentCard";
import { resolveNativeMarkdownTypography } from "../../../lib/appearancePreferences";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { ThreadDisclosureChevron } from "../thread-work-log";
import { useLiveThreadLinkLabels, useThreadChipIcons } from "../../../state/entities";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useLinkedEnvironments } from "../../../state/peerLinks";
import { useModelMentions } from "../../../state/model-mentions";
import { composerDocumentAttachmentRecord } from "../../../lib/composerContext";
import { useOpenThreadLink } from "../useOpenThreadLink";

const linkedThreadEnvironmentIds = (markdown: string, environmentId: EnvironmentId) =>
  hasThreadLinks(markdown)
    ? threadLinkRefs(markdown, environmentId).map((ref) => ref.environmentId)
    : [];

/** The reply a link sits in; a file it cites may be where the agent worked before writing it. */
export type MarkdownLinkReply = Pick<
  OrchestrationV2ProjectedTurnItem,
  "sourceThreadId" | "sourceItemId"
>;

export interface MarkdownLinkHandlers {
  readonly onLinkPress: (href: string, reply?: MarkdownLinkReply) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (
    href: string,
    actionId: string,
    reply?: MarkdownLinkReply,
  ) => void;
  /** `withGallery` pages the image through its message's images; the feed's viewer sits outside that scope. */
  readonly onImagePress?: (
    href: string,
    withGallery?: (source: FilePreviewSource) => FilePreviewSource,
  ) => void;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly fileEmbedLabel?: (href: string, standalone: boolean) => string | null;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

export interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

export interface MarkdownStyleSet {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate["artifactKind"],
  AppSymbolName
> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const direction = textDirection(props.template.displayName);
  return (
    <View
      className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3"
      style={direction ? { direction } : undefined}
    >
      <View className="h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-zerocode-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind, messages)}
        </Text>
      </View>
      {props.onUse ? (
        <Button
          label={gt("Use template")}
          tone="secondary"
          accessibilityLabel={gt("Use {name} template", { name: props.template.displayName })}
          onPress={() => props.onUse?.(props.template)}
        />
      ) : null}
    </View>
  );
}

export const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly iconSubtleColor: ColorValue;
  readonly citationSource?: Pick<AssistantCitation, "threadId" | "messageId">;
  readonly onCiteAssistantText?: (citation: AssistantCitation) => void;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly reply?: MarkdownLinkReply | undefined;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  readonly streaming?: boolean | undefined;
}) {
  const gt = useGT();
  const liveMarkdown = useLiveThreadLinkLabels(
    props.markdown,
    props.environmentId,
    useLinkedEnvironments(
      hasThreadLinks(props.markdown) ? props.environmentId : null,
      linkedThreadEnvironmentIds(props.markdown, props.environmentId),
    ),
  );
  const [quoteSelection, setQuoteSelection] = useState<{
    markdown: string;
    selectors: ReturnType<typeof collectMobileAssistantTextSelectors>;
  } | null>(null);
  if (quoteSelection !== null && quoteSelection.markdown !== liveMarkdown) setQuoteSelection(null);
  const quoteChoices = quoteSelection?.selectors ?? [];
  const cite = ({ selector }: (typeof quoteChoices)[number]) => {
    if (!props.citationSource || !props.onCiteAssistantText) return;
    setQuoteSelection(null);
    props.onCiteAssistantText({
      version: 1,
      environmentId: props.environmentId,
      ...props.citationSource,
      ...selector,
    });
  };
  const models = useModelMentions(props.environmentId, props.markdown);
  const threadIcons = useThreadChipIcons(props.environmentId, liveMarkdown);
  const withGallery = useFilePreviewGallery();
  const onImagePress = props.linkHandlers.onImagePress;
  const linkHandlers: MarkdownLinkHandlers = {
    ...props.linkHandlers,
    ...(onImagePress ? { onImagePress: (href: string) => onImagePress(href, withGallery) } : {}),
    onLinkPress: (href) => props.linkHandlers.onLinkPress(href, props.reply),
    onFileContextMenuAction: (href, actionId) =>
      props.linkHandlers.onFileContextMenuAction(href, actionId, props.reply),
    linkCustomization: (href) =>
      withChipIcon(props.linkHandlers.linkCustomization?.(href), threadIcons.get(href)),
  };

  return (
    <>
      <AssistantMarkdownBlocks
        markdown={liveMarkdown}
        streaming={props.streaming}
        iconSubtleColor={props.iconSubtleColor}
        onCiteText={
          props.onCiteAssistantText && props.citationSource
            ? (text, path) => {
                if (!text.trim()) return;
                if (text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
                  Dialog.alert(
                    gt("Quote is too long"),
                    gt("Select up to {max} characters to cite.", {
                      max: ASSISTANT_CITATION_MAX_TEXT_LENGTH.toLocaleString(),
                    }),
                  );
                  return;
                }
                const selectors = collectMobileAssistantTextSelectors(liveMarkdown, path, text);
                if (selectors.length === 0) {
                  Dialog.alert(
                    gt("Unable to locate quote"),
                    gt("Select more surrounding text to cite its source accurately."),
                  );
                  return;
                }
                if (selectors.length === 1) cite(selectors[0]!);
                else setQuoteSelection({ markdown: liveMarkdown, selectors });
              }
            : undefined
        }
        markdownStyles={props.markdownStyles}
        linkHandlers={linkHandlers}
        onUseArtifactTemplate={props.onUseArtifactTemplate}
        renderImage={props.renderImage}
        skills={props.skills}
        models={models}
      />
      {quoteChoices.length > 0 && props.onCiteAssistantText ? (
        <Sheet title={gt("Choose quote source")} onClose={() => setQuoteSelection(null)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 20 }}
          >
            <ListSection
              title={gt("This text appears more than once. Choose the passage you selected.")}
            >
              {quoteChoices.map((choice) => (
                <ListActionRow
                  key={choice.selector.start}
                  label={gt("Occurrence {index} of {count}", {
                    index: choice.index + 1,
                    count: choice.count,
                  })}
                  description={`${choice.selector.prefix}${choice.selector.text}${choice.selector.suffix}`}
                  onPress={() => cite(choice)}
                />
              ))}
            </ListSection>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
});

// Folds split first, so an artifact card inside a fold stays inside it.
function AssistantMarkdownBlocks(props: {
  readonly markdown: string;
  readonly streaming?: boolean | undefined;
  readonly iconSubtleColor: ColorValue;
  readonly citationPath?: string;
  readonly onCiteText?: (text: string, path: string) => void;
  /** The reply's reference definitions, passed down by the enclosing fold. */
  readonly definitions?: ReadonlyArray<string> | undefined;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  readonly models: ReturnType<typeof useModelMentions>;
}) {
  const m = useMessages();
  const { blocks, definitions } = useMemo(() => {
    const blocks = splitMarkdownDetails(props.markdown, m).map((block) =>
      block.kind === "details"
        ? block
        : { ...block, segments: splitCodexArtifactTemplateMarkdown(block.markdown) },
    );
    const [first] = blocks;
    // A reply rendered as one document resolves its own references; skip the extra parse.
    const whole = blocks.length === 1 && first?.kind === "markdown" && first.segments.length === 1;
    return {
      blocks,
      definitions:
        props.definitions ??
        (whole || props.streaming ? [] : markdownReferenceDefinitions(props.markdown)),
    };
  }, [m, props.markdown, props.definitions, props.streaming]);
  return blocks.map((block, blockIndex) => {
    if (block.kind === "details") {
      return (
        <MarkdownDetailsFold
          key={`details:${block.sourceOffset}`}
          summary={block.summary}
          initiallyOpen={block.open}
          iconSubtleColor={props.iconSubtleColor}
        >
          <AssistantMarkdownBlocks
            {...props}
            markdown={block.body}
            definitions={definitions}
            citationPath={`${props.citationPath ?? ""}${blockIndex}/`}
          />
        </MarkdownDetailsFold>
      );
    }
    return block.segments.map((segment, segmentIndex) => {
      const offset = block.sourceOffset + segment.sourceOffset;
      if (segment.kind === "artifact-template") {
        return (
          <ArtifactTemplateCard
            key={`artifact-template:${offset}`}
            template={segment.template}
            onUse={props.onUseArtifactTemplate}
          />
        );
      }
      if (segment.markdown.trim().length === 0) return null;
      return (
        <SelectableMarkdownText
          key={`markdown:${offset}`}
          markdown={renderCodexInlineDirectivesAsMarkdown(
            withReferenceDefinitions(segment.markdown, definitions),
          )}
          isStreaming={props.streaming}
          skills={props.skills}
          models={props.models}
          textStyle={props.markdownStyles.nativeTextStyle}
          onCiteText={
            props.onCiteText
              ? (text) =>
                  props.onCiteText?.(
                    text,
                    `${props.citationPath ?? ""}${blockIndex}:${segmentIndex}`,
                  )
              : undefined
          }
          {...props.linkHandlers}
          renderImage={props.renderImage}
        />
      );
    });
  });
}

function MarkdownDetailsFold(props: {
  readonly summary: string;
  readonly initiallyOpen: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.initiallyOpen);
  return (
    <View className="my-2 border-y border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.summary}
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-10 flex-row items-center gap-2 py-2"
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={12}
          tintColor={props.iconSubtleColor}
        />
        <Text className="min-w-0 shrink font-zerocode-medium text-sm text-foreground">
          {props.summary}
        </Text>
      </Pressable>
      {expanded ? <View className="pb-3 pl-5">{props.children}</View> : null}
    </View>
  );
}

export function useMarkdownStyles(theme: MobileThemeVariables): MarkdownStyleSets {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = resolveNativeMarkdownTypography(appearance.baseFontSize);
  const markdownBodyColor = theme["--color-md-body"];
  const markdownStrongColor = theme["--color-md-strong"];
  const markdownLinkColor = theme["--color-md-link"];
  const markdownBlockquoteBorder = theme["--color-md-blockquote-border"];
  const markdownCodeBg = theme["--color-md-code-bg"];
  const markdownCodeText = theme["--color-md-code-text"];
  const markdownInlineCodeText = theme["--color-foreground-secondary"];
  const markdownHrColor = theme["--color-md-hr"];
  // Native chip drawing parses opaque hex only, and this role is translucent.
  const contextChipBorderColor = flattenThemeColor(
    theme["--color-border"],
    theme["--color-user-bubble"],
  );
  const markdownUserBodyColor = theme["--color-user-bubble-foreground"];
  const markdownUserCodeBg = theme["--color-md-user-code-bg"];
  const markdownUserCodeText = theme["--color-md-user-code-text"];
  const markdownUserInlineCodeText = theme["--color-user-bubble-foreground-muted"];
  const markdownUserFenceBg = theme["--color-md-user-fence-bg"];
  const regularFontFamily = FONT_FAMILIES.regular;
  const boldFontFamily = FONT_FAMILIES.bold;

  return {
    user: {
      nativeTextStyle: {
        color: markdownUserBodyColor,
        strongColor: markdownUserBodyColor,
        mutedColor: markdownUserBodyColor,
        linkColor: themeColorWithContrast(markdownLinkColor, theme["--color-user-bubble"]),
        inlineCodeColor: markdownUserInlineCodeText,
        codeColor: markdownUserCodeText,
        codeBackgroundColor: markdownUserCodeBg,
        codeBlockBackgroundColor: markdownUserFenceBg,
        fileTextColor: markdownUserBodyColor,
        quoteMarkerColor: markdownUserBodyColor,
        dividerColor: markdownUserBodyColor,
        contextChipBorderColor,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    },
    assistant: {
      nativeTextStyle: {
        color: markdownBodyColor,
        strongColor: markdownStrongColor,
        mutedColor: markdownBodyColor,
        linkColor: markdownLinkColor,
        inlineCodeColor: markdownInlineCodeText,
        codeColor: markdownCodeText,
        codeBackgroundColor: markdownCodeBg,
        codeBlockBackgroundColor: markdownCodeBg,
        fileTextColor: markdownCodeText,
        quoteMarkerColor: markdownBlockquoteBorder,
        dividerColor: markdownHrColor,
        contextChipBorderColor,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    },
  };
}

type UserMessageContentProps = {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly context?: OrchestrationMessageContext;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
};

export function UserMessageContent(props: UserMessageContentProps) {
  const gt = useGT();
  const [selected, setSelected] = useState<{ contextId: string; label: string } | null>(null);
  const navigation = useNavigation();
  const openThreadLink = useOpenThreadLink(props.environmentId);
  const { selectedThread } = useThreadSelection();
  const liveText = useLiveThreadLinkLabels(
    props.text,
    props.environmentId,
    useLinkedEnvironments(
      hasThreadLinks(props.text) ? props.environmentId : null,
      linkedThreadEnvironmentIds(props.text, props.environmentId),
    ),
  );
  const threadIcons = useThreadChipIcons(props.environmentId, liveText, props.context?.records);
  const text = replaceComposerContextReferences(liveText, (ref) => {
    const available = props.context?.records.some((record) => record.contextId === ref.contextId);
    const label = available ? ref.label : gt("{label} (unavailable)", { label: ref.label });
    return `[${label}](zerocode-context://v1/${ref.kind}/${ref.contextId})`;
  });
  const onLinkPress = (href: string) => {
    const reference = parseComposerContextHref(href);
    if (!reference) return props.linkHandlers.onLinkPress?.(href);
    const record = props.context?.records.find(
      (record) => record.contextId === reference.contextId,
    );
    if (record?.kind === "mention" && "path" in record) {
      props.linkHandlers.onLinkPress?.(record.path);
      return;
    }
    if (record?.kind === "thread" && "threadId" in record) {
      openThreadLink(scopeThreadRef(record.environmentId, record.threadId));
      return;
    }
    const document = composerDocumentAttachmentRecord(record);
    if (document) {
      navigation.navigate("ThreadAttachment", {
        environmentId: String(props.environmentId),
        ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
        attachmentId: document.attachmentId,
        name: document.name,
        mimeType: document.mimeType,
        sizeBytes: String(document.sizeBytes),
      });
      return;
    }
    setSelected({
      contextId: reference.contextId,
      label: record?.label ?? gt("Context unavailable"),
    });
  };
  return (
    <>
      <UserMessageMarkdownContent
        {...props}
        text={text}
        linkHandlers={{
          ...props.linkHandlers,
          onLinkPress,
          fileContextMenu: (href) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.fileContextMenu(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            return {
              title: record?.label ?? gt("Context unavailable"),
              actions: [
                { id: "open-context", title: gt("Open context") },
                { id: "copy-context", title: gt("Copy context"), disabled: !record },
              ],
            };
          },
          onFileContextMenuAction: (href, actionId) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.onFileContextMenuAction(href, actionId);
            if (actionId === "open-context") return onLinkPress(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            if (actionId === "copy-context" && record) {
              void writeComposerContextClipboard(
                formatComposerContextReference({
                  ...reference,
                  label: record.label,
                }),
                {
                  version: 1,
                  source: { environmentId: props.environmentId },
                  records: [record],
                },
              )
                .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
                .catch(() => {
                  Dialog.alert(gt("Could not copy context"), gt("Try copying this context again."));
                });
            }
          },
          linkCustomization: (href) =>
            withChipIcon(
              enrichedContextLinkCustomization(href, props.context?.records ?? []) ??
                props.linkHandlers.linkCustomization?.(href),
              threadIcons.get(href),
            ),
        }}
      />
      {selected ? (
        <ComposerContextSheet
          label={selected.label}
          environmentId={props.environmentId}
          records={props.context?.records}
          record={props.context?.records.find((record) => record.contextId === selected.contextId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function UserMessageMarkdownContent(props: UserMessageContentProps) {
  const text = props.text;
  const models = useModelMentions(props.environmentId, text);
  const messages = useMessages();
  const segments = parseReviewCommentMessageSegments(text, messages);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  const contextClipboardFragment = props.context
    ? (encodeComposerContextFragment({
        version: 1,
        source: { environmentId: props.environmentId },
        records: props.context.records,
      }) ?? undefined)
    : undefined;
  if (!hasReviewComment) {
    return (
      <SelectableMarkdownText
        markdown={text}
        contextClipboardFragment={contextClipboardFragment}
        skills={props.skills}
        models={models}
        textStyle={props.markdownStyles.nativeTextStyle}
        preserveSoftBreaks
        {...props.linkHandlers}
        renderImage={props.renderImage}
      />
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            contextClipboardFragment={contextClipboardFragment}
            skills={props.skills}
            models={models}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            {...props.linkHandlers}
            renderImage={props.renderImage}
          />
        );
      })}
    </View>
  );
}
