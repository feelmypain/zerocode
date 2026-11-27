import { assert, it } from "@effect/vitest";

import {
  repositoryPathFromRemoteUrl,
  transportSafeSourceControlErrorValue,
} from "./SourceControlProvider.ts";

it("removes URL credentials, query parameters, and fragments from error transport values", () => {
  assert.strictEqual(
    transportSafeSourceControlErrorValue(
      "https://user:secret@example.test/org/repo/pull/42?token=secret#discussion",
    ),
    "https://example.test/org/repo/pull/42",
  );
});

it.each([
  ["git@github.com:FeelMyPain/zerocode.git", "FeelMyPain/zerocode"],
  ["github.com:FeelMyPain/zerocode.git", "FeelMyPain/zerocode"],
  ["gitlab.com:FeelMyPain/platform/zerocode", "FeelMyPain/platform/zerocode"],
  ["https://github.com/FeelMyPain/zerocode.git", "FeelMyPain/zerocode"],
  ["https://github.com/FeelMyPain/zerocode.git?view=compact", "FeelMyPain/zerocode"],
  ["https://github.com/FeelMyPain/zerocode.git#section", "FeelMyPain/zerocode"],
  ["C:/repos/zerocode", null],
])("reads the repository path of %s", (remoteUrl, expected) => {
  assert.strictEqual(repositoryPathFromRemoteUrl(remoteUrl), expected);
});
