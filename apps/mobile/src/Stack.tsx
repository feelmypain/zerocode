import { isDraftThreadRoute } from "./features/threads/thread-route-state";
import { createWorkspaceStackNavigator } from "./features/layout/createWorkspaceStackNavigator";
import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import { msg, T, useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/ui/AppText";
import { androidWorkspaceDestinationAnimation } from "./lib/android-workspace-navigation";
import { getCompactBrandHeaderOptions } from "./features/layout/workspace/brand-header-options";
import { WorkspaceConnectionStatusProvider } from "./features/home/WorkspaceConnectionTitle";
import { WorkspaceRootScreen } from "./features/layout/workspace/WorkspaceRootScreen";
import {
  recordHomeFocus,
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
} from "./features/home/home-route-visibility";
import { AndroidWorkspaceTabsProvider } from "./features/layout/workspace/AndroidWorkspaceTabsProvider";
import {
  RenderErrorBoundary,
  RenderFailureView,
  type RenderFailureProps,
} from "./components/RenderErrorBoundary";
import { AdaptiveWorkspaceLayout } from "./features/layout/AdaptiveWorkspaceLayout";
import {
  HardwareKeyboardCommandOverlay,
  HardwareKeyboardCommandProvider,
} from "./features/keyboard/HardwareKeyboardCommandProvider";
import {
  FullscreenThreadRouteScreen,
  ThreadRouteScreen,
} from "./features/threads/ThreadRouteScreen";
import { NewTaskFlowProvider } from "./features/threads/new-task-flow-provider";
import { newTaskFlowKey } from "./features/threads/new-task-flow-state";
import { SettingsEnvironmentFilterProvider } from "./features/settings/settings-environment-filter";
import { openSettings, settingsOpenIn } from "./features/settings/settings-navigation";
import { DEFAULT_SETTINGS_PAGE } from "./features/layout/workspace/workspace-tab-navigation";
import {
  isWorkspaceOverlayRoute,
  registerPresentedRoutes,
} from "./features/layout/workspace-overlay-routes";
import { ShowcaseReadyMarker } from "./features/showcase/ShowcaseCaptureCoordinator";
import { immersiveRoute, modalRoute, pageRoute, sheetRoute } from "./features/layout/route-options";
import { deriveLayout } from "./lib/layout";
import { useNativeLayoutMetrics } from "./native/native-layout-metrics";
import { isPresentedRoute } from "./native/workspace-stack-projection";
import { workspaceDetailRouter } from "./features/layout/workspace/workspace-detail-selection";

const settingsPage = () => pageRoute({ itemStyle: "standard" });

const { title: _compactBrandTitle, ...compactBrandHeaderOptions } = getCompactBrandHeaderOptions();

// Resolved in the rendered Navigator's screenOptions so each header title follows the UI language;
// route options stay plain objects because registerPresentedRoutes reads them at load.
const ROUTE_TITLES: Readonly<Record<string, string>> = {
  Settings: msg("Settings"),
  SettingsEnvironments: msg("Environments"),
  SettingsEnvironmentDetail: msg("Environment"),
  SettingsEnvironmentNewThreads: msg("Threads"),
  SettingsEnvironmentSourceControl: msg("Source control & issues"),
  SettingsSourceControlProvider: msg("Provider", {
    $context: "settings page of one source control provider",
  }),
  SettingsIssueTracker: msg("Issue tracker"),
  SettingsEnvironmentAgentBehavior: msg("Threads"),
  SettingsWorktrees: msg("Worktrees"),
  SettingsLabs: msg("Labs"),
  SettingsProviderAccounts: msg("Providers"),
  SettingsEnvironmentMaintenance: msg("Maintenance"),
  SettingsNotifications: msg("Notifications"),
  SettingsThreads: msg("Threads"),
  SettingsAbout: msg("About"),
  SettingsEnvironmentNew: msg("Add Environment"),
  SettingsArchive: msg("Archive", { $context: "noun, settings page of archived threads" }),
  SettingsNavigation: msg("Navigation tabs"),
  SettingsAppearance: msg("Appearance"),
  SettingsProjectGrouping: msg("General"),
  SettingsOrganization: msg("General"),
  SettingsLanguage: msg("Language"),
  SettingsProjectOverview: msg("Projects"),
  SettingsKeyboard: msg("Keyboard"),
  SettingsVoice: msg("Voice"),
  SettingsFollowUp: msg("Chat", { $context: "noun, settings page title" }),
  SettingsScheduledTasks: msg("Scheduled tasks"),
  SettingsScheduledTaskNew: msg("New scheduled task"),
  SettingsScheduledTaskEdit: msg("Edit scheduled task"),
  SettingsScheduledTaskBranch: msg("Base branch"),
  SettingsScheduledTaskThread: msg("Destination"),
  SettingsClientStorage: msg("Client Storage"),
  SettingsDiagnostics: msg("Diagnostics"),
  SettingsUsageAccount: msg("Account"),
  SettingsOpenSourceLicenses: msg("Open source licenses"),
  SettingsOpenSourceLicense: msg("License notice"),
  SettingsUsage: msg("Usage"),
  ComponentCatalog: msg("UI components"),
  NewTaskProject: msg("Choose project"),
  NewTaskEnvironment: msg("Environment"),
  NewTaskBranch: msg("Branch"),
  NewTaskRepositories: msg("Repositories"),
  AddProject: msg("Add project"),
  ThreadFiles: msg("Files"),
  WorkflowRun: msg("Run", { $context: "noun, page title for one workflow run" }),
  SettingsLegal: msg("Legal"),
  ConnectOnboarding: msg("Set up {product}", { product: "ZeroCode Connect" }),
  Connections: msg("Environments"),
  ConnectionsNew: msg("Add Environment"),
};

// Thread settings keep the Duo's vertical bar so cancel, search, filter and confirm sit in the
// rail. The picker stack spans the sheet so its header reaches the rail, and insets its content.
const THREAD_SETTINGS_ROUTE = sheetRoute({
  detent: "full",
  header: "none",
  android: "card",
  spansRail: true,
});

// Search sheets push on Android like the branch picker; a formSheet there leaves the list's
// header peeking above it once the keyboard opens.
const SEARCH_SHEET_ROUTE = sheetRoute({ detent: 0.75, android: "card", itemStyle: "editor" });

// Non-initial route screens use React Navigation v7 static `get screen()` getters so Metro
// defers evaluating their module trees until first navigation.
const SETTINGS_SCREENS = {
  Settings: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsRouteScreen").SettingsRouteScreen {
      return (
        require("./features/settings/SettingsRouteScreen") as typeof import("./features/settings/SettingsRouteScreen")
      ).SettingsRouteScreen;
    },
    linking: "settings",
    options: {
      ...pageRoute({ itemStyle: "standard", root: true }),
      ...(Platform.OS === "android" ? { animation: "none" as const } : {}),
    },
  }),
  SettingsEnvironments: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsEnvironmentsRouteScreen").SettingsEnvironmentsRouteScreen {
      return (
        require("./features/settings/SettingsEnvironmentsRouteScreen") as typeof import("./features/settings/SettingsEnvironmentsRouteScreen")
      ).SettingsEnvironmentsRouteScreen;
    },
    linking: "settings/environments",
    options: settingsPage(),
  }),
  SettingsEnvironmentDetail: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsEnvironmentDetailRouteScreen").SettingsEnvironmentDetailRouteScreen {
      return (
        require("./features/settings/SettingsEnvironmentDetailRouteScreen") as typeof import("./features/settings/SettingsEnvironmentDetailRouteScreen")
      ).SettingsEnvironmentDetailRouteScreen;
    },
    linking: "settings/environments/:environmentId",
    options: settingsPage(),
  }),
  // Old links to New threads and Agent behavior open Threads, which absorbed them.
  SettingsEnvironmentNewThreads: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsThreadsRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsThreadsRouteScreen;
    },
    linking: "settings/new-threads",
    options: settingsPage(),
  }),
  SettingsEnvironmentSourceControl: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsEnvironmentSourceControlRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsEnvironmentSourceControlRouteScreen;
    },
    linking: "settings/source-control",
    options: settingsPage(),
  }),
  SettingsSourceControlProvider: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsSourceControlDetailRouteScreens").SettingsSourceControlProviderRouteScreen {
      return (
        require("./features/settings/SettingsSourceControlDetailRouteScreens") as typeof import("./features/settings/SettingsSourceControlDetailRouteScreens")
      ).SettingsSourceControlProviderRouteScreen;
    },
    options: settingsPage(),
  }),
  SettingsIssueTracker: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsSourceControlDetailRouteScreens").SettingsIssueTrackerRouteScreen {
      return (
        require("./features/settings/SettingsSourceControlDetailRouteScreens") as typeof import("./features/settings/SettingsSourceControlDetailRouteScreens")
      ).SettingsIssueTrackerRouteScreen;
    },
    options: settingsPage(),
  }),
  SettingsEnvironmentAgentBehavior: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsThreadsRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsThreadsRouteScreen;
    },
    linking: "settings/agent-behavior",
    options: settingsPage(),
  }),
  SettingsWorktrees: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsWorktreesRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsWorktreesRouteScreen;
    },
    linking: "settings/worktrees",
    options: settingsPage(),
  }),
  SettingsLabs: createNativeStackScreen({
    get screen(): typeof import("./features/settings/ThreadSettingsSections").SettingsLabsRouteScreen {
      return (
        require("./features/settings/ThreadSettingsSections") as typeof import("./features/settings/ThreadSettingsSections")
      ).SettingsLabsRouteScreen;
    },
    linking: "settings/labs",
    options: settingsPage(),
  }),
  SettingsProviderAccounts: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsProviderAccountsRouteScreen").SettingsProviderAccountsRouteScreen {
      return (
        require("./features/settings/SettingsProviderAccountsRouteScreen") as typeof import("./features/settings/SettingsProviderAccountsRouteScreen")
      ).SettingsProviderAccountsRouteScreen;
    },
    linking: "settings/provider-accounts",
    options: settingsPage(),
  }),
  SettingsEnvironmentMaintenance: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsEnvironmentMaintenanceRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsEnvironmentMaintenanceRouteScreen;
    },
    linking: "settings/maintenance",
    options: settingsPage(),
  }),
  SettingsNotifications: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsNotificationsRouteScreen").SettingsNotificationsRouteScreen {
      return (
        require("./features/settings/SettingsNotificationsRouteScreen") as typeof import("./features/settings/SettingsNotificationsRouteScreen")
      ).SettingsNotificationsRouteScreen;
    },
    linking: "settings/notifications",
    options: settingsPage(),
  }),
  SettingsThreads: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsServerControlsRouteScreen").SettingsThreadsRouteScreen {
      return (
        require("./features/settings/SettingsServerControlsRouteScreen") as typeof import("./features/settings/SettingsServerControlsRouteScreen")
      ).SettingsThreadsRouteScreen;
    },
    linking: "settings/thread-preferences",
    options: settingsPage(),
  }),
  SettingsAbout: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsAboutRouteScreen").SettingsAboutRouteScreen {
      return (
        require("./features/settings/SettingsAboutRouteScreen") as typeof import("./features/settings/SettingsAboutRouteScreen")
      ).SettingsAboutRouteScreen;
    },
    linking: "settings/about",
    options: settingsPage(),
  }),
  SettingsEnvironmentNew: createNativeStackScreen({
    get screen(): typeof import("./features/connection/ConnectionsNewRouteScreen").ConnectionsNewRouteScreen {
      return (
        require("./features/connection/ConnectionsNewRouteScreen") as typeof import("./features/connection/ConnectionsNewRouteScreen")
      ).ConnectionsNewRouteScreen;
    },
    linking: "settings/environment-new",
    options: settingsPage(),
  }),
  SettingsArchive: createNativeStackScreen({
    get screen(): typeof import("./features/archive/ArchivedThreadsRouteScreen").ArchivedThreadsRouteScreen {
      return (
        require("./features/archive/ArchivedThreadsRouteScreen") as typeof import("./features/archive/ArchivedThreadsRouteScreen")
      ).ArchivedThreadsRouteScreen;
    },
    linking: "settings/archive",
    options: settingsPage(),
  }),
  SettingsNavigation: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsNavigationRouteScreen").SettingsNavigationRouteScreen {
      return (
        require("./features/settings/SettingsNavigationRouteScreen") as typeof import("./features/settings/SettingsNavigationRouteScreen")
      ).SettingsNavigationRouteScreen;
    },
    linking: "settings/navigation-tabs",
    options: settingsPage(),
  }),
  SettingsAppearance: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsAppearanceRouteScreen").SettingsAppearanceRouteScreen {
      return (
        require("./features/settings/SettingsAppearanceRouteScreen") as typeof import("./features/settings/SettingsAppearanceRouteScreen")
      ).SettingsAppearanceRouteScreen;
    },
    linking: "settings/appearance",
    options: settingsPage(),
  }),
  SettingsProjectGrouping: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsProjectGroupingRouteScreen").SettingsProjectGroupingRouteScreen {
      return (
        require("./features/settings/SettingsProjectGroupingRouteScreen") as typeof import("./features/settings/SettingsProjectGroupingRouteScreen")
      ).SettingsProjectGroupingRouteScreen;
    },
    linking: "settings/project-grouping",
    options: settingsPage(),
  }),
  SettingsOrganization: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsProjectGroupingRouteScreen").SettingsProjectGroupingRouteScreen {
      return (
        require("./features/settings/SettingsProjectGroupingRouteScreen") as typeof import("./features/settings/SettingsProjectGroupingRouteScreen")
      ).SettingsProjectGroupingRouteScreen;
    },
    linking: "settings/organization",
    options: settingsPage(),
  }),
  SettingsLanguage: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsLanguageRouteScreen").SettingsLanguageRouteScreen {
      return (
        require("./features/settings/SettingsLanguageRouteScreen") as typeof import("./features/settings/SettingsLanguageRouteScreen")
      ).SettingsLanguageRouteScreen;
    },
    linking: "settings/language",
    options: settingsPage(),
  }),
  SettingsProjectOverview: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsProjectOverviewRouteScreen").SettingsProjectOverviewRouteScreen {
      return (
        require("./features/settings/SettingsProjectOverviewRouteScreen") as typeof import("./features/settings/SettingsProjectOverviewRouteScreen")
      ).SettingsProjectOverviewRouteScreen;
    },
    linking: "settings/project",
    options: settingsPage(),
  }),
  SettingsKeyboard: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsKeyboardRouteScreen").SettingsKeyboardRouteScreen {
      return (
        require("./features/settings/SettingsKeyboardRouteScreen") as typeof import("./features/settings/SettingsKeyboardRouteScreen")
      ).SettingsKeyboardRouteScreen;
    },
    linking: "settings/keyboard",
    options: settingsPage(),
  }),
  SettingsVoice: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsVoiceRouteScreen").SettingsVoiceRouteScreen {
      return (
        require("./features/settings/SettingsVoiceRouteScreen") as typeof import("./features/settings/SettingsVoiceRouteScreen")
      ).SettingsVoiceRouteScreen;
    },
    linking: { path: "settings/voice", alias: ["settings/microphone"] },
    options: settingsPage(),
  }),
  SettingsVoiceModels: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsVoiceModelsRouteScreen").SettingsVoiceModelsRouteScreen {
      return (
        require("./features/settings/SettingsVoiceModelsRouteScreen") as typeof import("./features/settings/SettingsVoiceModelsRouteScreen")
      ).SettingsVoiceModelsRouteScreen;
    },
    options: SEARCH_SHEET_ROUTE,
  }),
  SettingsFollowUp: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsFollowUpRouteScreen").SettingsFollowUpRouteScreen {
      return (
        require("./features/settings/SettingsFollowUpRouteScreen") as typeof import("./features/settings/SettingsFollowUpRouteScreen")
      ).SettingsFollowUpRouteScreen;
    },
    linking: "settings/follow-ups",
    options: settingsPage(),
  }),
  SettingsScheduledTasks: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsScheduledTasksRouteScreen").SettingsScheduledTasksRouteScreen {
      return (
        require("./features/settings/SettingsScheduledTasksRouteScreen") as typeof import("./features/settings/SettingsScheduledTasksRouteScreen")
      ).SettingsScheduledTasksRouteScreen;
    },
    linking: "settings/scheduled-tasks",
    options: {
      ...settingsPage(),
      headerTitleStyle: { fontSize: 16, fontWeight: "800" },
    },
  }),
  SettingsScheduledTaskNew: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsScheduledTasksRouteScreen").SettingsScheduledTaskNewRouteScreen {
      return (
        require("./features/settings/SettingsScheduledTasksRouteScreen") as typeof import("./features/settings/SettingsScheduledTasksRouteScreen")
      ).SettingsScheduledTaskNewRouteScreen;
    },
    linking: "settings/scheduled-tasks/new",
    options: settingsPage(),
  }),
  SettingsScheduledTaskEdit: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsScheduledTasksRouteScreen").SettingsScheduledTaskEditRouteScreen {
      return (
        require("./features/settings/SettingsScheduledTasksRouteScreen") as typeof import("./features/settings/SettingsScheduledTasksRouteScreen")
      ).SettingsScheduledTaskEditRouteScreen;
    },
    options: settingsPage(),
  }),
  SettingsScheduledTaskBranch: createNativeStackScreen({
    get screen(): typeof import("./features/settings/ScheduledTaskPickerScreens").ScheduledTaskBranchPickerRouteScreen {
      return (
        require("./features/settings/ScheduledTaskPickerScreens") as typeof import("./features/settings/ScheduledTaskPickerScreens")
      ).ScheduledTaskBranchPickerRouteScreen;
    },
    options: settingsPage(),
  }),
  SettingsScheduledTaskThread: createNativeStackScreen({
    get screen(): typeof import("./features/settings/ScheduledTaskPickerScreens").ScheduledTaskThreadPickerRouteScreen {
      return (
        require("./features/settings/ScheduledTaskPickerScreens") as typeof import("./features/settings/ScheduledTaskPickerScreens")
      ).ScheduledTaskThreadPickerRouteScreen;
    },
    options: settingsPage(),
  }),
  SettingsScheduledTaskModel: createNativeStackScreen({
    get screen(): typeof import("./features/settings/ScheduledTaskPickerScreens").ScheduledTaskModelPickerRouteScreen {
      return (
        require("./features/settings/ScheduledTaskPickerScreens") as typeof import("./features/settings/ScheduledTaskPickerScreens")
      ).ScheduledTaskModelPickerRouteScreen;
    },
    options: THREAD_SETTINGS_ROUTE,
  }),
  SettingsClientStorage: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsClientStorageRouteScreen").SettingsClientStorageRouteScreen {
      return (
        require("./features/settings/SettingsClientStorageRouteScreen") as typeof import("./features/settings/SettingsClientStorageRouteScreen")
      ).SettingsClientStorageRouteScreen;
    },
    linking: "settings/client-storage",
    options: settingsPage(),
  }),
  SettingsDiagnostics: createNativeStackScreen({
    get screen(): typeof import("./features/diagnostics/SettingsDiagnosticsRouteScreen").SettingsDiagnosticsRouteScreen {
      return (
        require("./features/diagnostics/SettingsDiagnosticsRouteScreen") as typeof import("./features/diagnostics/SettingsDiagnosticsRouteScreen")
      ).SettingsDiagnosticsRouteScreen;
    },
    linking: "settings/diagnostics",
    options: settingsPage(),
  }),
  // These params snapshot the tap time, local filters, and freshly aggregated pools.
  // A linking path would round-trip them as URL query strings and preserve stale values.
  SettingsUsageAccount: createNativeStackScreen({
    get screen(): typeof import("./features/usage/UsageLimitsPooled").UsageLimitAccountScreen {
      return (
        require("./features/usage/UsageLimitsPooled") as typeof import("./features/usage/UsageLimitsPooled")
      ).UsageLimitAccountScreen;
    },
    options: settingsPage(),
  }),
  SettingsOpenSourceLicenses: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsOpenSourceLicensesRouteScreen").SettingsOpenSourceLicensesRouteScreen {
      return (
        require("./features/settings/SettingsOpenSourceLicensesRouteScreen") as typeof import("./features/settings/SettingsOpenSourceLicensesRouteScreen")
      ).SettingsOpenSourceLicensesRouteScreen;
    },
    linking: "settings/open-source-licenses",
    options: settingsPage(),
  }),
  SettingsOpenSourceLicense: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsOpenSourceLicensesRouteScreen").SettingsOpenSourceLicenseRouteScreen {
      return (
        require("./features/settings/SettingsOpenSourceLicensesRouteScreen") as typeof import("./features/settings/SettingsOpenSourceLicensesRouteScreen")
      ).SettingsOpenSourceLicenseRouteScreen;
    },
    linking: "settings/open-source-licenses/:entryKey",
    options: settingsPage(),
  }),
  SettingsUsage: createNativeStackScreen({
    get screen(): typeof import("./features/usage/UsageRouteScreen").UsageRouteScreen {
      return (
        require("./features/usage/UsageRouteScreen") as typeof import("./features/usage/UsageRouteScreen")
      ).UsageRouteScreen;
    },
    linking: "settings/usage",
    options: settingsPage(),
  }),
  SettingsAuth: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsAuthRouteScreen").SettingsAuthRouteScreen {
      return (
        require("./features/settings/SettingsAuthRouteScreen") as typeof import("./features/settings/SettingsAuthRouteScreen")
      ).SettingsAuthRouteScreen;
    },
    linking: "settings/auth",
    options: { headerShown: false, presentation: "modal" },
  }),
  SettingsWaitlist: createNativeStackScreen({
    get screen(): typeof import("./features/settings/SettingsAuthRouteScreen").SettingsAuthRouteScreen {
      return (
        require("./features/settings/SettingsAuthRouteScreen") as typeof import("./features/settings/SettingsAuthRouteScreen")
      ).SettingsAuthRouteScreen;
    },
    linking: "settings/waitlist",
    options: { headerShown: false, presentation: "modal" },
  }),
};

