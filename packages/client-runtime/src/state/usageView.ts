import {
  USAGE_CONTRACT_VERSION,
  type AuthSessionState,
  type EnvironmentId,
  type UsageBucket,
  type UsageModelFilter,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@zerocode/contracts";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@zerocode/shared/usageMerge";
import { AsyncResult, Atom } from "effect/reactivity";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { usageSummaryInput } from "./usage.ts";
import { resolveUsageAccess } from "./usageAccess.ts";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export const USAGE_PROVIDER_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse Code",
} as const satisfies Record<UsageProviderKind, string>;

export const USAGE_PROVIDER_ORDER: readonly UsageProviderKind[] = Object.keys(
  USAGE_PROVIDER_LABELS,
) as UsageProviderKind[];

export function usageWindowKey(input: UsageSummaryInput): string {
  return JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(({ environmentId, label, summary }) =>
    summary === null
      ? []
      : [
          {
            environmentId,
            label,
            summary:
              keepBucket === undefined
                ? summary
                : { ...summary, buckets: summary.buckets.filter(keepBucket) },
          },
        ],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}

export function usageReportingState(selectedEnvironments: readonly EnvironmentUsageStatus[]): {
  readonly answeredCount: number;
  readonly stillReporting: number;
  readonly isPending: boolean;
  readonly isPartial: boolean;
} {
  let answeredCount = 0;
  let stillReporting = 0;
  for (const environment of selectedEnvironments) {
    if (environment.summary !== null) answeredCount += 1;
    else if (environment.error === null) stillReporting += 1;
  }
  return {
    answeredCount,
    stillReporting,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
  };
}

export function refreshableUsageEnvironmentIds(
  selectedEnvironments: readonly EnvironmentUsageStatus[],
  hasDiagnosticsScope: (environmentId: EnvironmentId) => boolean,
): ReadonlyArray<EnvironmentId> {
  return selectedEnvironments
    .filter(
      (environment) =>
        environment.canReadDiagnostics && hasDiagnosticsScope(environment.environmentId),
    )
    .map(({ environmentId }) => environmentId);
}

export function createUsageByWindowAtomFamily<SessionError, UsageError>(options: {
  readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
  readonly sessionStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<AuthSessionState, SessionError>>;
  readonly usageSummary: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: UsageSummaryInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<UsageSummary, UsageError>>;
  readonly usageModelFilterAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<UsageModelFilter | undefined>;
  readonly labelPrefix: string;
  readonly resolveAccess?: MFunctionType;
  readonly failureMessage: () => string;
}): (windowKey: string) => Atom.Atom<readonly EnvironmentUsageStatus[]> {
  return Atom.family((windowKey: string) =>
    Atom.make((get): readonly EnvironmentUsageStatus[] => {
      const input = JSON.parse(windowKey) as UsageSummaryInput;
      const presentations = get(options.presentationsAtom);

      const statuses: EnvironmentUsageStatus[] = [];
      for (const [environmentId, presentation] of presentations) {
        const isConnected = presentation.connection.phase === "connected";
        const sessionResult = get(options.sessionStateAtom(environmentId));
        const access = resolveUsageAccess(
          {
            connectionPhase: presentation.connection.phase,
            session: AsyncResult.getOrElse(sessionResult, () => null),
            hasSessionError: sessionResult._tag === "Failure",
          },
          options.resolveAccess,
        );
        if (!access.canReadDiagnostics) {
          statuses.push({
            environmentId,
            label: presentation.entry.target.label,
            isConnected,
            ...access,
            summary: null,
          });
          continue;
        }
        const result = get(
          options.usageSummary({
            environmentId,
            input: usageSummaryInput(input, get(options.usageModelFilterAtom(environmentId))),
          }),
        );
        const summary = AsyncResult.getOrElse(result, () => null);
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isPending: result.waiting,
          canReadDiagnostics: true,
          isConnected,
          error: result._tag === "Failure" ? options.failureMessage() : null,
          summary,
        });
      }
      return statuses;
    }).pipe(Atom.withLabel(`${options.labelPrefix}:window:${windowKey}`)),
  );
}
