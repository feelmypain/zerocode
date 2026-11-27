import type { EnvironmentId, ScopedProjectRef } from "@zerocode/contracts";
import { create } from "zustand";

import { readProject, subscribeProject } from "../state/entities";

export interface AddProjectToMachineRequest {
  readonly projectRef: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId | null;
}

export const useAddProjectToMachineRequest = create<{
  request: AddProjectToMachineRequest | null;
  session: number;
}>(() => ({
  request: null,
  session: 0,
}));

let endRequestWithProject: (() => void) | null = null;

/** Opens the dialog that clones a project onto another connected machine. */
export function openAddProjectToMachine(request: AddProjectToMachineRequest): void {
  if (readProject(request.projectRef) === null) return;
  endRequestWithProject?.();
  // The request ends when its project goes away, so a project that comes back
  // later cannot reopen a dialog nobody asked for.
  endRequestWithProject = subscribeProject(request.projectRef, (project) => {
    if (project === null) closeAddProjectToMachine();
  });
  useAddProjectToMachineRequest.setState((state) => ({ request, session: state.session + 1 }));
}

export function closeAddProjectToMachine(): void {
  endRequestWithProject?.();
  endRequestWithProject = null;
  useAddProjectToMachineRequest.setState({ request: null });
}
