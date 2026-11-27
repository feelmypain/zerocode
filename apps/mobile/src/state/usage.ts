import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageSummaryInput,
} from "@zerocode/contracts";
import { refreshUsage } from "@zerocode/client-runtime/state/usage";
import {
  createUsageByWindowAtomFamily,
  mergeAnsweredUsage,
  refreshableUsageEnvironmentIds,
  usageReportingState,
  usageWindowKey,
  type EnvironmentUsageStatus,
} from "@zerocode/client-runtime/state/usage-view";
import type { MergedUsage } from "@zerocode/shared/usageMerge";
import { Atom } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";
import { useCallback, useMemo } from "react";

import { keepMarked } from "../i18n/messages";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

export type { EnvironmentUsageStatus };

const usageByWindowAtom = createUsageByWindowAtomFamily({
  presentationsAtom: environmentPresentations.presentationsAtom,
  sessionStateAtom: environmentSession.sessionStateAtom,
  usageSummary: serverEnvironment.usageSummary,
  usageModelFilterAtom: serverEnvironment.usageModelFilterAtom,
  labelPrefix: "mobile-usage",
  resolveAccess: keepMarked,
  failureMessage: () => msg("This environment could not report usage."),
});

/** Every environment usage can come from, without asking any of them for usage. */
const usageEnvironmentsAtom = Atom.make((get): readonly EnvironmentUsageStatus[] =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    isPending: true,
    isConnected: presentation.connection.phase === "connected",
    canReadDiagnostics: false,
    error: null,
    summary: null,
  })),
).pipe(Atom.withLabel("mobile-usage:environments"));

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];

  readonly isPending: boolean;

  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  /** Off, it lists the environments without loading their usage. */
  load = true,
): UsageView {
  const windowKey = usageWindowKey(input);
  const messages = useMessages();
  const markedEnvironments = useAtomValue(
    load ? usageByWindowAtom(windowKey) : usageEnvironmentsAtom,
  );
  const environments = useMemo(
    () =>
      markedEnvironments.map((environment) =>
        environment.error === null
          ? environment
          : { ...environment, error: messages(environment.error) },
      ),
    [markedEnvironments, messages],
  );
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );

  const refresh = useCallback(
    (nextInput?: UsageSummaryInput) =>
      refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        environmentIds: refreshableUsageEnvironmentIds(selectedEnvironments, (environmentId) =>
          readEnvironmentScope(environmentId, AuthDiagnosticsReadScope),
        ),
        input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
      }),
    [selectedEnvironments, windowKey],
  );

  const merged = useMemo(() => mergeAnsweredUsage(selectedEnvironments), [selectedEnvironments]);
  const { isPending, isPartial } = usageReportingState(selectedEnvironments);

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending,
    isPartial,
    refresh,
  };
}
