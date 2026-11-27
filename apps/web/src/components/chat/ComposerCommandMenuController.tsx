import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@zerocode/contracts";
import { useGT } from "gt-react";
import { useImperativeHandle, useLayoutEffect, useState, type RefObject } from "react";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";
import { DeferredComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import type { ModelEsque } from "./providerIconUtils";
import { useComposerMenuItems } from "./useComposerMenuItems";

export interface ComposerCommandMenuControllerHandle {
  readonly nudgeHighlight: (key: "ArrowDown" | "ArrowUp") => void;
  readonly clearHighlight: () => void;
}

interface ComposerCommandMenuControllerProps {
  readonly controllerRef: RefObject<ComposerCommandMenuControllerHandle | null>;
  readonly composerTrigger: ComposerTrigger;
  readonly suggestionListId: string;
  readonly anchor: HTMLDivElement | null;
  readonly resolvedTheme: "light" | "dark";
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly freshSessionAvailable: boolean;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly workspaceSkillsScanning: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly modelMentions: {
    readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
    readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  };
  readonly menuItemsRef: RefObject<ComposerCommandItem[]>;
  readonly activeMenuItemRef: RefObject<ComposerCommandItem | null>;
  readonly onSelect: (item: ComposerCommandItem) => void;
  readonly onActiveSuggestionIdChange: (activeSuggestionId: string | undefined) => void;
}

/**
 * Mounted only while a composer trigger (@, /, $, #) is active, so normal typing pays for none
 * of the trigger search hooks, store subscriptions, or menu highlight state.
 */
export function ComposerCommandMenuController({
  controllerRef,
  composerTrigger,
  suggestionListId,
  anchor,
  resolvedTheme,
  environmentId,
  linkedEnvironments,
  gitCwd,
  activeThreadId,
  pullRequestProjectId,
  pullRequestRepository,
  threadPullRequests,
  sideChatAvailable,
  sideChatDisabledReason,
  freshSessionAvailable,
  compactSlashCommandAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  workspaceSkillsScanning,
  questionAttachmentTarget,
  modelMentions,
  menuItemsRef,
  activeMenuItemRef,
  onSelect,
  onActiveSuggestionIdChange,
}: ComposerCommandMenuControllerProps) {
  const gt = useGT();
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);

  const {
    items: menuItems,
    isLoading: isMenuLoading,
    emptyState: menuEmptyState,
  } = useComposerMenuItems({
    composerTrigger,
    environmentId,
    linkedEnvironments,
    gitCwd,
    activeThreadId,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    sideChatAvailable,
    sideChatDisabledReason,
    freshSessionAvailable,
    compactSlashCommandAvailable,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    showSkillsInSlashMenu,
    workspaceSkillsScanning,
    questionAttachmentTarget,
    modelMentions,
  });

  const searchKey = `${suggestionListId}:${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`;
  const activeItemId = resolveComposerMenuActiveItemId({
    items: menuItems,
    highlightedItemId,
    currentSearchKey: searchKey,
    highlightedSearchKey,
  });
  const activeItem = menuItems.find((item) => item.id === activeItemId) ?? null;

  if (highlightedItemId !== activeItemId) {
    setHighlightedItemId(activeItemId);
  }
  if (highlightedSearchKey !== searchKey) {
    setHighlightedSearchKey(searchKey);
  }

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- publishes committed composer menu state to refs read by editor key handlers
  useLayoutEffect(() => {
    menuItemsRef.current = menuItems;
    activeMenuItemRef.current = activeItem;
  });

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- clears menu refs when the trigger closes and this controller unmounts
  useLayoutEffect(() => {
    return () => {
      menuItemsRef.current = [];
      activeMenuItemRef.current = null;
    };
  }, [menuItemsRef, activeMenuItemRef]);

  const activeSuggestionId =
    menuItems.length > 0 && activeItem
      ? composerSuggestionOptionId(suggestionListId, activeItem.id)
      : undefined;

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- mirrors the active option id to the editor's aria-activedescendant attribute while the menu is open
  useLayoutEffect(() => {
    onActiveSuggestionIdChange(activeSuggestionId);
  }, [activeSuggestionId, onActiveSuggestionIdChange]);

  const onItemHighlightedStable = useStableCallback((itemId: string | null) => {
    setHighlightedItemId(itemId);
    setHighlightedSearchKey(searchKey);
  });

  const nudgeHighlightStable = useStableCallback((key: "ArrowDown" | "ArrowUp") => {
    if (menuItems.length === 0) return;
    const highlightedIndex = menuItems.findIndex((item) => item.id === activeItemId);
    const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
    const offset = key === "ArrowDown" ? 1 : -1;
    const nextIndex = (normalizedIndex + offset + menuItems.length) % menuItems.length;
    const nextItem = menuItems[nextIndex];
    setHighlightedItemId(nextItem?.id ?? null);
    setHighlightedSearchKey(searchKey);
  });

  const clearHighlightStable = useStableCallback(() => {
    setHighlightedItemId(null);
    setHighlightedSearchKey(null);
  });

  useImperativeHandle(
    controllerRef,
    () => ({
      nudgeHighlight: nudgeHighlightStable,
      clearHighlight: clearHighlightStable,
    }),
    [clearHighlightStable, nudgeHighlightStable],
  );

  const triggerKind = composerTrigger.kind;

  return (
    <>
      <div role="status" aria-atomic="true" className="sr-only">
        {menuItems.length === 0
          ? isMenuLoading
            ? triggerKind === "pull-request"
              ? gt("Finding pull request...")
              : triggerKind === "skill" || triggerKind === "slash-command"
                ? gt("Searching workspace skills...")
                : gt("Searching workspace files...")
            : menuEmptyState
          : ""}
      </div>
      <DeferredComposerCommandMenuLayer open anchor={anchor}>
        <ComposerCommandMenu
          listId={suggestionListId}
          items={menuItems}
          resolvedTheme={resolvedTheme}
          isLoading={isMenuLoading}
          triggerKind={triggerKind}
          emptyStateText={menuEmptyState}
          activeItemId={activeItem?.id ?? null}
          onHighlightedItemChange={onItemHighlightedStable}
          onSelect={onSelect}
        />
      </DeferredComposerCommandMenuLayer>
    </>
  );
}
