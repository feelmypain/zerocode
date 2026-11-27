import { expect } from "e2e";

import { test, WEB } from "./zerocode.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ zerocode, app, screen }) => {
    const project = await zerocode.project("demo");
    const thread = await zerocode.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await zerocode.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
