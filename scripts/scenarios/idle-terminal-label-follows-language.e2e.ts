import { expect } from "e2e";

import { test, WEB } from "./zerocode.ts";

test(
  "An idle numbered terminal shows its name in the app's language after switching threads",
  WEB,
  async ({ zerocode, app, browser, screen }) => {
    const project = await zerocode.project("demo");
    const thread = await zerocode.thread({ project, title: "Terminal work", messages: ["Start"] });
    await zerocode.thread({ project, title: "Other work", messages: ["Start"] });

    await zerocode.open("/settings/general");
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Français", { exact: true }).tap();
    await screen.getByLabel("Langue", { exact: true }).waitFor();

    await zerocode.open(thread);
    const drawerToggle = screen.getByRole("button", "Afficher/masquer le tiroir du terminal");
    await drawerToggle.tap();
    const input = browser.locator('[aria-label="Saisie du terminal"][data-workspace-focus-default]');
    await input.waitFor();
    await screen.getByRole("button", /^Nouveau terminal(?: \(|$)/).tap();
    const secondTerminal = screen.getByRole("button", "Terminal 2");
    await secondTerminal.waitFor();
    await screen.getByRole("button", "Other work", { exact: false }).tap();
    await screen.getByRole("button", "Terminal work", { exact: false }).tap();

    // Wait for a real process label so the idle assertion reads server metadata, not the fallback
    // shown while the second terminal is opening.
    await secondTerminal.tap();
    await input.focus();
    await browser.keyboard.type("sleep 60\n");
    await screen.getByRole("button", "sleep", { exact: true }).waitFor({ timeout: 40_000 });
    await input.focus();
    await browser.keyboard.press("Control+C");
    await secondTerminal.waitFor({ timeout: 40_000 });

    await app.screenshot("idle-terminal-after-switch");
    await expect(secondTerminal).toHaveText("Terminal 2");
  },
);
