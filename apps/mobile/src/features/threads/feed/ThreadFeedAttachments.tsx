import { useGT, useMessages } from "gt-react-native";
import { m } from "../../../i18n/messages";
import { errorDisplayMessage } from "@zerocode/client-runtime/errors";
import * as Dialog from "../../../components/ui/Dialog";
import {
  ThreadMarkdownVideo,
  ThreadMediaRetainContext,
  ThreadMediaVisibleContext,
} from "../ThreadMarkdownVideo";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { useViewabilityAmount } from "@legendapp/list/react-native";
import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  ThreadId,
} from "@zerocode/contracts";
import { resolveAssetUrl } from "@zerocode/client-runtime/state/assets";
import { formatAttachmentSize } from "@zerocode/client-runtime/state/attachments";
import { settlePromise, squashAtomCommandFailure } from "@zerocode/client-runtime/state/runtime";
import { imageMimeType } from "@zerocode/shared/image";
import { videoMimeType } from "@zerocode/shared/video";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useResolveClassNames } from "uniwind";
import { useFilePreviewGallery } from "../../../components/ui/FilePreviewGallery";
import { assetImageSource } from "../../../lib/assetImageSource";
import {
  filePreviewSourceIdentifier,
  remoteAttachmentImageSource,
} from "../../../lib/filePreviewGallery";
import { composerImageGallery } from "../../../lib/composerImageGallery";
import {
  isFileBackedComposerAttachment,
  type FileBackedComposerAttachment,
} from "../../../lib/composerImages";
import { useLocalAttachmentPreview } from "../../../lib/localAttachmentPreview";
import {
  rememberSentImage,
  sentImageHandoff,
  type SentImageHandoff,
} from "../../../lib/sentImageHandoff";
import { messageImageGallery } from "../messageImageGallery";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "../markdownImageSize";
import type { FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import type { FilePreviewItem } from "../../../components/ui/FilePreviewModal.types";
import { inlineFilePreviewKind, isPdfFile } from "../../../lib/filePreview";
import { ThreadInlineFilePreview } from "../ThreadInlineFilePreview";
import { PresentationSource } from "../../../components/ui/NativePresentation";
import { downloadAndShareAttachment } from "../../../lib/attachmentDownload";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  attachmentVideoPreviewSource,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../../lib/videoPreviewSource";
import { PierreEntryIcon } from "../../../components/PierreEntryIcon";
import type { ThreadFeedEntry } from "../../../lib/threadActivity";
import type { GroupedThreadFeedRow } from "../pending-thread-feed";
import type { QueuedThreadMessage } from "../../../state/thread-outbox-model";
import { assetEnvironment, useAssetUrl, useRefreshAssetUrl } from "../../../state/assets";
import { useAtomQueryRunner } from "../../../state/use-atom-query-runner";
import { usePreparedConnection } from "../../../state/session";
import { useThreadSelection } from "../../../state/use-thread-selection";
import * as Option from "effect/Option";
import { ZoomableImagePressable } from "../ZoomableImagePressable";

export const EMPTY_FILE_PREVIEW_GALLERY: readonly FilePreviewItem[] = [];

const handoffProps = (handoff: SentImageHandoff | undefined) => (handoff ? { handoff } : {});

function MessageImage(props: {
  readonly source: ComponentPropsWithRef<typeof ExpoImage>["source"];
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly accessibilityLabel: string;
  readonly handoff?: SentImageHandoff;
  readonly onPress: () => void;
  readonly onLoad?: (size: { readonly width: number; readonly height: number }) => void;
  readonly onError?: () => void;
}) {
  const imageStyle = useResolveClassNames(props.className);
  const [loadedSize, setSize] = useState<{ width: number; height: number } | null>(null);
  // Until it loads, assume a handed-off image is a photo larger than the bubble's caps.
  const size =
    loadedSize ??
    (props.handoff ? { width: props.handoff.aspectRatio * 4096, height: 4096 } : null);
  const contentFit = props.maxWidth === undefined ? "cover" : "contain";
  const displaySize =
    props.maxWidth !== undefined && size !== null
      ? resolveMarkdownImageDisplaySize({
          sourceWidth: size.width,
          sourceHeight: size.height,
          availableWidth: props.maxWidth,
        })
      : null;
  return (
    <ZoomableImagePressable
      accessibilityRole="imagebutton"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={[
        imageStyle,
        { overflow: "hidden" },
        props.maxWidth !== undefined
          ? (displaySize ?? {
              width: Math.min(props.maxWidth, MARKDOWN_IMAGE_MAX_WIDTH),
              aspectRatio: 1.3,
            })
          : props.height !== undefined
            ? { height: props.height }
            : undefined,
      ]}
    >
      <ExpoImage
        source={props.source}
        cachePolicy="memory-disk"
        style={{ width: "100%", height: "100%" }}
        contentFit={contentFit}
        placeholder={props.handoff ? { uri: props.handoff.uri } : undefined}
        placeholderContentFit={contentFit}
        onLoad={(event) => {
          if (props.maxWidth !== undefined) setSize(event.source);
          props.onLoad?.(event.source);
        }}
        onError={props.onError}
      />
    </ZoomableImagePressable>
  );
}

export function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly handoff?: SentImageHandoff;
  readonly onImageLoad?: (image: SentImageHandoff) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const gt = useGT();
  const withGallery = useFilePreviewGallery();
  const previewSource = remoteAttachmentImageSource(props.environmentId, props.attachmentId, props);
  const { resource } = previewSource;
  const sourceIdentifier = filePreviewSourceIdentifier(previewSource);
  const uri = useAssetUrl(props.environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(props.environmentId, resource);
  const retriedImage = useRef(false);
  const { handoff } = props;
  const source =
    uri !== null
      ? assetImageSource(props.environmentId, resource, uri)
      : handoff !== undefined
        ? { uri: handoff.uri }
        : null;

  if (source === null) {
    return (
      <View
        className={`${props.className} items-center justify-center`}
        style={
          props.maxWidth !== undefined
            ? { width: Math.min(props.maxWidth, MARKDOWN_IMAGE_MAX_WIDTH), aspectRatio: 1.3 }
            : props.height !== undefined
              ? { height: props.height }
              : undefined
        }
      >
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <MessageImage
        key={props.attachmentId}
        source={source}
        className={props.className}
        maxWidth={props.maxWidth}
        height={props.height}
        accessibilityLabel={gt("Open {name}", { name: props.name })}
        {...handoffProps(handoff)}
        onPress={() => props.onPressPreview(withGallery({ ...previewSource, sourceIdentifier }))}
        onLoad={(size) => {
          retriedImage.current = false;
          if (handoff)
            props.onImageLoad?.({ uri: handoff.uri, aspectRatio: size.width / size.height });
        }}
        onError={() => {
          if (retriedImage.current) return;
          retriedImage.current = true;
          void refreshAssetUrl();
        }}
      />
    </PresentationSource>
  );
}

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

export function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

export function isMediaAttachment(attachment: ChatAttachment): boolean {
  return (
    isImageAttachment(attachment) ||
    (isFileAttachment(attachment) && videoMimeType(attachment) !== null)
  );
}

export function MessageAttachmentFile(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
  readonly standaloneFile?: boolean;
  readonly available?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const sourceIdentifier = useId();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const { attachment } = props;
  const videoType = videoMimeType(attachment);
  const isPdf = isPdfFile(attachment);
  const fileTypeLabel = isPdf
    ? "PDF"
    : (attachment.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() ??
      gt("File", { $context: "generic file type label" }));
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes, messages);
  const httpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;
  const openingRef = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setOpening(false);
      return () => {
        openingRef.current?.abort();
        openingRef.current = null;
      };
      // oxlint-disable-next-line react/memo-dependencies -- Changing the attachment or connection cancels the previous file open even while this screen stays focused.
    }, [props.environmentId, attachment.id, httpBaseUrl]),
  );

  const shareFile = (sourceIdentifier?: string) => {
    if (props.available === false || httpBaseUrl === null || openingRef.current) return;
    const controller = new AbortController();
    openingRef.current = controller;
    setOpening(true);
    const finish = (message: string | null) => {
      if (message !== null && !controller.signal.aborted) {
        Dialog.alert(gt("Could not open attachment"), message);
      }
      if (openingRef.current === controller) {
        openingRef.current = null;
        setOpening(false);
      }
    };
    void (async () => {
      const result = await createAssetUrl({
        environmentId: props.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (controller.signal.aborted) return finish(null);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        return finish(errorDisplayMessage(error, m) ?? gt("The attachment is unavailable."));
      }
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (url === null) return finish(gt("The attachment could not be opened."));
      const shared = await settlePromise(() =>
        downloadAndShareAttachment({
          url,
          attachment,
          signal: controller.signal,
          sourceIdentifier,
        }),
      );
      if (shared._tag === "Failure") {
        const error = squashAtomCommandFailure(shared);
        return finish(errorDisplayMessage(error, m) ?? gt("The attachment is unavailable."));
      }
      finish(null);
    })();
  };

  const openAttachment = () =>
    isPdf
      ? props.onPressPreview({
          kind: "pdf",
          name: attachment.name,
          environmentId: props.environmentId,
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: "application/pdf",
          },
          sourceIdentifier,
        })
      : navigation.navigate("ThreadAttachment", {
          environmentId: String(props.environmentId),
          ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
          attachmentId: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: String(attachment.sizeBytes),
        });
  const inlineKind = inlineFilePreviewKind(attachment);
  if (inlineKind) {
    return (
      <PresentationSource identifier={sourceIdentifier}>
        <ThreadInlineFilePreview
          key={attachment.id}
          source={{
            kind: "document",
            name: attachment.name,
            mimeType: attachment.mimeType,
            environmentId: props.environmentId,
            resource: {
              _tag: "attachment",
              attachmentId: attachment.id,
              fileName: attachment.name,
              mimeType: attachment.mimeType,
              disposition: "inline",
            },
          }}
          sizeBytes={attachment.sizeBytes}
          onOpen={openAttachment}
          onPlaybackStart={props.onPlaybackStart}
          onLongPress={() => shareFile(sourceIdentifier)}
        />
      </PresentationSource>
    );
  }

  if (videoType !== null) {
    return (
      <View className="my-1" style={{ width: 224, maxWidth: "100%" }}>
        <ThreadMarkdownVideo
          source={attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier)}
          onPlaybackStart={props.onPlaybackStart}
        />
      </View>
    );
  }

  const disabled = props.available === false || opening || httpBaseUrl === null;
  return (
    <PresentationSource
      identifier={sourceIdentifier}
      className="my-1"
      style={{ width: 280, maxWidth: "100%" }}
    >
      <View className="min-w-0 flex-row items-center overflow-hidden rounded-xl border border-border bg-card">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Open {name}", { name: attachment.name })}
          accessibilityValue={{ text: `${fileTypeLabel}, ${sizeLabel}` }}
          accessibilityState={{ disabled, busy: opening }}
          disabled={disabled}
          className="min-w-0 flex-1 flex-row items-center gap-3 p-3 active:bg-subtle"
          onLongPress={() => shareFile(sourceIdentifier)}
          onPress={openAttachment}
        >
          <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
            {opening ? (
              <AppActivityIndicator size="small" />
            ) : (
              <PierreEntryIcon path={attachment.name} kind="file" size={26} />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-zerocode-medium text-sm text-foreground" numberOfLines={2}>
              {attachment.name}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {fileTypeLabel} · {sizeLabel}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </Pressable>
        {props.standaloneFile ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Download {name}", { name: attachment.name })}
            accessibilityState={{ disabled, busy: opening }}
            disabled={disabled}
            className="mr-1 min-h-11 w-11 items-center justify-center rounded-lg active:bg-subtle disabled:opacity-40"
            onPress={() => shareFile(sourceIdentifier)}
          >
            <SymbolView name="arrow.down" size={16} tintColorClassName="accent-foreground-muted" />
          </Pressable>
        ) : null}
      </View>
    </PresentationSource>
  );
}

