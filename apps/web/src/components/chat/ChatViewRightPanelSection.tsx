import type { ScopedThreadRef } from "@zerocode/contracts";
import type { ComponentProps, ReactNode } from "react";
import { useRightPanelStore } from "../../rightPanelStore";
import { ChatRightPanel } from "./ChatRightPanel";
import { RightPanelMaximizeControl } from "./PanelLayoutControls";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

interface ChatViewRightPanelSectionProps {
  readonly activeThreadRef: ScopedThreadRef;
  readonly activeThreadKey: string | null;
  readonly rightPanelOpen: boolean;
  readonly rightPanelMaximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly panelToggleControls: ReactNode;
  readonly panelProps: Omit<
    ComponentProps<typeof ChatRightPanel>,
    "children" | "layoutControls" | "onRenameDevice" | "widthStorageKey" | "open" | "maximized"
  >;
  readonly surfaceContentProps: ComponentProps<typeof RightPanelSurfaceContent>;
}

export function ChatViewRightPanelSection(props: ChatViewRightPanelSectionProps) {
  const {
    activeThreadRef,
    activeThreadKey,
    rightPanelOpen,
    rightPanelMaximized,
    onToggleMaximized,
    panelToggleControls,
    panelProps,
    surfaceContentProps,
  } = props;

  return (
    <ChatRightPanel
      {...panelProps}
      widthStorageKey={`zerocode:preview-panel-width:${activeThreadKey}`}
      open={rightPanelOpen}
      maximized={rightPanelMaximized}
      layoutControls={
        rightPanelOpen ? (
          <div className="mr-px flex items-center gap-1">
            <RightPanelMaximizeControl
              maximized={rightPanelMaximized}
              onToggle={onToggleMaximized}
            />
            {panelToggleControls}
          </div>
        ) : null
      }
      onRenameDevice={(surfaceId, title) => {
        useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
      }}
    >
      <RightPanelSurfaceContent {...surfaceContentProps} />
    </ChatRightPanel>
  );
}
