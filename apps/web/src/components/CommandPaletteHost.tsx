import { useGT } from "gt-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import { restoreWorkspaceFocusFromPalette } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import type {
  CommandPaletteOpenIntent,
  CommandPaletteReturnContext,
  SearchOverlayMode,
} from "./CommandPalette.logic";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

const LazyCommandPaletteDialogBody = lazy(() =>
  import("./CommandPalette").then((module) => ({
    default: module.CommandPaletteDialogBody,
  })),
);

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  // Defer importing the command palette body chunk until the first time the palette opens,
  // and keep it mounted afterward so closing transitions stay smooth.
  const [hasOpened, setHasOpened] = useState(state.open);
  if (state.open && !hasOpened) setHasOpened(true);
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <ThreadContextDragGhost />
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          // Held Escape emits repeat keydowns; only a fresh press should step back or close.
          if (!open && eventDetails.reason === "escape-key" && eventDetails.event.repeat) {
            eventDetails.cancel();
            return;
          }
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        {hasOpened ? (
          <CommandPaletteDialog
            mode={state.mode}
            session={state.session}
            openIntent={state.openIntent}
            setOpen={setOpen}
            openChildSearch={openChildSearch}
            initialContext={state.restoredSearch}
          />
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const gt = useGT();
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? gt("File picker")
          : props.mode === "content"
            ? gt("Search project contents")
            : gt("Command palette")
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        // Behind the Settings modal the composer is inert and cannot take focus.
        if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      <Suspense fallback={null}>
        <LazyCommandPaletteDialogBody
          mode={props.mode}
          session={props.session}
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openChildSearch={props.openChildSearch}
          initialContext={props.initialContext}
        />
      </Suspense>
    </CommandDialogPopup>
  );
}
