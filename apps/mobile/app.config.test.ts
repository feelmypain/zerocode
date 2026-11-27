import { DEFAULT_HOSTED_APP_URL } from "@zerocode/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    ZEROCODE_MOBILE_VERSION: process.env.ZEROCODE_MOBILE_VERSION,
    ZEROCODE_MOBILE_ANDROID_VERSION_CODE: process.env.ZEROCODE_MOBILE_ANDROID_VERSION_CODE,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.zerocode.app"],
  ["development", "com.zerocode.app.dev"],
  ["preview", "com.zerocode.app.preview"],
  ["production", "com.zerocode.app"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while the hosted app lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).hostname;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("applies ZEROCODE_MOBILE_VERSION and positive integer ZEROCODE_MOBILE_ANDROID_VERSION_CODE", async () => {
  vi.stubEnv("ZEROCODE_MOBILE_VERSION", "0.1.18");
  vi.stubEnv("ZEROCODE_MOBILE_ANDROID_VERSION_CODE", "1018");
  const config = await loadConfig("production");
  expect(config.version).toBe("0.1.18");
  expect(config.android?.versionCode).toBe(1018);

  vi.stubEnv("ZEROCODE_MOBILE_ANDROID_VERSION_CODE", "invalid");
  const invalidConfig = await loadConfig("production");
  expect(invalidConfig.android?.versionCode).toBeUndefined();
});
