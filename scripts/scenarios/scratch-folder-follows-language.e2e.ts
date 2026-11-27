/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./zerocode.ts";

test(
  "The project folder for threads without a project follows the app language",
  WEB,
  async ({ zerocode, app, browser, screen }) => {
    const project = await zerocode.project("scenario-scratch");
    const thread = await zerocode.thread({ project, title: "Scratch work", messages: ["Start"] });

    // The scenario home is inside a Git checkout, where the server disables native scratch.
    // Advertise the seeded workspace as scratch while leaving the real project and thread in place.
    await browser.addInitScript((scratchWorkspaceRoot) => {
      const configRequests = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (request?._tag === "Request" && request.tag === "subscribeServerConfig") {
              configRequests.set(this, String(request.id));
            }
          }
        }
        return send.call(this, data);
      };
      const addEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return addEventListener.call(this, type, listener, options);
        }
        return addEventListener.call(
          this,
          type,
          (event: Event) => {
            const data = (event as MessageEvent).data;
            if (typeof data !== "string") return listener.call(this, event);
            const parsed = JSON.parse(data);
            let changed = false;
            for (const message of [parsed].flat()) {
              if (
                message?._tag !== "Chunk" ||
                String(message.requestId) !== configRequests.get(this)
              )
                continue;
              for (const value of message.values) {
                if (value.type === "snapshot") {
                  value.config.scratchWorkspaceRoot = scratchWorkspaceRoot;
                  changed = true;
                }
              }
            }
            return listener.call(
              this,
              changed ? new MessageEvent("message", { data: JSON.stringify(parsed) }) : event,
            );
          },
          options,
        );
      } as typeof WebSocket.prototype.addEventListener;
    }, project);

    await zerocode.open("/settings/labs");
    await screen.getByLabel("Boring sidebar (group by project)", { exact: true }).tap();
    await screen.getByLabel("Two-line folder rows", { exact: true }).waitFor();

    await zerocode.open("/settings/general");
    const openFolder = screen.getByTestId("sidebar-project-folder");
    await expect(openFolder).toContainText("No project", { timeout: 60_000 });
    await screen.getByLabel("Language", { exact: true }).tap();
    await screen.getByText("Français", { exact: true }).tap();
    await screen.getByLabel("Langue", { exact: true }).waitFor();
    // Settings leaves the sidebar mounted. Keep this failure through the capture after reopening.
    await expect.soft(openFolder).toContainText("Aucun projet");

    await zerocode.open(thread);
    const folder = screen.getByTestId("sidebar-project-folder");
    await folder.getByText(/^(?:No project|Aucun projet)$/, { exact: true }).waitFor({
      timeout: 60_000,
    });
    await app.screenshot("scratch-folder-in-french");
    await expect(folder).toContainText("Aucun projet");
  },
);
