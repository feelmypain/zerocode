import { Animated } from "react-native";

export const SHIMMER_MIN_OPACITY = 0.45;
export const SHIMMER_MAX_OPACITY = 1;
export const SHIMMER_PULSE_HALF_MS = 900;

/**
 * Runs a native-driver opacity pulse with zero JS wakeups per frame.
 * Never uses Reanimated `withRepeat`, which starves React commits while
 * `DISABLE_COMMIT_PAUSING_MECHANISM` is enabled (docs/internals/16_performance-regressions.md).
 */
export function startWorkShimmerPulse(opacity: Animated.Value): () => void {
  opacity.setValue(SHIMMER_MAX_OPACITY);
  const animation = Animated.loop(
    Animated.sequence([
      Animated.timing(opacity, {
        toValue: SHIMMER_MIN_OPACITY,
        duration: SHIMMER_PULSE_HALF_MS,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: SHIMMER_MAX_OPACITY,
        duration: SHIMMER_PULSE_HALF_MS,
        useNativeDriver: true,
      }),
    ]),
  );
  animation.start();
  return () => {
    animation.stop();
    opacity.setValue(SHIMMER_MAX_OPACITY);
  };
}
