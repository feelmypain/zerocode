import {
  USAGE_PROVIDER_LABELS,
  USAGE_PROVIDER_ORDER,
} from "@zerocode/client-runtime/state/usage-view";
import type { UsageProviderKind } from "@zerocode/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { providerColors } from "./providerColors";

export const PROVIDER_ORDER = USAGE_PROVIDER_ORDER;

export function usageProviderKind(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  return PROVIDER_ORDER.find((kind) => kind === driver) ?? null;
}

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = USAGE_PROVIDER_LABELS;

export function useProviderColors(): Record<UsageProviderKind, string> {
  return providerColors(useAppearancePreferences().themeAppearance);
}

export function useUsageMixColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    input: dark ? "#737373" : "#848484",
    cacheRead: dark ? "#282828" : "#c0c0c0",
    cacheWrite: dark ? "#949494" : "#6d6d6d",
    output: dark ? "#e6e6e6" : "#3c3c43",
    other: dark ? "#494949" : "#a3a3a3",
    standard: dark ? "#313131" : "#b8b8b8",
    fast: dark ? "#838383" : "#797979",
    ultrafast: dark ? "#e6e6e6" : "#3c3c43",
  };
}
