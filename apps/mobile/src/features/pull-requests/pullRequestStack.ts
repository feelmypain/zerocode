import { changeRequestTermKind } from "@zerocode/client-runtime/change-request-term";
import type { ChangeRequestTerminology } from "@zerocode/client-runtime/source-control-clients";
import type { PullRequestStack } from "@zerocode/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export function pullRequestStackMerge(
  stack: PullRequestStack,
  number: number,
  terminology: ChangeRequestTerminology,
  resolve: MessageResolver = m,
) {
  const term = changeRequestTermKind(terminology);
  const position = stack.layers.findIndex((layer) => layer.number === number);
  const layers = stack.layers.slice(0, position + 1).filter((layer) => layer.state !== "merged");
  const heads = layers.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const reason =
    position < 0
      ? resolve(
          msg(
            "This {term, select, mr {merge request} cr {change request} other {pull request}} is no longer in the stack. Refresh it.",
            { term },
          ),
        )
      : stack.layers[position]?.state !== "open" || layers.length === 0
        ? resolve(
            msg(
              "There are no open layers to merge through this {term, select, mr {merge request} cr {change request} other {pull request}}.",
              { term },
            ),
          )
        : layers.some((layer) => layer.state !== "open")
          ? resolve(msg("Reopen the closed layers before merging this stack."))
          : layers.some((layer) => layer.isDraft)
            ? resolve(msg("Mark every layer being merged ready for review."))
            : heads.length !== layers.length
              ? resolve(msg("Refresh the stack to load its latest revisions before merging."))
              : null;
  return { position: position + 1, layers, heads, reason };
}

/** The list summary describes the layer it was opened from, so another layer's route drops it. */
export function pullRequestLayerParams<Params extends { readonly initialSummary?: unknown }>(
  params: Params,
  number: number,
) {
  const { initialSummary: _, ...layer } = params;
  return { ...layer, number };
}

export function singlePullRequestMergeAllowed(input: {
  readonly supportsStackActions: boolean;
  readonly hasStack: boolean;
  readonly isFresh: boolean;
}) {
  return !input.supportsStackActions || (!input.hasStack && input.isFresh);
}
