import type { PullRequestChangeBreakdown } from "@zerocode/contracts";
import { summarizeChangedFiles } from "@zerocode/shared/changedFileKind";
import type { ProviderFileStats } from "@zerocode/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}
