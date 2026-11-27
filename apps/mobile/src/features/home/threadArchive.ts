import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@zerocode/client-runtime/state/models";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}
