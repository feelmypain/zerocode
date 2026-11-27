import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const { isReadyMock, netFetchMock } = vi.hoisted(() => ({
  isReadyMock: vi.fn<() => boolean>(),
  netFetchMock: vi.fn<(input: string | Request, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("electron", () => ({
  app: { isReady: isReadyMock },
  net: { fetch: netFetchMock },
}));

import * as ElectronHttpClient from "./ElectronHttpClient.ts";

describe("ElectronHttpClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    isReadyMock.mockReset();
    netFetchMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.effect("uses Electron.net.fetch once the app is ready and normalizes URL inputs", () =>
    Effect.gen(function* () {
      isReadyMock.mockReturnValue(true);
      netFetchMock.mockResolvedValueOnce(new Response("via-net", { status: 200 }));

      const response = yield* HttpClient.get("http://127.0.0.1:3773/health");
      assert.equal(yield* response.text, "via-net");
      assert.equal(netFetchMock.mock.calls.length, 1);
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/health");
    }).pipe(Effect.provide(ElectronHttpClient.layer)),
  );

  it.effect("falls back to globalThis.fetch before Electron is ready", () =>
    Effect.gen(function* () {
      isReadyMock.mockReturnValue(false);
      const fallbackFetch = vi.fn(async () => new Response("via-global", { status: 200 }));
      globalThis.fetch = fallbackFetch as unknown as typeof globalThis.fetch;

      const response = yield* HttpClient.get("http://127.0.0.1:3773/health");
      assert.equal(yield* response.text, "via-global");
      assert.equal(netFetchMock.mock.calls.length, 0);
      assert.equal(fallbackFetch.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronHttpClient.layer)),
  );
});
