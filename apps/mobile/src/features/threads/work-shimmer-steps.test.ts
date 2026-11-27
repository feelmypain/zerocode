import { expect, it, vi } from "vite-plus/test";

const animatedMocks = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const timing = vi.fn((value: unknown, config: unknown) => ({ kind: "timing", value, config }));
  const sequence = vi.fn((animations: unknown[]) => ({ kind: "sequence", animations }));
  const loop = vi.fn((animation: unknown) => ({ kind: "loop", animation, start, stop }));
  return { start, stop, timing, sequence, loop };
});

vi.mock("react-native", () => ({
  Animated: {
    timing: animatedMocks.timing,
    sequence: animatedMocks.sequence,
    loop: animatedMocks.loop,
  },
}));

import {
  SHIMMER_MAX_OPACITY,
  SHIMMER_MIN_OPACITY,
  SHIMMER_PULSE_HALF_MS,
  startWorkShimmerPulse,
} from "./work-shimmer-steps";

it("runs a native-driver opacity loop with zero JS timers and resets on cleanup", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  const setValue = vi.fn();
  const opacity = { setValue } as unknown as import("react-native").Animated.Value;

  const stop = startWorkShimmerPulse(opacity);

  expect(setValue).toHaveBeenCalledWith(SHIMMER_MAX_OPACITY);
  expect(animatedMocks.timing).toHaveBeenNthCalledWith(1, opacity, {
    toValue: SHIMMER_MIN_OPACITY,
    duration: SHIMMER_PULSE_HALF_MS,
    useNativeDriver: true,
  });
  expect(animatedMocks.timing).toHaveBeenNthCalledWith(2, opacity, {
    toValue: SHIMMER_MAX_OPACITY,
    duration: SHIMMER_PULSE_HALF_MS,
    useNativeDriver: true,
  });
  expect(animatedMocks.sequence).toHaveBeenCalledTimes(1);
  expect(animatedMocks.loop).toHaveBeenCalledTimes(1);
  expect(animatedMocks.start).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  stop();
  expect(animatedMocks.stop).toHaveBeenCalledTimes(1);
  expect(setValue).toHaveBeenLastCalledWith(SHIMMER_MAX_OPACITY);
});
