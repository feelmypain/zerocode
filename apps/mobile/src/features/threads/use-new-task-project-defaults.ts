import { resolveFilesystemReadAccess } from "@zerocode/client-runtime/state/filesystem";
import { isScratchProject } from "@zerocode/client-runtime/state/projects";
import type { EnvironmentProject } from "@zerocode/client-runtime/state/shell";
import type { ProjectReadFileResult } from "@zerocode/contracts";
import { DEFAULT_SERVER_SETTINGS, ZEROCODE_PROJECT_FILE_NAME } from "@zerocode/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@zerocode/shared/projectSettings";
import { parseZeroCodeProjectFile } from "@zerocode/shared/zeroCodeProjectFile";

import { m } from "../../i18n/messages";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * A project's new-task defaults: server settings merged with its zerocode.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(project: EnvironmentProject | null) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    m,
  );
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const zeroCodeProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: ZEROCODE_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const zeroCodeProjectFileData = zeroCodeProjectFileQuery.data as ProjectReadFileResult | null;
  const zeroCodeProjectFile =
    zeroCodeProjectFileData === null || zeroCodeProjectFileData.exists === false || zeroCodeProjectFileData.truncated
      ? null
      : parseZeroCodeProjectFile(zeroCodeProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    zeroCodeProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const defaultWorkspaceMode = isScratch
    ? "local"
    : resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: serverConfig?.newProjectsRoot,
        projectHasThreads,
      });
  // While zerocode.json loads, the environment default is provisional; zerocode.json may replace it.
  const defaultWorkspaceModeSettled =
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!zeroCodeProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
  };
}
