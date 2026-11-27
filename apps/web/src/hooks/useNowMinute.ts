import { minuteTick } from "@zerocode/client-runtime/clock";
import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

export function useNowMinute(enabled = true): string {
  return useSyncExternalStore(
    enabled ? minuteTick.subscribe : noopSubscribe,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
}