function PendingMessageImage(props: {
  readonly attachment: QueuedThreadMessage["attachments"][number];
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly handoff?: SentImageHandoff;
  readonly onImageLoad?: (image: SentImageHandoff) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const gt = useGT();
  const withGallery = useFilePreviewGallery();
  const { attachment, handoff } = props;
  const fileBacked = isFileBackedComposerAttachment(attachment);
  const preview = useLocalAttachmentPreview(fileBacked ? attachment : null);
  // The composer already showed this image; reuse its pixels and shape instead of a blank box.
  const uri =
    handoff?.uri ?? (fileBacked ? preview.uri : (attachment.dataUrl ?? attachment.previewUri));
  return (
    <MessageImage
      key={attachment.id}
      source={uri == null ? undefined : { uri }}
      className={props.className}
      maxWidth={props.maxWidth}
      height={props.height}
      accessibilityLabel={gt("Open {name}", { name: attachment.name })}
      {...handoffProps(handoff)}
      onLoad={(size) => {
        if (uri) props.onImageLoad?.({ uri, aspectRatio: size.width / size.height });
      }}
      onPress={() => {
        const source = composerImageGallery([attachment])[0];
        if (source) props.onPressPreview(withGallery(source));
      }}
    />
  );
}

/**
 * A sent video from queueing through delivery. Every stage renders this one player under a
 * thumbnail key of message and position, so swapping the local file for the server copy keeps
 * the poster on screen instead of remounting to black and extracting a frame again.
 */
function UserMessageVideo(props: {
  readonly environmentId: EnvironmentId;
  readonly messageId: string;
  readonly index: number;
  readonly local: FileBackedComposerAttachment | null;
  readonly uploaded: ChatFileAttachment | null;
  readonly onPlaybackStart: () => void;
}) {
  const sourceIdentifier = useId();
  const preview = useLocalAttachmentPreview(props.local);
  const current: MediaVideoPreviewSource | null =
    props.local !== null && preview.uri !== null
      ? {
          type: "media",
          name: props.local.name,
          mimeType: props.local.mimeType,
          uri: preview.uri,
        }
      : props.uploaded !== null
        ? attachmentVideoPreviewSource(props.environmentId, props.uploaded, sourceIdentifier)
        : null;
  // Each copy of a message reopens its local file; keep the last source while the next one loads.
  const [shown, setShown] = useState(current);
  if (
    current !== null &&
    (shown === null || mediaVideoThumbnailKey(current) !== mediaVideoThumbnailKey(shown))
  ) {
    setShown(current);
  }
  const source = current ?? shown;
  if (source === null) {
    return (
      <View className="aspect-video items-center justify-center bg-black">
        {preview.error ? (
          <Text className="p-3 text-center text-xs text-white/70">{preview.error.message}</Text>
        ) : (
          <AppActivityIndicator />
        )}
      </View>
    );
  }
  return (
    <ThreadMarkdownVideo
      source={source}
      thumbnailKey={JSON.stringify(["user-message-video", props.messageId, props.index])}
      onPlaybackStart={props.onPlaybackStart}
      borderRadius={20}
    />
  );
}

export function UserMessageMedia(props: {
  readonly messageId: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly pendingAttachments: QueuedThreadMessage["attachments"];
  readonly environmentId: EnvironmentId;
  readonly maxWidth: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
}) {
  const attachments = [...props.pendingAttachments, ...props.attachments];
  const collage = attachments.length > 1 && attachments.every(isImageAttachment);
  const imageProps = (index: number) => ({
    className: "w-full bg-user-bubble-foreground/15",
    maxWidth: collage ? undefined : props.maxWidth,
    height: !collage
      ? undefined
      : attachments.length === 2 || (attachments.length === 3 && index === 0)
        ? 192
        : attachments.length === 3
          ? (192 - StyleSheet.hairlineWidth) / 2
          : 96,
  });
  const media = [
    ...props.pendingAttachments.map((attachment, index) => {
      const image = isImageAttachment(attachment);
      return {
        image,
        content:
          image && attachment.uploadedAttachmentId ? (
            <MessageAttachmentImage
              environmentId={props.environmentId}
              attachmentId={attachment.uploadedAttachmentId}
              name={attachment.name}
              mimeType={attachment.mimeType}
              {...imageProps(index)}
              {...handoffProps(sentImageHandoff(props.messageId, index, attachment.id))}
              onImageLoad={(loaded) => rememberSentImage(props.messageId, index, loaded)}
              onPressPreview={props.onPressPreview}
            />
          ) : !image ? (
            <UserMessageVideo
              environmentId={props.environmentId}
              messageId={props.messageId}
              index={index}
              local={isFileBackedComposerAttachment(attachment) ? attachment : null}
              uploaded={
                attachment.uploadedAttachmentId === undefined
                  ? null
                  : { ...attachment, type: "file", id: attachment.uploadedAttachmentId }
              }
              onPlaybackStart={props.onPlaybackStart}
            />
          ) : (
            <PendingMessageImage
              attachment={attachment}
              {...imageProps(index)}
              {...handoffProps(sentImageHandoff(props.messageId, index, attachment.id))}
              onImageLoad={(image) => rememberSentImage(props.messageId, index, image)}
              onPressPreview={props.onPressPreview}
            />
          ),
      };
    }),
    ...props.attachments.map((attachment, index) => ({
      image: isImageAttachment(attachment),
      content: isImageAttachment(attachment) ? (
        <MessageAttachmentImage
          environmentId={props.environmentId}
          attachmentId={attachment.id}
          name={attachment.name}
          mimeType={attachment.mimeType}
          {...imageProps(props.pendingAttachments.length + index)}
          {...handoffProps(sentImageHandoff(props.messageId, index))}
          onPressPreview={props.onPressPreview}
        />
      ) : isFileAttachment(attachment) ? (
        <UserMessageVideo
          environmentId={props.environmentId}
          messageId={props.messageId}
          index={index}
          local={null}
          uploaded={attachment}
          onPlaybackStart={props.onPlaybackStart}
        />
      ) : null,
    })),
  ];
  return collage ? (
    <View
      className="overflow-hidden rounded-[20px] bg-border"
      style={{ width: 320, maxWidth: "100%", alignSelf: "flex-end", gap: StyleSheet.hairlineWidth }}
    >
      {media.length === 3 ? (
        <View className="flex-row" style={{ gap: StyleSheet.hairlineWidth }}>
          <View className="min-w-0" style={{ flex: 3 }}>
            {media[0]!.content}
          </View>
          <View className="min-w-0" style={{ flex: 2, gap: StyleSheet.hairlineWidth }}>
            {media[1]!.content}
            {media[2]!.content}
          </View>
        </View>
      ) : (
        media
          .filter((_, index) => index % 2 === 0)
          .map((item, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- delivery re-ids attachments; position is the stable identity
            <View key={index} className="flex-row" style={{ gap: StyleSheet.hairlineWidth }}>
              <View className="min-w-0 flex-1">{item.content}</View>
              {media[index * 2 + 1] ? (
                <View className="min-w-0 flex-1">{media[index * 2 + 1]!.content}</View>
              ) : null}
            </View>
          ))
      )}
      <View pointerEvents="none" className="absolute inset-0 rounded-[20px] border border-border" />
    </View>
  ) : (
    <View className="items-end gap-2">
      {media.map((item, index) => (
        <View
          // oxlint-disable-next-line react/no-array-index-key -- delivery re-ids attachments; a new key would remount the media
          key={index}
          className="overflow-hidden rounded-[20px]"
          style={{ width: item.image ? undefined : 320, maxWidth: "100%" }}
        >
          {item.content}
          <View
            pointerEvents="none"
            className="absolute inset-0 rounded-[20px] border border-border"
          />
        </View>
      ))}
    </View>
  );
}

/** A message's files as its bubble shows them; a guest's waiting message uses it too. */
export function MessageAttachmentList(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
}) {
  return props.attachments.map((attachment) =>
    isImageAttachment(attachment) ? (
      <MessageAttachmentImage
        key={attachment.id}
        environmentId={props.environmentId}
        attachmentId={attachment.id}
        name={attachment.name}
        mimeType={attachment.mimeType}
        className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-subtle-strong"
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
    ),
  );
}

