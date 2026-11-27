import { expect } from "e2e";

import { test, WEB } from "./zerocode.ts";

test(
  "The right panel shortcut closes and reopens the Issues panel",
  WEB,
  async ({ zerocode, app, browser, screen }) => {
    await zerocode.project("demo");
    await zerocode.open("/issues?selectedProjectId=demo&tracker=github&scope=example/demo&key=42");

    const toggle = screen.getByRole("button", "Toggle right panel");
    await screen.getByRole("button", { name: "Toggle right panel", pressed: true }).waitFor();

    await browser.keyboard.press("ControlOrMeta+Alt+b");
    await app.screenshot("after-close-shortcut");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await browser.keyboard.press("ControlOrMeta+Alt+b");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  },
);
