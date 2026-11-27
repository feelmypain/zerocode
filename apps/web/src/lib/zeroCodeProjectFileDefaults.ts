import {
  ZEROCODE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type ZeroCodeProjectFile,
} from "@zerocode/contracts";
import { parseZeroCodeProjectFile } from "@zerocode/shared/zeroCodeProjectFile";
import { executeAtomQuery } from "@zerocode/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

function toZeroCodeProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): ZeroCodeProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    ZEROCODE_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseZeroCodeProjectFile(data.contents);
}

export async function readZeroCodeProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<ZeroCodeProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, ZEROCODE_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  return toZeroCodeProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's zerocode.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekZeroCodeProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): ZeroCodeProjectFile | null | undefined {
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, ZEROCODE_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toZeroCodeProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}
