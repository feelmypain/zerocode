import type { EnvironmentThreadShell } from "@zerocode/client-runtime/state/shell";
import type { deriveProviderSubagentStatus } from "@zerocode/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  ModelSelection,
  RuntimeMode,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@zerocode/contracts";
import type { ComponentProps, Ref, RefObject } from "react";
import type { DraftId, DraftThreadEnvMode } from "../../composerDraftStore";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { type ProviderInstanceEntry, shouldShowInstanceBadge } from "../../providerInstances";
import { BranchToolbar, type BranchToolbarHandle } from "../BranchToolbar";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { ComposerContextPermissions } from "../ComposerContextPermissions";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { ChildThreadApprovals } from "./ChildThreadApprovals";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerSurface } from "./ComposerSurface";
import { DraftHeroHeadline } from "./DraftHeroHeadline";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
} from "./draftHeroTransition";
import { NativeChildWorkDialog } from "./NativeChildWorkDialog";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import { draftSupportedRuntimeModes } from "./runtimeModeConfig";

interface ChatViewComposerOverlayProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly activeThread: EnvironmentThreadShell;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly isServerThread: boolean;
  readonly isDraftHeroState: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly isQueuedRunSaving: boolean;
  readonly forceExpandedMobileComposer: boolean;
  readonly showProviderSubagentBar: boolean;
  readonly composerMounted: boolean;
  readonly showComposerContextStrip: boolean;
  readonly terminalOpen: boolean;
  readonly overlayRef: Ref<HTMLDivElement>;
  readonly draftHeroTransitionGroupRef: RefObject<HTMLDivElement | null>;
  readonly draftHeroComposerAnchorRef: RefObject<HTMLDivElement | null>;
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providerSubagentModelLabel: string;
  readonly providerSubagentEffortLabel: string | null;
  readonly providerSubagentStatus: ReturnType<typeof deriveProviderSubagentStatus>;
  readonly onOpenParentThread: (() => void) | null;
  readonly composerProps: ChatComposerProps;
  readonly composerBannerItems: ReadonlyArray<ComposerBannerStackItem>;
  readonly branchToolbarRef: RefObject<BranchToolbarHandle | null>;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly workspaceModesOffered: boolean;
  readonly isGitRepo: boolean;
  readonly onEnvModeChange: (mode: DraftThreadEnvMode) => void;
  readonly startFromOrigin: boolean;
  readonly onStartFromOriginChange: (value: boolean) => void;
  readonly envMode: DraftThreadEnvMode;
  readonly canOverrideServerThreadEnvMode: boolean;
  readonly activeThreadBranch: string | null;
  readonly onActiveThreadBranchOverrideChange: (branch: string | null) => void;
  readonly envLocked: boolean;
  readonly onComposerFocusRequest: () => void;
  readonly canCheckoutPullRequestIntoThread: boolean;
  readonly onCheckoutPullRequestRequest: (reference: string) => void;
  readonly canChangeEnvironment: boolean;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly autoEnvironmentLabel: string | undefined;
  readonly onAutoEnvironment: (() => void) | undefined;
  readonly availableEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly runtimeMode: RuntimeMode;
  readonly activeProviderStatus: ServerProvider | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
}

