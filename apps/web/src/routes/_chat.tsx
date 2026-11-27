import { scopeThreadRef, scopedThreadKey } from "@zerocode/client-runtime/environment";
import type { ScopedThreadRef } from "@zerocode/contracts";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { GlobalVoiceInputIndicator } from "../components/chat/GlobalVoiceInputIndicator";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { deleteSessionEphemeralThreadOnLeave } from "../lib/ephemeralThreads";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";

interface ActiveChatRouteEntry {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly draftId: DraftId | null;
}

let activeChatRouteLayoutMounts = 0;
let activeChatRouteEntryKey: string | null = null;

function handleLeaveChatRouteEntry(entry: ActiveChatRouteEntry): void {
  deleteSessionEphemeralThreadOnLeave(entry.threadRef);
  if (entry.draftId !== null) {
    const draftSession = useComposerDraftStore.getState().getDraftSession(entry.draftId);
    if (draftSession?.ephemeral === true && draftSession.promotedTo == null) {
      discardComposerDraft(entry.draftId, { silent: true });
    }
  }
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  const shownDraftId = shownTarget?.kind === "draft" ? shownTarget.draftId : null;
  const shownDraftSession = useComposerDraftStore((store) =>
    shownDraftId === null ? null : store.getDraftSession(shownDraftId),
  );
  const shownDraftRedirect = useComposerDraftStore((store) =>
    shownDraftId === null ? null : store.getPromotedDraftRedirect(shownDraftId),
  );
  const activeThreadRef =
    shownTarget?.kind === "server"
      ? shownTarget.threadRef
      : shownDraftId !== null
        ? shownDraftSession
          ? (shownDraftSession.promotedTo ??
            scopeThreadRef(shownDraftSession.environmentId, shownDraftSession.threadId))
          : shownDraftRedirect
        : null;
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const activeThreadId = activeThreadRef?.threadId ?? null;
  const activeThreadKey =
    activeEnvironmentId !== null && activeThreadId !== null
      ? scopedThreadKey({ environmentId: activeEnvironmentId, threadId: activeThreadId })
      : null;
  const previousActiveEntryRef = useRef<ActiveChatRouteEntry | null>(null);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- deletes an active ephemeral chat when leaving the chat layout completely
  useEffect(() => {
    activeChatRouteLayoutMounts += 1;
    return () => {
      activeChatRouteLayoutMounts -= 1;
      const leaving = previousActiveEntryRef.current;
      if (leaving === null) return;
      // Defer past React StrictMode's synchronous dev remount before deleting on unmount.
      queueMicrotask(() => {
        if (activeChatRouteLayoutMounts === 0 || activeChatRouteEntryKey !== leaving.key) {
          if (activeChatRouteLayoutMounts === 0) {
            activeChatRouteEntryKey = null;
          }
          previousActiveEntryRef.current = null;
          handleLeaveChatRouteEntry(leaving);
        }
      });
    };
  }, []);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- deletes ephemeral chats and discards unsent ephemeral drafts when navigating away from them
  useEffect(() => {
    const nextEntry: ActiveChatRouteEntry | null =
      activeEnvironmentId !== null && activeThreadId !== null && activeThreadKey !== null
        ? {
            key: activeThreadKey,
            threadRef: scopeThreadRef(activeEnvironmentId, activeThreadId),
            draftId: shownDraftId,
          }
        : null;
    const prev = previousActiveEntryRef.current;
    if (prev !== null && prev.key !== nextEntry?.key) {
      handleLeaveChatRouteEntry(prev);
    }
    previousActiveEntryRef.current = nextEntry;
    activeChatRouteEntryKey = nextEntry?.key ?? null;
  }, [activeEnvironmentId, activeThreadId, activeThreadKey, shownDraftId]);

  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
      <GlobalVoiceInputIndicator hidden={modalOpen} />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
