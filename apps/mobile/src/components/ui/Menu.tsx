import { MenuView } from "@react-native-menu/menu";
import {
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import type { ColorValue, PressableProps } from "react-native";
import { withUniwind } from "uniwind";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { withMenuActionIconColors } from "../../lib/menu-action-colors";
import { perfProbe } from "../../features/development/perf-probe-hooks";
import type { MenuProps } from "./Menu.types";

const ThemedMenuView = withUniwind(
  function NativeMenuView({
    iconColor,
    destructiveIconColor,
    ...props
  }: ComponentProps<typeof MenuView> & {
    readonly iconColor?: ColorValue;
    readonly destructiveIconColor?: ColorValue;
  }) {
    const actions = useMemo(
      () =>
        withMenuActionIconColors(props.actions, {
          icon: iconColor,
          destructiveIcon: destructiveIconColor,
        }),
      [props.actions, iconColor, destructiveIconColor],
    );
    return <MenuView {...props} actions={actions} />;
  },
  {
    iconColor: { fromClassName: "iconColorClassName", styleProperty: "accentColor" },
    destructiveIconColor: {
      fromClassName: "destructiveIconColorClassName",
      styleProperty: "accentColor",
    },
  },
);

function createMenuPressController() {
  let isPreparing = false;
  let isOpen = false;
  let suppressPress = false;
  let pendingPress: (() => void) | null = null;
  return {
    onTouchStart(
      event: Parameters<NonNullable<PressableProps["onTouchStart"]>>[0],
      childOnTouchStart?: PressableProps["onTouchStart"],
    ) {
      // onPressIn can repeat within one gesture when a finger leaves and re-enters the row.
      isPreparing = false;
      suppressPress = isOpen;
      pendingPress = null;
      childOnTouchStart?.(event);
    },
    onPress(
      event: Parameters<NonNullable<PressableProps["onPress"]>>[0],
      childOnPress?: PressableProps["onPress"],
    ) {
      // Accessibility clicks lack touch identifiers and must ignore previous touch cancellation.
      const isTouch = typeof event.nativeEvent.identifier === "number";
      if (isTouch ? suppressPress : isOpen) {
        return;
      }
      if (isTouch && isPreparing) {
        // A release can precede native display; let UIKit's display/cancel callback decide its outcome.
        event.persist();
        pendingPress = () => childOnPress?.(event);
        return;
      }
      childOnPress?.(event);
    },
    onMenuInteractionStart(callback?: () => void) {
      isPreparing = true;
      callback?.();
    },
    onOpenMenu(callback?: () => void) {
      isPreparing = false;
      isOpen = true;
      suppressPress = true;
      pendingPress = null;
      callback?.();
    },
    onCloseMenu(callback?: () => void) {
      isPreparing = false;
      isOpen = false;
      // Keep cancellation through finger-up even if the menu dismisses first.
      const press = pendingPress;
      pendingPress = null;
      callback?.();
      if (!suppressPress) {
        press?.();
      }
    },
  };
}

export function Menu(props: MenuProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const [pressController] = useState(createMenuPressController);

  const { className: _className, ...menuProps } = props;
  let children = menuProps.children;
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    const child = children as ReactElement<Pick<PressableProps, "onTouchStart" | "onPress">>;
    children = cloneElement(child, {
      onTouchStart: (event) => pressController.onTouchStart(event, child.props.onTouchStart),
      onPress: (event) => pressController.onPress(event, child.props.onPress),
    });
    menuProps.onMenuInteractionStart = () =>
      pressController.onMenuInteractionStart(props.onMenuInteractionStart);
    menuProps.onOpenMenu = () => pressController.onOpenMenu(props.onOpenMenu);
    menuProps.onCloseMenu = () => pressController.onCloseMenu(props.onCloseMenu);
  }
  const { onPressAction } = props;
  const probe = perfProbe;
  if (probe && onPressAction)
    menuProps.onPressAction = (event) => {
      probe.menuAction();
      onPressAction(event);
    };
  return (
    <ThemedMenuView
      {...menuProps}
      iconColorClassName="accent-icon"
      destructiveIconColorClassName="accent-danger-foreground"
      themeVariant={isDarkMode ? "dark" : "light"}
    >
      {children}
    </ThemedMenuView>
  );
}
