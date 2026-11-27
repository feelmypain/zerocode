import { formatComposerModelMention } from "@zerocode/client-runtime/composer-model-mentions";
import type {
  EnvironmentContextRecord,
  EnvironmentId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
} from "@zerocode/contracts";
import { threadContextRecord } from "@zerocode/shared/composerContextReferences";
import { serializeComposerFileLink } from "@zerocode/shared/composerTrigger";
import { USAGE_LIMITS_COMMAND } from "@zerocode/shared/usageLimits";
import { type Dispatch, type RefObject, type SetStateAction, useRef } from "react";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  environmentContextRecord,
  environmentContextReference,
  reviewCommentContextId,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
} from "~/lib/composerContextRecords";
import {
  collectInlineContextIds,
  formatInlineContextReference,
} from "~/lib/composerContextReferences";
import { readThreadShell } from "~/state/entities";
import {
  collapseExpandedComposerCursor,
  type ComposerTrigger,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  extendReplacementRangeForTrailingSpace,
  isPathSuggestionCurrent,
  replaceTextRange,
} from "../../composer-logic";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { PendingUserInput } from "../../session-logic";
import type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { buildPullRequestReferenceContext } from "../pullRequest/pullRequestDetail.logic";
import type { ChatComposerProps } from "./ChatComposer";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  type QueuedAttachmentContextBinding,
  reconcileAttachmentContextReferences,
  useRetainedContextPayloads,
} from "./composerContextUndo";
import type { ComposerPromptHistoryPosition } from "./composerPromptHistory";

interface ChatComposerPromptChangeInput {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly attachmentDraftTarget: ComposerThreadTarget;
  readonly composerDraftTargetKey: string;
  readonly composerCursor: number;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: (trigger: ComposerTrigger | null) => void;
  readonly followComposerCaret: (trigger: ComposerTrigger | null) => void;
  readonly resolveComposerTrigger: (trigger: ComposerTrigger | null) => ComposerTrigger | null;
  readonly isLiteralPendingAnswer: boolean;
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerImages: ComposerImageAttachment[];
  readonly composerFiles: ComposerFileAttachment[];
  readonly composerTerminalContexts: TerminalContextDraft[];
  readonly composerPreviewAnnotations: PreviewAnnotationPayload[];
  readonly composerReviewComments: ReviewCommentContext[];
  readonly composerThreadContexts: ThreadContextRecord[];
  readonly composerEnvironmentContexts: EnvironmentContextRecord[];
  readonly activeEditingQueuedAttachments: ChatComposerProps["editingQueuedAttachments"];
  readonly activeRemovedEditingQueuedAttachments:
    | ReadonlyArray<QueuedAttachmentContextBinding>
    | undefined;
  readonly onRemoveEditingQueuedAttachment: (attachmentId: string) => void;
  readonly onRestoreEditingQueuedAttachment:
    | ChatComposerProps["onRestoreEditingQueuedAttachment"]
    | undefined;
  readonly onChangeActivePendingUserInputCustomAnswer: ChatComposerProps["onChangeActivePendingUserInputCustomAnswer"];
  readonly onTypingGuardDraftChange: () => void;
  readonly refreshWorkspaceSnapshotOnTyping: () => void;
  readonly clearComposerMenuHighlight: () => void;
  readonly setIsComposerModelPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly onFreshSession: (() => void) | undefined;
  readonly sideChatDisabledReason: string | null | undefined;
  readonly onUsageLimitsCommand: (() => void) | undefined;
  readonly promptRef: RefObject<string>;
  readonly promptHistoryPositionRef: RefObject<{
    targetKey: string;
    position: ComposerPromptHistoryPosition;
  } | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
}

