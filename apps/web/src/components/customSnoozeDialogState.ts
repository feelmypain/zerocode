import { create } from "zustand";

type SnoozeChoice = { readonly snoozedUntil: string };
type CustomSnoozeRequest = { readonly resolve: (choice: SnoozeChoice | null) => void };

export const useCustomSnoozeRequest = create<{ request: CustomSnoozeRequest | null }>(() => ({
  request: null,
}));

export function requestCustomSnooze(): Promise<SnoozeChoice | null> {
  useCustomSnoozeRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useCustomSnoozeRequest.setState({ request: { resolve } }));
}

export function finishCustomSnooze(choice: SnoozeChoice | null): void {
  const request = useCustomSnoozeRequest.getState().request;
  useCustomSnoozeRequest.setState({ request: null });
  request?.resolve(choice);
}
