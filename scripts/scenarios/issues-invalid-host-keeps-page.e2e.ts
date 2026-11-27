import { expect } from "e2e";

import { test, WEB } from "./zerocode.ts";

test("An invalid host filter keeps the Issues page open", WEB, async ({ zerocode, app, browser }) => {
  await zerocode.project("demo");
  await zerocode.open("/issues?host=true");

  await app.screenshot("issues-invalid-host");
  await expect(browser.locator("h1")).toHaveText("Issues");
});
