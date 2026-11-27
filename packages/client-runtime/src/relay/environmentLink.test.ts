import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpForbiddenError,
  EnvironmentId,
} from "@zerocode/contracts";
import type { RelayEnvironmentLinkResponse } from "@zerocode/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import {
  CLOUD_LINK_MANAGED_PROVIDER_KIND,
  CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
  cloudLinkEndpointOrigin,
  cloudLinkRelayConfigPayload,
  findEnvironmentCloudApiError,
  preparedConnectionWsBaseUrl,
  validateLinkedEnvironmentResponse,
} from "./environmentLink.ts";

const sampleLink: RelayEnvironmentLinkResponse = {
  ok: true,
  environmentId: EnvironmentId.make("env-1"),
  endpoint: {
    httpBaseUrl: "https://desktop.example.test/",
    wsBaseUrl: "wss://desktop.example.test/ws",
    providerKind: CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
  },
  endpointRuntime: null,
  relayIssuer: "https://relay.example.test",
  cloudUserId: "user_1",
  environmentCredential: "cred_1",
  cloudMintPublicKey: "pk_1",
};

describe("environmentLink helpers", () => {
  it("finds nested environment cloud API errors along cause chains", () => {
    const forbidden = new EnvironmentHttpForbiddenError({ message: "No permission" });
    const unavailable = new EnvironmentCloudEndpointUnavailableError({
      message: "Unavailable",
      endpointRuntimeStatus: "starting",
    });
    expect(findEnvironmentCloudApiError(forbidden)).toBe(forbidden);
    expect(findEnvironmentCloudApiError({ cause: { cause: unavailable } })).toBe(unavailable);
    expect(findEnvironmentCloudApiError(new Error("plain error"))).toBeNull();
    expect(findEnvironmentCloudApiError(null)).toBeNull();
  });

  it("derives loopback endpoint origins and WebSocket base URLs", () => {
    expect(cloudLinkEndpointOrigin("http://127.0.0.1:3773")).toEqual({
      localHttpHost: "127.0.0.1",
      localHttpPort: 3773,
    });
    expect(cloudLinkEndpointOrigin("https://desktop.example.test/")).toEqual({
      localHttpHost: "127.0.0.1",
      localHttpPort: 443,
    });
    expect(cloudLinkEndpointOrigin("http://desktop.example.test/")).toEqual({
      localHttpHost: "127.0.0.1",
      localHttpPort: 80,
    });

    const primary = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("env-1"),
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3000",
      wsBaseUrl: "ws://127.0.0.1:3000/custom",
    });
    const bearer = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("env-2"),
      label: "Remote",
      connectionId: "conn-2",
    });
    expect(
      preparedConnectionWsBaseUrl({ httpBaseUrl: "http://127.0.0.1:3000", target: primary }),
    ).toBe("ws://127.0.0.1:3000/custom");
    expect(
      preparedConnectionWsBaseUrl({ httpBaseUrl: "https://host.example.test", target: bearer }),
    ).toBe("wss://host.example.test");
  });

  it("validates linked environment id and provider kind and builds relay config payloads", () => {
    expect(
      validateLinkedEnvironmentResponse({
        expectedEnvironmentId: "env-1",
        expectedProviderKind: CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
        link: sampleLink,
      }),
    ).toBeNull();
    expect(
      validateLinkedEnvironmentResponse({
        expectedEnvironmentId: "env-other",
        expectedProviderKind: CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
        link: sampleLink,
      }),
    ).toBe("environment_mismatch");
    expect(
      validateLinkedEnvironmentResponse({
        expectedEnvironmentId: "env-1",
        expectedProviderKind: CLOUD_LINK_MANAGED_PROVIDER_KIND,
        link: sampleLink,
      }),
    ).toBe("provider_mismatch");
    expect(cloudLinkRelayConfigPayload("https://relay.example.test", sampleLink)).toEqual({
      relayUrl: "https://relay.example.test",
      relayIssuer: "https://relay.example.test",
      cloudUserId: "user_1",
      environmentCredential: "cred_1",
      cloudMintPublicKey: "pk_1",
      endpointRuntime: null,
    });
  });
});