export function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <PierreEntryIcon path={props.name} kind="file" size={16} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

export function ThreadMediaVisibility(props: {
  readonly rowId: string;
  readonly setRetainedRowId: Dispatch<SetStateAction<string | null>>;
  readonly children: ReactNode;
}) {
  const { rowId, setRetainedRowId } = props;
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  const retain = useCallback(
    (retained: boolean) =>
      setRetainedRowId((current) => (retained ? rowId : current === rowId ? null : current)),
    [rowId, setRetainedRowId],
  );
  return (
    <ThreadMediaRetainContext value={retain}>
      <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>
    </ThreadMediaRetainContext>
  );
}

export function buildMessageGalleriesById(
  groupedFeed: ReadonlyArray<GroupedThreadFeedRow>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  workspaceRoot: string | null | undefined,
): Map<string, readonly FilePreviewItem[]> {
  const galleries = new Map<string, readonly FilePreviewItem[]>();
  const context = { environmentId, threadId, workspaceRoot };
  for (const entry of groupedFeed) {
    if (entry.type !== "message") continue;
    const messageImages = messageImageGallery(entry.message, context);
    const pendingAttachments = entry.pendingMessage?.attachments;
    const pendingImages =
      pendingAttachments && pendingAttachments.length > 0
        ? composerImageGallery(pendingAttachments, environmentId)
        : EMPTY_FILE_PREVIEW_GALLERY;
    if (messageImages.length === 0 && pendingImages.length === 0) continue;
    galleries.set(
      entry.id,
      pendingImages.length === 0
        ? messageImages
        : messageImages.length === 0
          ? pendingImages
          : [...messageImages, ...pendingImages],
    );
  }
  return galleries;
}
