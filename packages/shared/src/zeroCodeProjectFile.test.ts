import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseZeroCodeProjectFile, ZeroCodeProjectFileFromJson } from "./zeroCodeProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(ZeroCodeProjectFileFromJson);

describe("ZeroCodeProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseZeroCodeProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseZeroCodeProjectFile(`{
        /* See https://raw.githubusercontent.com/feelmypain/zerocode/main/zerocode.schema.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
