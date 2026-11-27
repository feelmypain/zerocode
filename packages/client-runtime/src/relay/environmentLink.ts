import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@zerocode/contracts";
import type {
  RelayEnvironmentLinkResponse,
  RelayManagedEndpointProviderKind,
} from "@zerocode/contracts/relay";
import * as Schema from "effect/Schema";

import type { PreparedConnection } from "../connection/model.ts";

// Linking can install the relay client and start a managed tunnel before it answers.
export const CLOUD_LINK_REQUEST_TIMEOUT_MS = 60_000;
export const CLOUD_LINK_MANAGED_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;
export const CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND =
  "manual" satisfies RelayManagedEndpointProviderKind;

const isEnvironmentCloudApiError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
    EnvironmentCloudEndpointUnavailableError,
  ]),
);

export function findEnvironmentCloudApiError(cause: unknown): { readonly message: string } | null {
  if (isEnvironmentCloudApiError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findEnvironmentCloudApiError(cause.cause) : null;
}

export function cloudLinkEndpointOrigin(httpBaseUrl: string): {
  readonly localHttpHost: "127.0.0.1";
  readonly localHttpPort: number;
} {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

export function preparedConnectionWsBaseUrl(
  prepared: Pick<PreparedConnection, "httpBaseUrl" | "target">,
): string {
  return prepared.target._tag === "PrimaryConnectionTarget"
    ? prepared.target.wsBaseUrl
    : prepared.httpBaseUrl.replace(/^http/, "ws");
}

export type LinkedEnvironmentMismatch = "environment_mismatch" | "provider_mismatch";

export function validateLinkedEnvironmentResponse(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponse;
}): LinkedEnvironmentMismatch | null {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return "environment_mismatch";
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return "provider_mismatch";
  }
  return null;
}

export function cloudLinkRelayConfigPayload(relayUrl: string, link: RelayEnvironmentLinkResponse) {
  return {
    relayUrl,
    relayIssuer: link.relayIssuer,
    cloudUserId: link.cloudUserId,
    environmentCredential: link.environmentCredential,
    cloudMintPublicKey: link.cloudMintPublicKey,
    endpointRuntime: link.endpointRuntime,
  };
}
