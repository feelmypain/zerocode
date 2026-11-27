import { msg, useMessages } from "gt-react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  runOnJS,
  runOnUI,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import type { MessageResolver } from "../../i18n/messages";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { registerThreadDismissal } from "./thread-dismissal";

const ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;
// At the default app text size, "Unarchive", the longest label, fills its slot at about 1.12x.
const ACTION_LABEL_MAX_FONT_SCALE = 1.1;
const ACTION_LABEL_MIN_HEIGHT = 14;
const ACTION_LABEL_OFFSET = 2;

const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly destructive?: boolean;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly tone: "primary" | "secondary" | "danger";
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

function resolveSecondaryAction(input: {
  readonly close: () => void;
  readonly onDelete: () => void;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly threadTitle: string;
  readonly resolve: MessageResolver;
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null;
  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: input.resolve(msg("Delete {title}", { title: input.threadTitle })),
      tone: "danger",
      icon: "trash",
      label: input.resolve(msg("Delete", { $context: "verb, swipe action that deletes a thread" })),
      onPress: () => {
        input.close();
        input.onDelete();
      },
    };
  }
  const action = input.secondaryAction;
  return {
    ...action,
    tone: "secondary",
    menu:
      action.menu === undefined
        ? undefined
        : {
            ...action.menu,
            onPressAction: (event) => {
              input.close();
              action.menu?.onPressAction(event);
            },
          },
    onPress: () => {
      input.close();
      action.onPress();
    },
  };
}

// Swipeable rebuilds its native pan gesture whenever its config changes identity, so the props
// that feed it stay stable across row re-renders such as selection.
// Require more horizontal travel than failOffsetY so diagonal/vertical scrolls fail the swipe natively.
const DRAG_OFFSET_FROM_LEFT = 12;
const DRAG_OFFSET_FROM_RIGHT = -12;
const FAIL_OFFSET_Y: [number, number] = [-10, 10];

interface ThreadSwipeableProps {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /** Omitted uses Delete only with the built-in Delete secondary action; otherwise it uses primary. */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  /** The list animates item layout; collapse in one step so its transition moves siblings once. */
  readonly listAnimatesLayout?: boolean;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly threadKey: string;
  /** Omitted defaults to Delete; null removes it so gated Snooze cannot fall back to Delete. */
  readonly secondaryAction?: ThreadSwipeAction | null;
  readonly resetKey?: string;
  readonly dormant?: boolean;
  readonly simultaneousWith?: ComponentProps<typeof ReanimatedSwipeable>["simultaneousWith"];
  readonly threadTitle: string;
}

const COLLAPSED_ROW_STYLE = { height: 0, overflow: "hidden" } as const;

function createSwipeableHandle() {
  let methods: SwipeableMethods | null = null;
  let activeTranslation: SharedValue<number> | null = null;
  return {
    attach: (instance: SwipeableMethods | null) => {
      methods = instance;
    },
    get: () => methods,
    close: () => {
      methods?.close();
    },
    setActiveTranslation: (translation: SharedValue<number> | null) => {
      activeTranslation = translation;
    },
    getActiveTranslation: () => activeTranslation,
  };
}

const ThreadSwipeRightActions = memo(function ThreadSwipeRightActions(props: {
  readonly actionStyle: ReturnType<typeof useAnimatedStyle>;
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly methods: SwipeableMethods;
  readonly onDelete: () => void;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly onPrimaryPress: () => void;
  readonly onTranslation: (translation: SharedValue<number>) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly resolve: MessageResolver;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly threadTitle: string;
  readonly translation: SharedValue<number>;
}) {
  const { onTranslation, translation } = props;
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- tracks the live RNGH translation shared value for row dismissal animations
  useLayoutEffect(() => {
    onTranslation(translation);
  }, [onTranslation, translation]);

  return (
    <Animated.View style={props.actionStyle}>
      <ThreadSwipeActions
        backgroundColor={props.backgroundColor}
        compact={props.compact}
        fullSwipeAction={props.fullSwipeAction}
        fullSwipeThreshold={props.fullSwipeThreshold}
        onFullSwipeArmedChange={props.onFullSwipeArmedChange}
        primaryAction={{ ...props.primaryAction, onPress: props.onPrimaryPress }}
        secondaryAction={resolveSecondaryAction({
          close: () => props.methods.close(),
          onDelete: props.onDelete,
          secondaryAction: props.secondaryAction,
          threadTitle: props.threadTitle,
          resolve: props.resolve,
        })}
        translation={translation}
      />
    </Animated.View>
  );
});

