import {
  ZEROCODE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ZeroCodeProjectFile,
  type ZeroCodeProjectFileScript,
} from "@zerocode/contracts";
import { parseZeroCodeProjectFile } from "@zerocode/shared/zeroCodeProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<ZeroCodeProjectFileScript> = [];

export interface ZeroCodeProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: ZeroCodeProjectFile | null;
  scripts: ReadonlyArray<ZeroCodeProjectFileScript>;
  refresh: () => void;
}

export function useZeroCodeProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): ZeroCodeProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    ZEROCODE_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  const refresh = query.refresh;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
      refresh,
    } as const;
  }
  const file = parseZeroCodeProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS, refresh } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS, refresh } as const;
}
