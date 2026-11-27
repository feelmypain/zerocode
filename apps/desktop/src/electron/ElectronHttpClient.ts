import * as Electron from "electron";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

// Electron's net.fetch uses Chromium's network stack (OS proxies and certs) once app is ready,
// avoiding bundling undici into the desktop main process.
const electronFetch: typeof globalThis.fetch = (input, init) => {
  if (Electron.app?.isReady?.() && typeof Electron.net?.fetch === "function") {
    const requestInput = input instanceof URL ? input.href : input;
    return Electron.net.fetch(requestInput, init);
  }
  // @effect-diagnostics-next-line globalFetch:off -- fallback before Electron.app is ready or in unit tests
  return globalThis.fetch(input, init);
};

export const layer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, electronFetch)),
);