// iOS 26 header morphing requires one UINavigationBar; nested stacks make the whole screen slide.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

export function workspaceLocationFromState(state: NavigationState) {
  const routes = state.routes.filter((route) => !isWorkspaceOverlayRoute(route.name));
  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? ({ ...state, routes, index: routes.length - 1 } as NavigationState)
      : state;
  const path = getPathFromState(effectiveState, navigationPathConfig);
  const route = effectiveState.routes[effectiveState.index];
  return {
    pathname: path.startsWith("/") ? path : `/${path}`,
    routeKey: route?.key,
    routeName: route?.name,
  };
}

export function rootPathnameFromState(state: NavigationState): string {
  const path = getPathFromState(state, navigationPathConfig);
  return path.startsWith("/") ? path : `/${path}`;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const pathname = rootPathnameFromState(props.state);
  const workspaceLocation = workspaceLocationFromState(props.state);
  const settingsOpen = settingsOpenIn(
    props.state.routes
      .slice(0, props.state.index + 1)
      .filter((route) => !isWorkspaceOverlayRoute(route.name)),
  );
  // The flow follows the draft route even while a pushed Thread covers it, so
  // its state lives exactly as long as the route.
  const draftRoute = props.state.routes.findLast(isDraftThreadRoute);
  const draftRouteOnTop =
    draftRoute !== undefined &&
    props.state.routes.findLast((route) => route.name === "Thread") === draftRoute;
  const draftParams = (
    draftRoute?.params as { draft?: { draftId?: string | string[] } } | undefined
  )?.draft;
  const routeDraftId = Array.isArray(draftParams?.draftId)
    ? draftParams.draftId[0]
    : draftParams?.draftId;

  return (
    <NewTaskFlowProvider
      active={draftRouteOnTop}
      flowKey={draftRoute === undefined ? undefined : newTaskFlowKey(draftRoute)}
      routeDraftId={routeDraftId}
    >
      <HardwareKeyboardCommandProvider pathname={pathname}>
        <ShowcaseReadyMarker />
        <SettingsEnvironmentFilterProvider open={settingsOpen}>
          <WorkspaceConnectionStatusProvider>
            <AndroidWorkspaceTabsProvider state={props.state}>
              <AdaptiveWorkspaceLayout
                pathname={workspaceLocation.pathname}
                workspaceRouteKey={workspaceLocation.routeKey}
                workspaceRouteName={workspaceLocation.routeName}
              >
                {props.children}
                <HardwareKeyboardCommandOverlay />
              </AdaptiveWorkspaceLayout>
            </AndroidWorkspaceTabsProvider>
          </WorkspaceConnectionStatusProvider>
        </SettingsEnvironmentFilterProvider>
      </HardwareKeyboardCommandProvider>
    </NewTaskFlowProvider>
  );
}