export function ThreadSwipeable(props: ThreadSwipeableProps) {
  const m = useMessages();
  const [swipeable] = useState(createSwipeableHandle);
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");
  const mountedRef = useRef(true);
  const dismissalRef = useRef<{ finished: Promise<void>; restore: () => void } | null>(null);
  const pendingDismissRef = useRef<{ id: number; resolve: () => void } | null>(null);
  const dismissalIdRef = useRef(0);
  const content = useMemo(
    () => ({ resetKey: props.resetKey, threadKey: props.threadKey }),
    [props.resetKey, props.threadKey],
  );
  const contentRef = useRef(content);
  const [isDismissing, setIsDismissing] = useState(false);
  const [collapsedInList, setCollapsedInList] = useState(false);
  const dismissing = useSharedValue(false);
  const rowHeight = useSharedValue(0);
  const rowWidth = useSharedValue(props.fullSwipeWidth);
  const collapse = useSharedValue(0);
  const fallbackTranslation = useSharedValue(0);
  const actionOpacity = useSharedValue(1);
  const primaryAction = props.primaryAction;
  const onDelete = props.onDelete;
  const onSwipeableClose = props.onSwipeableClose;
  const listAnimatesLayout = props.listAnimatesLayout === true;

  const restoreRow = useCallback(() => {
    if (!mountedRef.current) return;
    dismissalRef.current = null;
    // RN-to-UI jobs run in order, so this also resets a queued dismissal.
    runOnUI((methods: SwipeableMethods | null) => {
      "worklet";
      methods?.reset();
      // RNGH reset() leaves tap-to-close enabled; close() clears it.
      methods?.close();
      fallbackTranslation.set(0);
      collapse.set(0);
      actionOpacity.set(1);
      dismissing.set(false);
    })(swipeable.get());
    setIsDismissing(false);
    setCollapsedInList(false);
  }, [actionOpacity, collapse, dismissing, fallbackTranslation, swipeable]);

  const finishDismiss = useCallback((id?: number) => {
    const pending = pendingDismissRef.current;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    pendingDismissRef.current = null;
    pending.resolve();
  }, []);
  const collapseInList = useCallback(
    (id: number) => {
      if (!mountedRef.current || pendingDismissRef.current?.id !== id) return;
      setCollapsedInList(true);
      finishDismiss(id);
    },
    [finishDismiss],
  );

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- cancels the row's Reanimated animations and settles a pending dismissal on unmount
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimation(collapse);
      cancelAnimation(actionOpacity);
      cancelAnimation(fallbackTranslation);
      const activeTranslation = swipeable.getActiveTranslation();
      if (activeTranslation) cancelAnimation(activeTranslation);
      finishDismiss();
    };
  }, [actionOpacity, collapse, fallbackTranslation, finishDismiss, swipeable]);

  // Reset recycled rows in place so their child views stay mounted.
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- resets the swipeable and its shared values when the list recycles this row for new content
  useLayoutEffect(() => {
    if (contentRef.current === content) return;
    contentRef.current = content;
    finishDismiss();
    restoreRow();
  }, [content, finishDismiss, restoreRow]);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- closes the open swipeable and resets its shared values when the row goes dormant
  useLayoutEffect(() => {
    if (props.dormant && swipeable.getActiveTranslation() && dismissalRef.current === null) {
      restoreRow();
    }
  }, [props.dormant, restoreRow, swipeable]);

  const dismiss = useCallback(
    (translation: SharedValue<number>, id: number) => {
      "worklet";
      if (dismissing.value) return;
      dismissing.set(true);
      const timing = {
        duration: 220,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      };
      actionOpacity.set(withTiming(0, timing));
      translation.set(
        withTiming(Math.min(translation.value, -rowWidth.value), timing, (finished) => {
          if (!finished) return;
          // LegendList re-measures rows only on React commits, so a UI-thread height animation
          // reaches it in late jumps. Collapse through React and let its transition move rows.
          if (listAnimatesLayout) {
            runOnJS(collapseInList)(id);
            return;
          }
          collapse.set(
            withTiming(1, { ...timing, duration: 180 }, (collapsed) => {
              if (collapsed) runOnJS(finishDismiss)(id);
            }),
          );
        }),
      );
    },
    [
      actionOpacity,
      collapse,
      collapseInList,
      dismissing,
      finishDismiss,
      listAnimatesLayout,
      rowWidth,
    ],
  );
  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- registers this row's animated dismissal in the module-level thread dismissal registry
  useLayoutEffect(
    () =>
      props.dormant
        ? undefined
        : registerThreadDismissal(props.threadKey, () => {
            if (dismissalRef.current) return dismissalRef.current;
            const id = ++dismissalIdRef.current;
            const finished = new Promise<void>((resolve) => {
              pendingDismissRef.current = { id, resolve };
            });
            setIsDismissing(true);
            const methods = swipeable.get();
            if (methods) onSwipeableClose?.(methods);
            runOnUI(dismiss)(swipeable.getActiveTranslation() ?? fallbackTranslation, id);
            const dismissal = {
              finished,
              restore: () => {
                if (dismissalRef.current === dismissal) restoreRow();
              },
            };
            dismissalRef.current = dismissal;
            return dismissal;
          }),
    [
      dismiss,
      fallbackTranslation,
      onSwipeableClose,
      props.dormant,
      props.threadKey,
      restoreRow,
      swipeable,
    ],
  );
  const dismissStyle = useAnimatedStyle(() => ({
    // Native prop updates omit undefined, leaving a collapsed height in place.
    height: dismissing.value ? rowHeight.value * (1 - collapse.value) : "auto",
    pointerEvents: dismissing.value ? "none" : "auto",
    overflow: "hidden",
    transform: [{ translateX: fallbackTranslation.value }],
  }));
  const actionStyle = useAnimatedStyle(() => ({ opacity: actionOpacity.value, height: "100%" }));
  const commitPrimaryAction = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content) return;
    primaryAction.onPress();
    if (!pendingDismissRef.current) swipeable.close();
  }, [content, primaryAction, swipeable]);
  // RNGH lifecycle events call the latest handler, so commit from this release.
  const commitFullSwipe = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content) return;
    if (fullSwipeAction === "primary") commitPrimaryAction();
    else {
      swipeable.close();
      onDelete();
    }
  }, [commitPrimaryAction, content, fullSwipeAction, onDelete, swipeable]);
  const handleRelease = useCallback(
    (translation: SharedValue<number>, canceled: boolean) => {
      "worklet";
      if (dismissing.value) return true;
      if (!canceled && -translation.value >= fullSwipeThreshold) {
        runOnJS(commitFullSwipe)();
        return true;
      }
      return false;
    },
    [commitFullSwipe, dismissing, fullSwipeThreshold],
  );
  const handleFullSwipeArmedChange = useCallback(
    (armed: boolean) => {
      if (mountedRef.current && contentRef.current === content && armed) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    },
    [content],
  );
  const { dormant, onSwipeableWillOpen, backgroundColor, containerStyle } = props;
  const handleWillOpen = useCallback(() => {
    const methods = swipeable.get();
    if (!dormant && !dismissalRef.current && methods) {
      onSwipeableWillOpen?.(methods);
    }
  }, [dormant, onSwipeableWillOpen, swipeable]);
  const handleSwipeableClose = useCallback(() => {
    const methods = swipeable.get();
    if (methods) onSwipeableClose?.(methods);
  }, [onSwipeableClose, swipeable]);
  const compactActions = props.compactActions === true;
  const { secondaryAction, threadTitle } = props;
  const renderRightActions = (
    _progress: SharedValue<number>,
    translation: SharedValue<number>,
    methods: SwipeableMethods,
  ) =>
    dormant ? null : (
      <ThreadSwipeRightActions
        actionStyle={actionStyle}
        backgroundColor={backgroundColor}
        compact={compactActions}
        fullSwipeAction={fullSwipeAction}
        fullSwipeThreshold={fullSwipeThreshold}
        methods={methods}
        onDelete={onDelete}
        onFullSwipeArmedChange={handleFullSwipeArmedChange}
        onPrimaryPress={commitPrimaryAction}
        onTranslation={swipeable.setActiveTranslation}
        primaryAction={primaryAction}
        resolve={m}
        secondaryAction={secondaryAction}
        threadTitle={threadTitle}
        translation={translation}
      />
    );
  const childrenContainerStyle = useMemo(() => ({ backgroundColor }), [backgroundColor]);
  const swipeableContainerStyle = useMemo(
    () => [{ backgroundColor }, containerStyle],
    [backgroundColor, containerStyle],
  );

  const attachSwipeable = useCallback(
    (instance: SwipeableMethods | null) => {
      swipeable.attach(instance);
    },
    [swipeable],
  );
  const closeSwipeable = useCallback(() => {
    swipeable.close();
  }, [swipeable]);

  return (
    <View style={collapsedInList ? COLLAPSED_ROW_STYLE : undefined}>
      <Animated.View style={dismissStyle}>
        <View
          onLayout={({ nativeEvent: { layout } }) => {
            rowHeight.set(layout.height);
            rowWidth.set(layout.width);
          }}
        >
          <ReanimatedSwipeable
            ref={attachSwipeable}
            animationOptions={THREAD_SWIPE_SPRING}
            childrenContainerStyle={childrenContainerStyle}
            containerStyle={swipeableContainerStyle}
            dragOffsetFromLeft={DRAG_OFFSET_FROM_LEFT}
            dragOffsetFromRight={DRAG_OFFSET_FROM_RIGHT}
            enabled={!props.dormant && !isDismissing && props.enabled !== false}
            enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
            // Reject vertical pans via patched RNGH failOffsetY; simultaneous trackpad scrolls otherwise open rows on horizontal drift.
            failOffsetY={FAIL_OFFSET_Y}
            friction={1}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableRelease={handleRelease}
            onSwipeableOpenStartDrag={handleWillOpen}
            onSwipeableWillOpen={handleWillOpen}
            overshootFriction={1}
            overshootRight
            renderRightActions={renderRightActions}
            rightThreshold={actionsWidth * 0.42}
            // Only iPad trackpad pans need rows to swipe simultaneously with the list scroll gesture.
            simultaneousWith={Platform.OS === "ios" ? props.simultaneousWith : undefined}
          >
            {props.children(closeSwipeable)}
          </ReanimatedSwipeable>
        </View>
      </Animated.View>
    </View>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly tone: "primary" | "secondary" | "danger";
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: ThreadSwipeAction["menu"];
  readonly onPress: () => void;
  /** A trailing action slides left under the stretching action's pill on a full swipe. */
  readonly slidesUnderStretch: boolean;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const {
    actionsWidth,
    entryRange: [entryRangeStart, entryRangeEnd],
    fullSwipeThreshold,
    slidesUnderStretch,
    stretchesOnFullSwipe,
    translation,
  } = props;
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE;
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE;
  const { fontScale } = useWindowDimensions();
  const microLineHeight = useScaledTextRole("micro").lineHeight;
  // Compact rows are 44pt tall; cap label leading so large app text sizes still fit under the circle.
  const labelLineHeight = props.compact
    ? Math.min(microLineHeight, ACTION_LABEL_MIN_HEIGHT)
    : microLineHeight;
  // Android scales lineHeight by the full font scale, past maxFontSizeMultiplier.
  const labelTextStyle = {
    lineHeight:
      Platform.OS === "android" && fontScale > ACTION_LABEL_MAX_FONT_SCALE
        ? (labelLineHeight * ACTION_LABEL_MAX_FONT_SCALE) / fontScale
        : labelLineHeight,
  };
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const entryProgress = interpolate(
      reveal,
      [entryRangeStart, entryRangeEnd],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const stretch = Math.max(reveal - actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [actionsWidth, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) - (stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [fullSwipeThreshold, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = Math.max(reveal - actionsWidth, 0);
    if (!stretchesOnFullSwipe) {
      // The pill covers this action's circle but not its label, so hide the label before its
      // circle reaches the pill; otherwise it runs into the stretching action's label.
      return {
        opacity: slidesUnderStretch
          ? interpolate(stretch, [0, ACTION_ITEM_WIDTH - circleSize], [1, 0], Extrapolation.CLAMP)
          : 1,
      };
    }

    return {
      opacity: interpolate(
        reveal,
        [fullSwipeThreshold - 24, fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: "center",
        height: "100%",
        justifyContent: "center",
        opacity: pressed ? 0.72 : 1,
        width: "100%",
      })}
    >
      <View style={{ height: circleSize, width: circleSize }}>
        <Animated.View
          className={
            props.tone === "danger"
              ? "bg-danger"
              : props.tone === "secondary"
                ? "bg-secondary"
                : "bg-primary"
          }
          style={[
            {
              borderRadius: 999,
              height: circleSize,
              left: 0,
              position: "absolute",
              top: 0,
            },
            circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: "center",
              height: circleSize,
              justifyContent: "center",
              left: 0,
              position: "absolute",
              top: 0,
              width: circleSize,
            },
            iconStyle,
          ]}
        >
          <SymbolView
            name={props.icon}
            size={iconSize}
            tintColorClassName={
              props.tone === "danger"
                ? "accent-danger-foreground"
                : props.tone === "secondary"
                  ? "accent-secondary-foreground"
                  : "accent-primary-foreground"
            }
            type="monochrome"
          />
        </Animated.View>
      </View>
      {/* An offset, not padding: padding would grow the box and move the circle at 1x. */}
      <Animated.View
        style={[
          {
            justifyContent: "center",
            minHeight: ACTION_LABEL_MIN_HEIGHT,
            top: props.compact ? 0 : ACTION_LABEL_OFFSET,
          },
          labelStyle,
        ]}
      >
        <Text
          className="text-3xs font-zerocode-medium text-foreground-muted"
          maxFontSizeMultiplier={ACTION_LABEL_MAX_FONT_SCALE}
          numberOfLines={1}
          style={labelTextStyle}
        >
          {props.label}
        </Text>
      </Animated.View>
    </Pressable>
  );

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu === undefined ? (
        button
      ) : (
        <Menu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </Menu>
      )}
    </Animated.View>
  );
}

function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly secondaryAction: ThreadSwipeSecondaryAction | null;
  readonly translation: SharedValue<number>;
}) {
  const { fullSwipeThreshold, onFullSwipeArmedChange, secondaryAction, translation } = props;
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary" || secondaryAction === null;
  const actionsWidth = swipeActionsWidth(secondaryAction !== null);
  useAnimatedReaction(
    () => -translation.value >= fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(onFullSwipeArmedChange)(armed);
      }
    },
    [fullSwipeThreshold, onFullSwipeArmedChange, translation],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        tone={props.primaryAction.destructive === true ? "danger" : "primary"}
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        slidesUnderStretch={false}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          tone={secondaryAction.tone}
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          slidesUnderStretch={fullSwipeIsPrimary}
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  );
}
