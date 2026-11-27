import type { PullRequestRef, PullRequestStack, ThreadPullRequestLink } from "@zerocode/contracts";

function compareLinkRecency(left: ThreadPullRequestLink, right: ThreadPullRequestLink): number {
  return (
    Date.parse(right.snapshot?.syncedAt ?? right.linkedAt) -
    Date.parse(left.snapshot?.syncedAt ?? left.linkedAt)
  );
}

/** Saved stack membership supplies navigation while offline, never head revisions for actions. */
export function savedPullRequestStack(
  links: ReadonlyArray<ThreadPullRequestLink>,
  reference: PullRequestRef,
): PullRequestStack | null {
  const host = reference.host?.toLowerCase();
  if (!host) return null;
  const repository = reference.repository.toLowerCase();
  const matching = links.filter(
    (link) => link.host.toLowerCase() === host && link.repository.toLowerCase() === repository,
  );
  const exact = matching.filter((link) => link.number === reference.number);
  const candidates =
    exact.length > 0
      ? exact
      : matching.filter((link) =>
          link.stack?.layers.some((layer) => layer.number === reference.number),
        );
  const stack = [...candidates].sort(compareLinkRecency)[0]?.stack;
  if (!stack || !stack.layers.some((layer) => layer.number === reference.number)) return null;
  return {
    id: stack.id,
    number: stack.number,
    url: stack.url,
    base: stack.base,
    layers: stack.layers.map((layer) => {
      const snapshot = matching
        .filter((link) => link.number === layer.number)
        .sort(compareLinkRecency)[0]?.snapshot;
      return {
        number: layer.number,
        headBranch: layer.headBranch,
        state: layer.state,
        ...(snapshot ? { title: snapshot.title, isDraft: snapshot.isDraft } : {}),
      };
    }),
  };
}
