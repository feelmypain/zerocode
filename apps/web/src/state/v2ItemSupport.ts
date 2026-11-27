import { useAtomValue } from "@effect/atom-react";
import type { V2ItemSupport } from "@zerocode/client-runtime/state/item-support";
import { createV2ItemSupportAtomFamily } from "@zerocode/client-runtime/state/item-support-atoms";
import type { EnvironmentId, ThreadId, TurnItemId } from "@zerocode/contracts";

import { environmentThreadDetails } from "./threads";

const itemSupportAtom = createV2ItemSupportAtomFamily(
  environmentThreadDetails.threadAtom,
  "web-v2-item-support",
);

export function useV2ItemSupport(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtom({
      environmentId: input.environmentId,
      threadId: input.sourceThreadId,
      itemId: input.sourceItemId,
    }),
  );
}
