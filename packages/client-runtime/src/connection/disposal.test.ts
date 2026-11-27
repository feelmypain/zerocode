import { EnvironmentId, ProjectId } from "@zerocode/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { notifyEnvironmentDisposed, trackAtomRegistry } from "./disposal.ts";
import { pullRequestPendingEditsAtom } from "../state/pullRequests.ts";
import { serverUpdateStateAtom } from "../state/server.ts";
import { createVcsActionManager, EMPTY_VCS_ACTION_STATE } from "../state/vcsAction.ts";
import { createThreadEnvironmentAtoms } from "../state/threadCommands.ts";

describe("environmentDisposed cleanup", () => {
  it("purges keepAlive atoms and module Maps for a disposed environment without touching other environments", async () => {
    const envA = EnvironmentId.make("env-dispose-a");
    const envB = EnvironmentId.make("env-dispose-b");
    const registry = AtomRegistry.make();
    trackAtomRegistry(registry);

    const runtime = Atom.runtime(Layer.empty) as never;
    const vcs = createVcsActionManager(runtime);
    const threadCommands = createThreadEnvironmentAtoms(
      runtime,
      () => Atom.make(null),
      () => Atom.make("live" as const),
    );

    const targetA = { environmentId: envA, cwd: "/repo-a" };
    const targetB = { environmentId: envB, cwd: "/repo-b" };
    const cmdA1 = vcs.runStackedAction(targetA);
    const cmdB1 = vcs.runStackedAction(targetB);

    await vcs.track(registry, targetA, { operation: "pull", label: "Pulling..." }, async () =>
      AsyncResult.failure(Cause.fail(new Error("failed"))),
    );
    await vcs.track(registry, targetB, { operation: "pull", label: "Pulling..." }, async () =>
      AsyncResult.failure(Cause.fail(new Error("failed"))),
    );
    expect(registry.get(vcs.stateAtom(targetA)).error).toBe("failed");
    expect(registry.get(vcs.stateAtom(targetB)).error).toBe("failed");

    registry.set(serverUpdateStateAtom(envA), {
      status: "failed",
      stage: "downloading",
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
      message: "oops",
    });
    registry.set(serverUpdateStateAtom(envB), {
      status: "failed",
      stage: "downloading",
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
      message: "keep",
    });

    registry.set(pullRequestPendingEditsAtom(envA), [
      {
        reference: {
          projectId: ProjectId.make("p1"),
          repository: "acme/web",
          number: 1,
        },
        title: "Edited",
      },
    ]);
    registry.set(threadCommands.rowActionsAtom(envA), 3);
    registry.set(threadCommands.rowActionsAtom(envB), 5);

    notifyEnvironmentDisposed(envA);

    expect(registry.get(vcs.stateAtom(targetA))).toBe(EMPTY_VCS_ACTION_STATE);
    expect(registry.get(vcs.stateAtom(targetB)).error).toBe("failed");
    expect(vcs.runStackedAction(targetA)).not.toBe(cmdA1);
    expect(vcs.runStackedAction(targetB)).toBe(cmdB1);

    expect(registry.get(serverUpdateStateAtom(envA))).toEqual({ status: "idle" });
    expect(registry.get(serverUpdateStateAtom(envB))).toMatchObject({ status: "failed" });

    expect(registry.get(pullRequestPendingEditsAtom(envA))).toEqual([]);
    expect(registry.get(threadCommands.rowActionsAtom(envA))).toBe(0);
    expect(registry.get(threadCommands.rowActionsAtom(envB))).toBe(5);

    registry.dispose();
  });
});
