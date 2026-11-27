import { useAtomValue } from "@effect/atom-react";
import type { V2ItemSupport } from "@zerocode/client-runtime/state/item-support";
import { createV2ItemSupportAtomFamily } from "@zerocode/client-runtime/state/item-support-atoms";
import type { EnvironmentId, ThreadId, TurnItemId } from "@zerocode/contracts";

import { environmentThreadDetails } from "./threads";

const itemSupportAtom = createV2ItemSupportAtomFamily(
  environmentThreadDetails.threadAtom,
  "mobile-v2-item-support",
);

export function useV2ItemSupport(target: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtom({
      environmentId: target.environmentId,
      threadId: target.sourceThreadId,
      itemId: target.sourceItemId,
    }),
  );
}
