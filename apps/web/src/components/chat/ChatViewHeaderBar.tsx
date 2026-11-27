import type { ComponentProps, ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { isElectron } from "../../env";
import { ChatHeader } from "./ChatHeader";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  ThreadPanelHeaderControl,
  WorkspaceTitlebarControls,
} from "./PanelLayoutControls";

export function ChatViewPanelLayoutControls(props: {
  readonly panelToggleControlProps: PanelLayoutControlsProps;
  readonly inlineRightPanelOwnsTitleBar: boolean;
  readonly shouldUsePlanSidebarSheet: boolean;
  readonly rightPanelOpen: boolean;
  readonly panelAnimationsActive: boolean;
  readonly rightPanelMaximized: boolean;
  readonly onToggleMaximized: () => void;
}) {
  const {
    panelToggleControlProps,
    inlineRightPanelOwnsTitleBar,
    shouldUsePlanSidebarSheet,
    rightPanelOpen,
    panelAnimationsActive,
    rightPanelMaximized,
    onToggleMaximized,
  } = props;
  return (
    <WorkspaceTitlebarControls
      showMaximizeControl={!shouldUsePlanSidebarSheet}
      rightPanelOpen={rightPanelOpen}
      animationsActive={panelAnimationsActive}
      maximized={rightPanelMaximized}
      onToggleMaximized={onToggleMaximized}
    >
      <PanelLayoutControls
        {...panelToggleControlProps}
        showThreadPanelControl={!inlineRightPanelOwnsTitleBar}
      />
    </WorkspaceTitlebarControls>
  );
}

export function ChatViewHeaderBar(props: {
  readonly headerRef: Ref<HTMLElement>;
  readonly reserveTitleBarControlInset: boolean;
  readonly inlineRightPanelOwnsTitleBar: boolean;
  readonly rightPanelControlsAtRoot: boolean;
  readonly rightPanelControlsInPanel: boolean;
  readonly panelLayoutControls: ReactNode;
  readonly panelToggleControlProps: PanelLayoutControlsProps;
  readonly chatHeaderProps: ComponentProps<typeof ChatHeader>;
}) {
  const {
    headerRef,
    reserveTitleBarControlInset,
    inlineRightPanelOwnsTitleBar,
    rightPanelControlsAtRoot,
    rightPanelControlsInPanel,
    panelLayoutControls,
    panelToggleControlProps,
    chatHeaderProps,
  } = props;

  return (
    <header
      ref={headerRef}
      data-chat-header
      className={cn(
        "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        isElectron
          ? cn(
              "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
              reserveTitleBarControlInset &&
                !inlineRightPanelOwnsTitleBar &&
                "wco:pr-(--workspace-native-controls-inset)",
            )
          : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {isElectron && rightPanelControlsAtRoot ? (
        <span
          aria-hidden
          className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
        />
      ) : null}
      {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
      {inlineRightPanelOwnsTitleBar ? (
        <ThreadPanelHeaderControl {...panelToggleControlProps} />
      ) : null}
      <ChatHeader {...chatHeaderProps} />
    </header>
  );
}
