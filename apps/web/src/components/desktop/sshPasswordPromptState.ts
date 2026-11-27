import type { DesktopSshPasswordPromptRequest } from "@zerocode/contracts";

let promptQueue: readonly DesktopSshPasswordPromptRequest[] = [];
const promptQueueListeners = new Set<() => void>();

function setPromptQueue(next: readonly DesktopSshPasswordPromptRequest[]) {
  promptQueue = next;
  for (const listener of promptQueueListeners) listener();
}

export function removeSshPasswordPrompt(requestId: string): void {
  if (!promptQueue.some((request) => request.requestId === requestId)) return;
  setPromptQueue(promptQueue.filter((request) => request.requestId !== requestId));
}

/**
 * Queues the desktop's SSH password prompts for the life of the page, so a prompt
 * that arrives while no dialog is mounted still waits for one.
 */
export function startSshPasswordPromptQueue(): () => void {
  const bridge = window.desktopBridge;
  if (!bridge) return () => undefined;
  const stopPrompts = bridge.onSshPasswordPrompt((request) => {
    if (promptQueue.some((queued) => queued.requestId === request.requestId)) return;
    setPromptQueue([...promptQueue, request]);
  });
  const stopSettled = bridge.onSshPasswordPromptSettled(removeSshPasswordPrompt);
  return () => {
    stopPrompts();
    stopSettled();
  };
}

export function subscribeSshPasswordPromptQueue(listener: () => void): () => void {
  promptQueueListeners.add(listener);
  return () => {
    promptQueueListeners.delete(listener);
  };
}

export function readSshPasswordPromptQueue(): readonly DesktopSshPasswordPromptRequest[] {
  return promptQueue;
}