export function ChatViewComposerOverlay(props: ChatViewComposerOverlayProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    draftId,
    activeThread,
    activeThreadRef,
    activeProjectRef,
    activeProjectTitle,
    isServerThread,
    isDraftHeroState,
    isRevertingCheckpoint,
    isQueuedRunSaving,
    forceExpandedMobileComposer,
    showProviderSubagentBar,
    composerMounted,
    showComposerContextStrip,
    terminalOpen,
    overlayRef,
    draftHeroTransitionGroupRef,
    draftHeroComposerAnchorRef,
    selectedProviderEntry,
    providerInstanceEntries,
    providerSubagentModelLabel,
    providerSubagentEffortLabel,
    providerSubagentStatus,
    onOpenParentThread,
    composerProps,
    composerBannerItems,
    branchToolbarRef,
    multipleModelSelections,
    workspaceModesOffered,
    isGitRepo,
    onEnvModeChange,
    startFromOrigin,
    onStartFromOriginChange,
    envMode,
    canOverrideServerThreadEnvMode,
    activeThreadBranch,
    onActiveThreadBranchOverrideChange,
    envLocked,
    onComposerFocusRequest,
    canCheckoutPullRequestIntoThread,
    onCheckoutPullRequestRequest,
    canChangeEnvironment,
    onEnvironmentChange,
    autoEnvironmentLabel,
    onAutoEnvironment,
    availableEnvironments,
    runtimeMode,
    activeProviderStatus,
    providerStatuses,
    onRuntimeModeChange,
  } = props;

  const branchToolbarProps: ComponentProps<typeof BranchToolbar> = {
    forceNewWorktree: multipleModelSelections !== null,
    ref: branchToolbarRef,
    environmentId: activeThread.environmentId,
    threadId: activeThread.id,
    projectId: activeThread.projectId,
    worktreePath: activeThread.worktreePath,
    isServerThread,
    showGitControls: workspaceModesOffered,
    showBranchControls: isGitRepo,
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    onEnvModeChange,
    startFromOrigin,
    onStartFromOriginChange,
    envMode,
    ...(canOverrideServerThreadEnvMode
      ? {
          activeThreadBranchOverride: activeThreadBranch,
          onActiveThreadBranchOverrideChange,
        }
      : {}),
    envLocked,
    onComposerFocusRequest,
    ...(canCheckoutPullRequestIntoThread ? { onCheckoutPullRequestRequest } : {}),
    ...(canChangeEnvironment ? { onEnvironmentChange } : {}),
    autoEnvironmentLabel,
    onAutoEnvironment,
    availableEnvironments,
    ...(isServerThread
      ? {}
      : {
          trailing: (
            <ComposerContextPermissions
              environmentId={environmentId}
              runtimeMode={runtimeMode}
              supportedRuntimeModes={draftSupportedRuntimeModes(
                activeProviderStatus?.supportedRuntimeModes,
                multipleModelSelections,
                providerStatuses,
              )}
              onRuntimeModeChange={onRuntimeModeChange}
            />
          ),
        }),
  };

  return (
    <div
      {...workspaceAreaProps("composer", 2, showProviderSubagentBar ? "Subagent" : undefined)}
      ref={overlayRef}
      inert={isRevertingCheckpoint}
      data-chat-composer-overlay="true"
      className={
        isDraftHeroState
          ? "pointer-events-none absolute inset-0 z-20 flex items-center [@media(max-height:34rem)]:items-end"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
      }
    >
      <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
        <div
          data-chat-composer-stack="true"
          className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
        >
          {isDraftHeroState ? (
            <div className="absolute inset-x-0 bottom-full">
              <div
                className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                style={
                  forceExpandedMobileComposer
                    ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                    : undefined
                }
              >
                <DraftHeroHeadline
                  draftId={draftId}
                  activeProjectRef={activeProjectRef}
                  activeProjectTitle={activeProjectTitle}
                />
              </div>
            </div>
          ) : null}
          <div
            ref={draftHeroComposerAnchorRef}
            className="relative z-10"
            style={
              forceExpandedMobileComposer
                ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                : undefined
            }
          >
            <ChildThreadApprovals threadRef={activeThreadRef} />
            <div className="relative">
              <ComposerSurface.Shell contextRow={showComposerContextStrip}>
                <ComposerSurface.Host inert={isQueuedRunSaving} aria-busy={isQueuedRunSaving}>
                  <div className="relative z-10">
                    {showProviderSubagentBar ? (
                      <ProviderSubagentBar
                        provider={selectedProviderEntry ?? null}
                        showInstanceBadge={
                          selectedProviderEntry !== undefined &&
                          shouldShowInstanceBadge(selectedProviderEntry, providerInstanceEntries)
                        }
                        modelLabel={providerSubagentModelLabel}
                        effortLabel={providerSubagentEffortLabel}
                        status={providerSubagentStatus}
                        onOpenParent={onOpenParentThread}
                        actions={
                          selectedProviderEntry?.driverKind === "antigravity" ? (
                            <NativeChildWorkDialog
                              environmentId={environmentId}
                              threadId={threadId}
                            />
                          ) : null
                        }
                      />
                    ) : null}
                    {composerMounted ? <ChatComposer {...composerProps} /> : null}
                  </div>
                </ComposerSurface.Host>
                <div className="min-h-0">
                  <div
                    data-terminal-open={terminalOpen ? "true" : undefined}
                    className="relative z-0"
                  >
                    {showComposerContextStrip && (
                      <div className="pointer-events-auto">
                        <BranchToolbar {...branchToolbarProps} />
                      </div>
                    )}
                  </div>
                </div>
              </ComposerSurface.Shell>
              {isDraftHeroState && composerBannerItems.length > 0 ? (
                // Out of flow, like the headline, so a notice never moves the centered composer.
                // Short windows pin the composer to the bottom, where an out-of-flow notice
                // would fall off-screen, so there it takes space and lifts the composer.
                <div className="absolute inset-x-0 top-full flex flex-col gap-1 pt-4 [@media(max-height:34rem)]:static">
                  <ComposerBannerStack items={composerBannerItems} detached />
                </div>
              ) : null}
            </div>
            <div
              aria-hidden
              className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