function NotFoundScreen() {
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));
  const returnHomeButtonStyle = StyleSheet.flatten([
    {
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-zerocode-bold text-foreground" selectable>
        <T>Route not found</T>
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-zerocode-bold text-primary-foreground">
          <T>Return home</T>
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const RootStackConfig = createWorkspaceStackNavigator({
  initialRouteName: "Home",
  UNSTABLE_router: workspaceDetailRouter,
  // React Navigation calls layouts inline; compiled components would share the navigator's memo cache.
  layout: (props) => <RootStackLayout {...props} />,
  screenOptions: { headerShown: false },
  screens: {
    ...(__DEV__
      ? {
          ComponentCatalog: createNativeStackScreen({
            get screen(): typeof import("./features/development/ComponentCatalogScreen").ComponentCatalogScreen {
              return (
                require("./features/development/ComponentCatalogScreen") as typeof import("./features/development/ComponentCatalogScreen")
              ).ComponentCatalogScreen;
            },
            linking: "dev/components",
          }),
        }
      : {}),
    Home: createNativeStackScreen({
      screen: WorkspaceRootScreen,
      linking: "",
      listeners: ({ navigation }) => ({
        transitionStart: ({ data }) => recordHomeTransitionStart(data.closing),
        transitionEnd: ({ data }) => recordHomeTransitionEnd(data.closing, navigation.isFocused()),
        focus: recordHomeFocus,
      }),
      options: {
        ...pageRoute({ duoMinimize: "never", root: true }),
        contentStyle: { backgroundColor: "transparent" },
        ...compactBrandHeaderOptions,
      },
    }),
    PullRequest: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestRouteScreen").PullRequestRouteScreen {
        return (
          require("./features/pull-requests/PullRequestRouteScreen") as typeof import("./features/pull-requests/PullRequestRouteScreen")
        ).PullRequestRouteScreen;
      },
      linking: {
        path: "pull-requests/:environmentId/:projectId/:repository/:number",
        parse: { number: Number },
      },
      options: pageRoute({ duoMinimize: "never" }),
    }),
    PullRequestGuideStop: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/guide/PullRequestGuideScreen").PullRequestGuideStopScreen {
        return (
          require("./features/pull-requests/guide/PullRequestGuideScreen") as typeof import("./features/pull-requests/guide/PullRequestGuideScreen")
        ).PullRequestGuideStopScreen;
      },
      options: pageRoute(),
    }),
    PullRequestFile: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestRouteScreen").PullRequestFileRouteScreen {
        return (
          require("./features/pull-requests/PullRequestRouteScreen") as typeof import("./features/pull-requests/PullRequestRouteScreen")
        ).PullRequestFileRouteScreen;
      },
      options: pageRoute(),
    }),
    PullRequestFiles: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestFiles").PullRequestFilesSheet {
        return (
          require("./features/pull-requests/PullRequestFiles") as typeof import("./features/pull-requests/PullRequestFiles")
        ).PullRequestFilesSheet;
      },
      options: sheetRoute({ detent: 0.6 }),
    }),
    PullRequestReviewers: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestReviewersScreen").PullRequestReviewersScreen {
        return (
          require("./features/pull-requests/PullRequestReviewersScreen") as typeof import("./features/pull-requests/PullRequestReviewersScreen")
        ).PullRequestReviewersScreen;
      },
      options: sheetRoute({ detent: 0.75, itemStyle: "editor", duoMinimize: "never" }),
    }),
    PullRequestLabels: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestLabelsScreen").PullRequestLabelsScreen {
        return (
          require("./features/pull-requests/PullRequestLabelsScreen") as typeof import("./features/pull-requests/PullRequestLabelsScreen")
        ).PullRequestLabelsScreen;
      },
      options: SEARCH_SHEET_ROUTE,
    }),
    PullRequestFilterSearch: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestFilterSearchScreen").PullRequestFilterSearchScreen {
        return (
          require("./features/pull-requests/PullRequestFilterSearchScreen") as typeof import("./features/pull-requests/PullRequestFilterSearchScreen")
        ).PullRequestFilterSearchScreen;
      },
      options: SEARCH_SHEET_ROUTE,
    }),
    PullRequestDiscussion: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestDiscussionScreen").PullRequestDiscussionScreen {
        return (
          require("./features/pull-requests/PullRequestDiscussionScreen") as typeof import("./features/pull-requests/PullRequestDiscussionScreen")
        ).PullRequestDiscussionScreen;
      },
      options: pageRoute(),
    }),
    PullRequestInlineComment: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestInlineCommentScreen").PullRequestInlineCommentScreen {
        return (
          require("./features/pull-requests/PullRequestInlineCommentScreen") as typeof import("./features/pull-requests/PullRequestInlineCommentScreen")
        ).PullRequestInlineCommentScreen;
      },
      options: sheetRoute({ detent: 0.75, android: "fullScreen" }),
    }),
    PullRequestReview: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestReviewSheet").PullRequestReviewSheet {
        return (
          require("./features/pull-requests/PullRequestReviewSheet") as typeof import("./features/pull-requests/PullRequestReviewSheet")
        ).PullRequestReviewSheet;
      },
      options: sheetRoute({ detent: 0.75, androidFit: true }),
    }),
    PullRequestEdit: createNativeStackScreen({
      get screen(): typeof import("./features/pull-requests/PullRequestEditScreen").PullRequestEditScreen {
        return (
          require("./features/pull-requests/PullRequestEditScreen") as typeof import("./features/pull-requests/PullRequestEditScreen")
        ).PullRequestEditScreen;
      },
      options: sheetRoute({ detent: 0.75, androidFit: true }),
    }),
    Issue: createNativeStackScreen({
      get screen(): typeof import("./features/issues/IssueRouteScreen").IssueRouteScreen {
        return (
          require("./features/issues/IssueRouteScreen") as typeof import("./features/issues/IssueRouteScreen")
        ).IssueRouteScreen;
      },
      linking: "issues/:environmentId/:projectId/:tracker/:scope/:issueKey",
      options: pageRoute({ duoMinimize: "never" }),
    }),
    IssueEdit: createNativeStackScreen({
      get screen(): typeof import("./features/issues/IssueEditScreen").IssueEditScreen {
        return (
          require("./features/issues/IssueEditScreen") as typeof import("./features/issues/IssueEditScreen")
        ).IssueEditScreen;
      },
      options: sheetRoute({ detent: 0.75, androidFit: true }),
    }),
    IssueLabels: createNativeStackScreen({
      get screen(): typeof import("./features/issues/IssueLabelsScreen").IssueLabelsScreen {
        return (
          require("./features/issues/IssueLabelsScreen") as typeof import("./features/issues/IssueLabelsScreen")
        ).IssueLabelsScreen;
      },
      options: SEARCH_SHEET_ROUTE,
    }),
    IssueAssignees: createNativeStackScreen({
      get screen(): typeof import("./features/issues/IssueAssigneesScreen").IssueAssigneesScreen {
        return (
          require("./features/issues/IssueAssigneesScreen") as typeof import("./features/issues/IssueAssigneesScreen")
        ).IssueAssigneesScreen;
      },
      options: SEARCH_SHEET_ROUTE,
    }),
    IssueFilterSearch: createNativeStackScreen({
      get screen(): typeof import("./features/issues/IssueFilterSearchScreen").IssueFilterSearchScreen {
        return (
          require("./features/issues/IssueFilterSearchScreen") as typeof import("./features/issues/IssueFilterSearchScreen")
        ).IssueFilterSearchScreen;
      },
      options: SEARCH_SHEET_ROUTE,
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: { path: "threads/:environmentId?/:threadId?", alias: ["new/draft"] },
      options: pageRoute({ duoMinimize: "onScrollUp" }),
    }),
    NewTaskProject: createNativeStackScreen({
      get screen(): typeof import("./features/threads/NewTaskRouteScreen").NewTaskRouteScreen {
        return (
          require("./features/threads/NewTaskRouteScreen") as typeof import("./features/threads/NewTaskRouteScreen")
        ).NewTaskRouteScreen;
      },
      linking: { path: "new", alias: ["new/project"] },
      options: pageRoute(),
    }),
    NewTaskEnvironment: createNativeStackScreen({
      linking: "new/draft/environment",
      get screen(): typeof import("./features/threads/NewTaskContextPickerScreens").NewTaskEnvironmentPickerRouteScreen {
        return (
          require("./features/threads/NewTaskContextPickerScreens") as typeof import("./features/threads/NewTaskContextPickerScreens")
        ).NewTaskEnvironmentPickerRouteScreen;
      },
      options: pageRoute(),
    }),
    NewTaskBranch: createNativeStackScreen({
      linking: "new/draft/branch",
      get screen(): typeof import("./features/threads/NewTaskContextPickerScreens").NewTaskBranchPickerRouteScreen {
        return (
          require("./features/threads/NewTaskContextPickerScreens") as typeof import("./features/threads/NewTaskContextPickerScreens")
        ).NewTaskBranchPickerRouteScreen;
      },
      options: pageRoute(),
    }),
    NewTaskRepositories: createNativeStackScreen({
      linking: "new/draft/repositories",
      get screen(): typeof import("./features/threads/NewTaskContextPickerScreens").NewTaskRepositoriesPickerRouteScreen {
        return (
          require("./features/threads/NewTaskContextPickerScreens") as typeof import("./features/threads/NewTaskContextPickerScreens")
        ).NewTaskRepositoriesPickerRouteScreen;
      },
      options: pageRoute(),
    }),
    AddProject: createNativeStackScreen({
      linking: "new/add-project",
      get screen(): typeof import("./features/projects/AddProjectSourceRoute").AddProjectSourceRoute {
        return (
          require("./features/projects/AddProjectSourceRoute") as typeof import("./features/projects/AddProjectSourceRoute")
        ).AddProjectSourceRoute;
      },
      options: pageRoute(),
    }),
    AddProjectRepository: createNativeStackScreen({
      linking: "new/add-project/repository",
      get screen(): typeof import("./features/projects/AddProjectRepositoryRoute").AddProjectRepositoryRoute {
        return (
          require("./features/projects/AddProjectRepositoryRoute") as typeof import("./features/projects/AddProjectRepositoryRoute")
        ).AddProjectRepositoryRoute;
      },
      options: pageRoute(),
    }),
    AddProjectDestination: createNativeStackScreen({
      linking: "new/add-project/destination",
      get screen(): typeof import("./features/projects/AddProjectDestinationRoute").AddProjectDestinationRoute {
        return (
          require("./features/projects/AddProjectDestinationRoute") as typeof import("./features/projects/AddProjectDestinationRoute")
        ).AddProjectDestinationRoute;
      },
      options: pageRoute(),
    }),
    AddProjectLocal: createNativeStackScreen({
      linking: "new/add-project/local",
      get screen(): typeof import("./features/projects/AddProjectLocalRoute").AddProjectLocalRoute {
        return (
          require("./features/projects/AddProjectLocalRoute") as typeof import("./features/projects/AddProjectLocalRoute")
        ).AddProjectLocalRoute;
      },
      options: pageRoute(),
    }),
    AddProjectNew: createNativeStackScreen({
      linking: "new/add-project/new",
      get screen(): typeof import("./features/projects/AddProjectNewRoute").AddProjectNewRoute {
        return (
          require("./features/projects/AddProjectNewRoute") as typeof import("./features/projects/AddProjectNewRoute")
        ).AddProjectNewRoute;
      },
      options: pageRoute(),
    }),
    NewTaskFiles: createNativeStackScreen({
      linking: "new/draft/files",
      get screen(): typeof import("./features/files/ThreadFilesRouteScreen").ThreadFilesTreeScreen {
        return (
          require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
        ).ThreadFilesTreeScreen;
      },
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskFile: createNativeStackScreen({
      linking: "new/draft/files/:path*",
      get screen(): typeof import("./features/files/ThreadFilesRouteScreen").ThreadFileScreen {
        return (
          require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
        ).ThreadFileScreen;
      },
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskAttachment: createNativeStackScreen({
      get screen(): typeof import("./features/files/AttachmentFileScreen").AttachmentFileScreen {
        return (
          require("./features/files/AttachmentFileScreen") as typeof import("./features/files/AttachmentFileScreen")
        ).AttachmentFileScreen;
      },
      linking: "new/draft/attachments/:attachmentId",
      options: pageRoute({ header: "solid" }),
    }),
    NewTaskThreadSettings: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadSettingsSheet").NewTaskThreadSettingsRouteScreen {
        return (
          require("./features/threads/ThreadSettingsSheet") as typeof import("./features/threads/ThreadSettingsSheet")
        ).NewTaskThreadSettingsRouteScreen;
      },
      linking: "new/draft/settings",
      options: THREAD_SETTINGS_ROUTE,
    }),
    ThreadTerminal: createNativeStackScreen({
      get screen(): typeof import("./features/terminal/ThreadTerminalRouteScreen").ThreadTerminalRouteScreen {
        return (
          require("./features/terminal/ThreadTerminalRouteScreen") as typeof import("./features/terminal/ThreadTerminalRouteScreen")
        ).ThreadTerminalRouteScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/terminal`,
      options: pageRoute({ header: "solid" }),
    }),
    ThreadInspectorFullscreen: createNativeStackScreen({
      screen: FullscreenThreadRouteScreen,
      options: modalRoute({ header: "glass", itemStyle: "editor", duoMinimize: "onScrollUp" }),
    }),
    ThreadDevicePreview: createNativeStackScreen({
      get screen(): typeof import("./features/devices/DevicePreviewRouteScreen").DevicePreviewRouteScreen {
        return (
          require("./features/devices/DevicePreviewRouteScreen") as typeof import("./features/devices/DevicePreviewRouteScreen")
        ).DevicePreviewRouteScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/devices`,
      options: immersiveRoute({ hideSystemBars: true }),
    }),
    ThreadBrowserPreview: createNativeStackScreen({
      get screen(): typeof import("./features/browser/BrowserPreviewRouteScreen").BrowserPreviewRouteScreen {
        return (
          require("./features/browser/BrowserPreviewRouteScreen") as typeof import("./features/browser/BrowserPreviewRouteScreen")
        ).BrowserPreviewRouteScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/browser`,
      options: immersiveRoute({ fullWidth: true }),
    }),
    ThreadLocalPreview: createNativeStackScreen({
      get screen(): typeof import("./features/browser/LocalPreviewRouteScreen").LocalPreviewRouteScreen {
        return (
          require("./features/browser/LocalPreviewRouteScreen") as typeof import("./features/browser/LocalPreviewRouteScreen")
        ).LocalPreviewRouteScreen;
      },
      linking: "environments/:environmentId/local-preview",
      options: immersiveRoute({ fullWidth: true }),
    }),
    ThreadReview: createNativeStackScreen({
      get screen(): typeof import("./features/review/ReviewSheet").ReviewSheet {
        return (
          require("./features/review/ReviewSheet") as typeof import("./features/review/ReviewSheet")
        ).ReviewSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/review`,
      options: pageRoute(),
    }),
    ThreadReviewComment: createNativeStackScreen({
      get screen(): typeof import("./features/review/ReviewCommentComposerSheet").ReviewCommentComposerSheet {
        return (
          require("./features/review/ReviewCommentComposerSheet") as typeof import("./features/review/ReviewCommentComposerSheet")
        ).ReviewCommentComposerSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/review-comment`,
      options: sheetRoute({ detent: 0.55, android: "fullScreen" }),
    }),
    ThreadFiles: createNativeStackScreen({
      get screen(): typeof import("./features/files/ThreadFilesRouteScreen").ThreadFilesTreeScreen {
        return (
          require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
        ).ThreadFilesTreeScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/files`,
      options: pageRoute(),
    }),
    ThreadFile: createNativeStackScreen({
      get screen(): typeof import("./features/files/ThreadFilesRouteScreen").ThreadFileScreen {
        return (
          require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
        ).ThreadFileScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/files/:path*`,
      options: pageRoute(),
    }),
    ThreadMcpApp: createNativeStackScreen({
      get screen(): typeof import("./features/threads/McpAppFullscreenScreen").McpAppFullscreenScreen {
        return (
          require("./features/threads/McpAppFullscreenScreen") as typeof import("./features/threads/McpAppFullscreenScreen")
        ).McpAppFullscreenScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/apps/:itemId`,
      options: { ...modalRoute({ header: "solid" }), gestureEnabled: false },
    }),
    ThreadAttachment: createNativeStackScreen({
      get screen(): typeof import("./features/files/AttachmentFileScreen").AttachmentFileScreen {
        return (
          require("./features/files/AttachmentFileScreen") as typeof import("./features/files/AttachmentFileScreen")
        ).AttachmentFileScreen;
      },
      linking: `${THREAD_LINKING_PREFIX}/attachments/:attachmentId`,
      options: pageRoute({ header: "solid" }),
    }),
    ThreadSettingsSheet: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadSettingsSheet").ExistingThreadSettingsRouteScreen {
        return (
          require("./features/threads/ThreadSettingsSheet") as typeof import("./features/threads/ThreadSettingsSheet")
        ).ExistingThreadSettingsRouteScreen;
      },
      options: THREAD_SETTINGS_ROUTE,
    }),
    ThreadQueue: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadQueueControl").ThreadQueueSheet {
        return (
          require("./features/threads/ThreadQueueControl") as typeof import("./features/threads/ThreadQueueControl")
        ).ThreadQueueSheet;
      },
      options: sheetRoute({ detent: 0.65, androidMaxDetent: 0.95 }),
    }),
    WorkflowRun: createNativeStackScreen({
      get screen(): typeof import("./features/workflows/WorkflowRunRouteScreen").WorkflowRunRouteScreen {
        return (
          require("./features/workflows/WorkflowRunRouteScreen") as typeof import("./features/workflows/WorkflowRunRouteScreen")
        ).WorkflowRunRouteScreen;
      },
      linking: { path: "workflows/:environmentId/:runId" },
      options: pageRoute(),
    }),
    WorkflowStep: createNativeStackScreen({
      get screen(): typeof import("./features/workflows/WorkflowStepSheet").WorkflowStepSheet {
        return (
          require("./features/workflows/WorkflowStepSheet") as typeof import("./features/workflows/WorkflowStepSheet")
        ).WorkflowStepSheet;
      },
      options: sheetRoute({ detent: 0.6, androidMaxDetent: 0.95 }),
    }),
    ThreadBackgroundWork: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadBackgroundWorkSheet").ThreadBackgroundWorkSheet {
        return (
          require("./features/threads/ThreadBackgroundWorkSheet") as typeof import("./features/threads/ThreadBackgroundWorkSheet")
        ).ThreadBackgroundWorkSheet;
      },
      options: sheetRoute({ detent: 0.5, androidMaxDetent: 0.9 }),
    }),
    ThreadAgents: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadAgentsSheet").ThreadAgentsSheet {
        return (
          require("./features/threads/ThreadAgentsSheet") as typeof import("./features/threads/ThreadAgentsSheet")
        ).ThreadAgentsSheet;
      },
      options: sheetRoute({ detent: 0.5, androidMaxDetent: 0.9 }),
    }),
    LinkedThread: createNativeStackScreen({
      get screen(): typeof import("./features/threads/LinkedThreadSheet").LinkedThreadSheet {
        return (
          require("./features/threads/LinkedThreadSheet") as typeof import("./features/threads/LinkedThreadSheet")
        ).LinkedThreadSheet;
      },
      options: sheetRoute({ detent: 0.9, android: "fullScreen" }),
    }),
    // Maximized from the inspector, like ThreadInspectorFullscreen.
    LinkedThreadFullscreen: createNativeStackScreen({
      get screen(): typeof import("./features/threads/LinkedThreadSheet").LinkedThreadSheet {
        return (
          require("./features/threads/LinkedThreadSheet") as typeof import("./features/threads/LinkedThreadSheet")
        ).LinkedThreadSheet;
      },
      options: modalRoute({ header: "glass", itemStyle: "editor", duoMinimize: "onScrollUp" }),
    }),
    ThreadGuestShare: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadGuestShareSheet").ThreadGuestShareSheet {
        return (
          require("./features/threads/ThreadGuestShareSheet") as typeof import("./features/threads/ThreadGuestShareSheet")
        ).ThreadGuestShareSheet;
      },
      options: sheetRoute({ detent: 0.5 }),
    }),
    GitOverview: createNativeStackScreen({
      get screen(): typeof import("./features/threads/git/GitOverviewSheet").GitOverviewSheet {
        return (
          require("./features/threads/git/GitOverviewSheet") as typeof import("./features/threads/git/GitOverviewSheet")
        ).GitOverviewSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/git`,
      options: sheetRoute({ detent: 0.55 }),
    }),
    ThreadPullRequests: createNativeStackScreen({
      get screen(): typeof import("./features/threads/ThreadPullRequestsSheet").ThreadPullRequestsSheet {
        return (
          require("./features/threads/ThreadPullRequestsSheet") as typeof import("./features/threads/ThreadPullRequestsSheet")
        ).ThreadPullRequestsSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/pull-requests`,
      options: sheetRoute({ detent: 0.55 }),
    }),
    GitCommit: createNativeStackScreen({
      get screen(): typeof import("./features/threads/git/GitCommitSheet").GitCommitSheet {
        return (
          require("./features/threads/git/GitCommitSheet") as typeof import("./features/threads/git/GitCommitSheet")
        ).GitCommitSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/git/commit`,
      options: sheetRoute({ detent: 0.8, androidFit: true }),
    }),
    GitBranches: createNativeStackScreen({
      get screen(): typeof import("./features/threads/git/GitBranchesSheet").GitBranchesSheet {
        return (
          require("./features/threads/git/GitBranchesSheet") as typeof import("./features/threads/git/GitBranchesSheet")
        ).GitBranchesSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/git/branches`,
      options: sheetRoute({ detent: 0.55, androidFit: true }),
    }),
    GitConfirm: createNativeStackScreen({
      get screen(): typeof import("./features/threads/git/GitConfirmSheet").GitConfirmSheet {
        return (
          require("./features/threads/git/GitConfirmSheet") as typeof import("./features/threads/git/GitConfirmSheet")
        ).GitConfirmSheet;
      },
      linking: `${THREAD_LINKING_PREFIX}/git-confirm`,
      options: sheetRoute({ detent: 0.55, maxDetent: 0.7, androidFit: true }),
    }),
    ...SETTINGS_SCREENS,
    SettingsLegal: createNativeStackScreen({
      get screen(): typeof import("./features/settings/SettingsLegalRouteScreen").SettingsLegalRouteScreen {
        return (
          require("./features/settings/SettingsLegalRouteScreen") as typeof import("./features/settings/SettingsLegalRouteScreen")
        ).SettingsLegalRouteScreen;
      },
      linking: "settings/legal",
      options: modalRoute({ header: "solid" }),
    }),
    ConnectOnboarding: createNativeStackScreen({
      get screen(): typeof import("./features/cloud/ConnectOnboardingRouteScreen").ConnectOnboardingRouteScreen {
        return (
          require("./features/cloud/ConnectOnboardingRouteScreen") as typeof import("./features/cloud/ConnectOnboardingRouteScreen")
        ).ConnectOnboardingRouteScreen;
      },
      linking: "connect-onboarding",
      options: sheetRoute({
        header: "solid",
        detent: 0.6,
        androidMaxDetent: 0.95,
      }),
    }),
    Connections: createNativeStackScreen({
      get screen(): typeof import("./features/connection/ConnectionsRouteScreen").ConnectionsRouteScreen {
        return (
          require("./features/connection/ConnectionsRouteScreen") as typeof import("./features/connection/ConnectionsRouteScreen")
        ).ConnectionsRouteScreen;
      },
      linking: "connections",
      options: sheetRoute({ detent: 0.55, maxDetent: 0.7, android: "card" }),
    }),
    ConnectionsNew: createNativeStackScreen({
      get screen(): typeof import("./features/connection/ConnectionsNewRouteScreen").ConnectionsNewRouteScreen {
        return (
          require("./features/connection/ConnectionsNewRouteScreen") as typeof import("./features/connection/ConnectionsNewRouteScreen")
        ).ConnectionsNewRouteScreen;
      },
      linking: "connections/new",
      options: sheetRoute({ detent: 0.55, maxDetent: 0.7 }),
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});

function GuardedScreenLayout(props: {
  readonly children: ReactNode;
  readonly route: { readonly name: string; readonly params?: object | undefined };
}) {
  return (
    <RenderErrorBoundary
      resetKeys={[props.route.params]}
      renderFallback={(fallback) => (
        <ScreenRenderFallback {...fallback} routeName={props.route.name} />
      )}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}

function ScreenRenderFallback(props: RenderFailureProps & { readonly routeName: string }) {
  const navigation = useNavigation();
  const gt = useGT();
  const exit = navigation.canGoBack()
    ? { label: gt("Go back"), onPress: () => navigation.goBack() }
    : props.routeName === "Home"
      ? // Home itself failed, and the Settings list renders inside it; open a Settings page.
        {
          label: gt("Open settings"),
          onPress: () => openSettings(navigation, DEFAULT_SETTINGS_PAGE),
        }
      : {
          label: gt("Return home"),
          onPress: () => navigation.dispatch(StackActions.replace("Home")),
        };

  return <RenderFailureView {...props} exit={exit} />;
}

registerPresentedRoutes(
  Object.entries(RootStackConfig.config.screens ?? {}).flatMap(([name, screen]) => {
    const options = (screen as { readonly options?: unknown }).options;
    return options && typeof options === "object" && isPresentedRoute(options) ? [name] : [];
  }),
);

export const RootStack = RootStackConfig.with(function AdaptiveRootStack({ Navigator }) {
  const { width, height } = useWindowDimensions();
  const nativeMetrics = useNativeLayoutMetrics();
  const usesSplitView = deriveLayout({ width, height, nativeMetrics }).usesSplitView;
  const resolve = useMessages();

  /* oxlint-disable react/no-unstable-nested-components -- React Navigation invokes screenLayout as a render callback. */
  return (
    <Navigator
      screenLayout={(props) => <GuardedScreenLayout {...props} />}
      screenOptions={({ route, navigation }) => {
        const title =
          route.name === "Home"
            ? getCompactBrandHeaderOptions(undefined, resolve).title
            : ROUTE_TITLES[route.name] === undefined
              ? undefined
              : resolve(ROUTE_TITLES[route.name]);
        return {
          ...(title === undefined ? {} : { title }),
          ...(Platform.OS === "android"
            ? {
                animation: androidWorkspaceDestinationAnimation(
                  route,
                  navigation.getState().routes,
                  usesSplitView,
                ),
              }
            : {}),
        };
      }}
    />
  );

  /* oxlint-enable react/no-unstable-nested-components */
});

type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