export function useChatComposerPromptChange(input: ChatComposerPromptChangeInput) {
  const {
    environmentId,
    gitCwd,
    composerDraftTarget,
    attachmentDraftTarget,
    composerDraftTargetKey,
    composerCursor,
    setComposerCursor,
    setComposerTrigger,
    followComposerCaret,
    resolveComposerTrigger,
    isLiteralPendingAnswer,
    activePendingProgress,
    activePendingUserInput,
    pendingUserInputs,
    composerImages,
    composerFiles,
    composerTerminalContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    composerEnvironmentContexts,
    activeEditingQueuedAttachments,
    activeRemovedEditingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
    onRestoreEditingQueuedAttachment,
    onChangeActivePendingUserInputCustomAnswer,
    onTypingGuardDraftChange,
    refreshWorkspaceSnapshotOnTyping,
    clearComposerMenuHighlight,
    setIsComposerModelPickerOpen,
    onFreshSession,
    sideChatDisabledReason,
    onUsageLimitsCommand,
    promptRef,
    promptHistoryPositionRef,
    composerEditorRef,
    composerMenuItemsRef,
  } = input;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const addComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.addEnvironmentContexts,
  );
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );
  const composerSelectLockRef = useRef(false);
  const retainedContextPayloads = useRetainedContextPayloads(composerDraftTargetKey);

  const setPrompt = (nextPrompt: string) => {
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
  };

  const onPromptChange = (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
    textChanged: boolean,
    fromHistory = false,
  ) => {
    refreshWorkspaceSnapshotOnTyping();
    const trigger = cursorAdjacentToMention
      ? null
      : detectComposerTrigger(nextPrompt, expandedCursor);
    const updateTrigger = textChanged ? setComposerTrigger : followComposerCaret;
    if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
      if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
      setComposerCursor(nextCursor);
      updateTrigger(trigger);
      onChangeActivePendingUserInputCustomAnswer(
        activePendingProgress.activeQuestion.id,
        nextPrompt,
        nextCursor,
        expandedCursor,
        cursorAdjacentToMention,
      );
      return;
    }
    if (textChanged) {
      onTypingGuardDraftChange();
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (promptHistoryPositionRef.current?.position.recalled !== nextPrompt) {
        promptHistoryPositionRef.current = null;
      }
      const referenced = new Set(contextIds);
      const retained = retainedContextPayloads;

      const liveTerminalIds = new Set<string>(
        composerTerminalContexts.map((context) => terminalContextReference(context).contextId),
      );
      const restoredTerminals = [...referenced].flatMap((contextId) => {
        if (liveTerminalIds.has(contextId)) return [];
        const context = retained.terminals.get(contextId);
        return context ? [context] : [];
      });
      const nextTerminals = [
        ...composerTerminalContexts.filter((context) =>
          referenced.has(terminalContextReference(context).contextId),
        ),
        ...restoredTerminals,
      ];
      for (const context of composerTerminalContexts) {
        const contextId = terminalContextReference(context).contextId;
        if (!referenced.has(contextId)) retained.terminals.set(contextId, context);
      }
      if (
        nextTerminals.length !== composerTerminalContexts.length ||
        restoredTerminals.length > 0
      ) {
        setComposerDraftTerminalContexts(composerDraftTarget, nextTerminals);
      }

      const liveThreadIds = new Set<string>(
        composerThreadContexts.map((record) => record.contextId),
      );
      const restoredThreads = [...referenced].flatMap((contextId) => {
        if (liveThreadIds.has(contextId)) return [];
        const record = retained.threads.get(contextId);
        return record ? [record] : [];
      });
      const nextThreads = [
        ...composerThreadContexts.filter((record) => referenced.has(record.contextId)),
        ...restoredThreads,
      ];
      for (const record of composerThreadContexts) {
        if (!referenced.has(record.contextId)) retained.threads.set(record.contextId, record);
      }
      if (nextThreads.length !== composerThreadContexts.length || restoredThreads.length > 0) {
        setComposerDraftThreadContexts(composerDraftTarget, nextThreads);
      }

      const liveEnvironmentIds = new Set<string>(
        composerEnvironmentContexts.map((record) => record.contextId),
      );
      const restoredEnvironments = [...referenced].flatMap((contextId) => {
        if (liveEnvironmentIds.has(contextId)) return [];
        const record = retained.environments.get(contextId);
        return record ? [record] : [];
      });
      const nextEnvironments = [
        ...composerEnvironmentContexts.filter((record) => referenced.has(record.contextId)),
        ...restoredEnvironments,
      ];
      for (const record of composerEnvironmentContexts) {
        if (!referenced.has(record.contextId)) retained.environments.set(record.contextId, record);
      }
      if (
        nextEnvironments.length !== composerEnvironmentContexts.length ||
        restoredEnvironments.length > 0
      ) {
        setComposerDraftEnvironmentContexts(composerDraftTarget, nextEnvironments);
      }

      for (const comment of composerReviewComments) {
        const contextId = reviewCommentContextId(comment.id);
        if (!referenced.has(contextId)) {
          retained.reviewComments.set(contextId, comment);
          removeComposerDraftReviewComment(composerDraftTarget, comment.id);
        }
      }
      const liveReviewIds = new Set<string>(
        composerReviewComments.map((comment) => reviewCommentContextId(comment.id)),
      );
      for (const contextId of referenced) {
        if (liveReviewIds.has(contextId)) continue;
        const comment = retained.reviewComments.get(contextId);
        if (comment) {
          addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
        }
      }

      const attachmentChanges = reconcileAttachmentContextReferences({
        referencedContextIds: referenced,
        files: composerFiles,
        queuedAttachments: (activeEditingQueuedAttachments ?? []).map(
          ({ attachment, contextIds: queuedIds }) => ({
            attachment,
            contextIds: queuedIds ?? [],
          }),
        ),
        removedQueuedAttachments: activeRemovedEditingQueuedAttachments ?? [],
        fromHistory,
        images: composerImages,
        previewAnnotations: composerPreviewAnnotations,
        retained: retainedContextPayloads,
      });
      for (const annotationId of attachmentChanges.annotationIdsToRemove) {
        removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
      }
      for (const restored of attachmentChanges.annotationsToRestore) {
        if (restored.image) addComposerDraftImages(attachmentDraftTarget, [restored.image]);
        addComposerDraftPreviewAnnotation(composerDraftTarget, restored.annotation, {
          appendReference: false,
        });
      }
      for (const fileId of attachmentChanges.filesToRemove) {
        removeComposerDraftFile(attachmentDraftTarget, fileId);
      }
      if (attachmentChanges.filesToRestore.length > 0) {
        addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
      }
      for (const attachmentId of attachmentChanges.queuedAttachmentIdsToRemove) {
        onRemoveEditingQueuedAttachment(attachmentId);
      }
      for (const attachment of attachmentChanges.queuedAttachmentsToRestore) {
        onRestoreEditingQueuedAttachment?.(attachment);
      }
    }
    setComposerCursor(nextCursor);
    updateTrigger(trigger);
  };
  const onPromptChangeStable = useStableCallback(onPromptChange);

  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: {
        start: number;
        sourceAnchor: AssistantCitationSourceAnchor;
        insertedSpaces: ComposerCitationCommentRequest["insertedSpaces"];
      };
    },
  ): boolean => {
    if (
      activePendingUserInput &&
      activePendingProgress?.activeQuestion?.allowCustomAnswer === false
    ) {
      return false;
    }
    const currentText = promptRef.current;
    const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
    if (
      options?.expectedText !== undefined &&
      currentText.slice(safeStart, safeEnd) !== options.expectedText
    ) {
      return false;
    }
    const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(
      next.text,
      options?.expandedCursorAfterReplace ?? next.cursor,
      isLiteralPendingAnswer,
    );
    const nextExpandedCursor = expandCollapsedComposerCursor(
      next.text,
      nextCursor,
      isLiteralPendingAnswer,
    );
    if (options?.citationComment) {
      composerEditorRef.current?.requestCitationComment({
        previousValue: currentText,
        value: next.text,
        citationStart: options.citationComment.start,
        sourceAnchor: options.citationComment.sourceAnchor,
        insertedSpaces: options.citationComment.insertedSpaces,
      });
    }
    promptRef.current = next.text;
    const activePendingQuestion = activePendingProgress?.activeQuestion;
    if (activePendingQuestion && activePendingUserInput) {
      onChangeActivePendingUserInputCustomAnswer(
        activePendingQuestion.id,
        next.text,
        nextCursor,
        nextExpandedCursor,
        isLiteralPendingAnswer,
      );
    } else {
      setPrompt(next.text);
      onTypingGuardDraftChange();
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      isLiteralPendingAnswer ? null : detectComposerTrigger(next.text, nextExpandedCursor),
    );
    if (options?.focusEditorAfterReplace !== false) {
      window.requestAnimationFrame(() => {
        if (promptRef.current !== next.text) return;
        composerEditorRef.current?.focusAt(nextCursor);
      });
    }
    return true;
  };
  const applyPromptReplacementStable = useStableCallback(applyPromptReplacement);

  const readComposerSnapshot = (): {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(
        promptRef.current,
        composerCursor,
        isLiteralPendingAnswer,
      ),
      contextIds: isLiteralPendingAnswer ? [] : collectInlineContextIds(promptRef.current),
    };
  };
  const readComposerSnapshotStable = useStableCallback(readComposerSnapshot);

  const resolveActiveComposerTrigger = (): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: isLiteralPendingAnswer
        ? null
        : resolveComposerTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor)),
    };
  };

  const onSelectComposerItem = (item: ComposerCommandItem) => {
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      if (!isPathSuggestionCurrent(item.searchTarget, trigger, environmentId, gitCwd)) return;
      const replacement = `${serializeComposerFileLink(item.path)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "model") {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          clearComposerMenuHighlight();
          setIsComposerModelPickerOpen(true);
        }
        return;
      }
      if (item.command === "clear") {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          clearComposerMenuHighlight();
          onFreshSession?.();
        }
        return;
      }
      if (item.command === "side" || item.command === "btw") {
        if (sideChatDisabledReason) return;
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `/${item.command} `,
          { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
        );
        if (applied) clearComposerMenuHighlight();
        return;
      }
      return;
    }
    if (item.type === "provider-slash-command") {
      if (item.command.name === USAGE_LIMITS_COMMAND.name && onUsageLimitsCommand) {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          clearComposerMenuHighlight();
          onUsageLimitsCommand();
        }
        return;
      }
      const replacement = `/${item.command.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "skill") {
      const replacement = `$${item.skill.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "pull-request") {
      if (
        trigger.kind !== "pull-request" ||
        !composerMenuItemsRef.current.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const comment = buildPullRequestReferenceContext(item.pullRequest);
      const replacement = `${formatInlineContextReference(
        reviewCommentContextReference(comment),
      )} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftReviewComment(composerDraftTarget, comment, {
          appendReference: false,
        });
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "thread") {
      if (trigger.kind !== "path") return;
      const shell = readThreadShell(item.thread);
      if (!shell) return;
      const record = threadContextRecord(item.thread, shell.title);
      const replacement = `${formatInlineContextReference(threadContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
          appendReference: false,
        });
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "model") {
      if (trigger.kind !== "path") return;
      const replacement = `${formatComposerModelMention(item.instanceId, item.model)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        clearComposerMenuHighlight();
      }
      return;
    }
    if (item.type === "environment") {
      if (trigger.kind !== "path") return;
      const record = environmentContextRecord(item.environmentId, item.label);
      const replacement = `${formatInlineContextReference(environmentContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftEnvironmentContexts(composerDraftTarget, [record], {
          appendReference: false,
        });
        clearComposerMenuHighlight();
      }
      return;
    }
  };
  const onSelectComposerItemStable = useStableCallback(onSelectComposerItem);
  const isPathQueryActiveStable = useStableCallback(
    () => resolveActiveComposerTrigger().trigger?.kind === "path",
  );

  return {
    setPrompt,
    onPromptChangeStable,
    applyPromptReplacement,
    applyPromptReplacementStable,
    readComposerSnapshot,
    readComposerSnapshotStable,
    resolveActiveComposerTrigger,
    onSelectComposerItem,
    onSelectComposerItemStable,
    isPathQueryActiveStable,
  };
}
