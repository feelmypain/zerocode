import type { PullRequestStack } from "@zerocode/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export function pullRequestStackView(
  query: {
    data: PullRequestStack | null;
    isSuccess: boolean;
    isPending: boolean;
    error: string | null;
  },
  saved: PullRequestStack | null,
  resolve: MessageResolver = m,
) {
  const data = query.isSuccess ? query.data : (query.data ?? saved);
  return {
    data,
    // A settled read: one still out may be showing an answer restored from the device.
    isFresh: query.isSuccess && !query.isPending,
    notice:
      data === null
        ? null
        : query.error
          ? resolve(msg("Stack data may be stale. We couldn’t refresh it."))
          : !query.isSuccess || query.isPending
            ? resolve(msg("Refreshing stack… Showing saved data."))
            : null,
  };
}
