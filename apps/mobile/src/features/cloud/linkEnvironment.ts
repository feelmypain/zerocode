import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import type { HttpClientResponse } from "effect/http";
import {
  RelayOkResponse,
  type RelayEnvironmentLinkResponse as RelayEnvironmentLinkResponseType,
  type RelayManagedEndpointProviderKind,
} from "@zerocode/contracts/relay";
import { EnvironmentSupervisor } from "@zerocode/client-runtime/connection";
import { findErrorTraceId } from "@zerocode/client-runtime/errors";
import { ManagedRelay, relayRequestFailureDetail } from "@zerocode/client-runtime/relay";
import {
  CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
  CLOUD_LINK_REQUEST_TIMEOUT_MS,
  cloudLinkEndpointOrigin,
  cloudLinkRelayConfigPayload,
  findEnvironmentCloudApiError,
  preparedConnectionWsBaseUrl,
  validateLinkedEnvironmentResponse,
} from "@zerocode/client-runtime/relay/environment-link";

import { executeConnectedEnvironmentHttpRequest } from "@zerocode/client-runtime/state/environmentHttpAuth";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import * as MobileStorage from "../../persistence/mobile-storage";
import { resolveCloudPublicConfig } from "./publicConfig";

function readRelayUrl(): string | null {
  return resolveCloudPublicConfig().relay.url;
}

export class CloudEnvironmentLinkError extends Schema.TaggedError<CloudEnvironmentLinkError>()(
  "CloudEnvironmentLinkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    traceId: Schema.optional(Schema.String),
    relayLinkCommitted: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

function cloudEnvironmentLinkError(
  message: string,
  withDetail: (detail: string) => string,
  options?: { readonly relayLinkCommitted: true },
) {
  return (cause: unknown) => {
    const environmentError = findEnvironmentCloudApiError(cause);
    const traceId = findErrorTraceId(cause);
    const detail = environmentError
      ? withDetail(environmentError.message)
      : withDevCause(message, cause);
    return new CloudEnvironmentLinkError({
      message: detail,
      cause,
      ...options,
      ...(traceId === null ? {} : { traceId }),
    });
  };
}

function isDevRuntime(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

function causeMessage(cause: unknown): string | null {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  if (typeof cause === "object" && cause !== null) {
    const record = cause as { readonly message?: unknown; readonly cause?: unknown };
    if (typeof record.message === "string" && record.message.length > 0) {
      const nested = causeMessage(record.cause);
      return nested ? `${record.message}: ${nested}` : record.message;
    }
  }
  return null;
}

function withDevCause(message: string, cause: unknown): string {
  if (!isDevRuntime()) {
    return message;
  }
  const detail = causeMessage(cause);
  return detail ? `${message} (${detail})` : message;
}

function decodedRelayClientError(url: string) {
  return (cause: ManagedRelay.ManagedRelayClientError) => {
    const failed = cause._tag === "ManagedRelayRequestFailedError" ? cause : undefined;
    const traceId = failed?.traceId;
    const detail = failed ? relayRequestFailureDetail(failed, m) : null;
    return new CloudEnvironmentLinkError({
      message: detail
        ? m(msg("{url} failed: {detail}", { url, detail }))
        : m(msg("{url} failed", { url })),
      cause,
      ...(traceId ? { traceId } : {}),
    });
  };
}

function requireRelayUrl(): Effect.Effect<string, CloudEnvironmentLinkError> {
  const relayUrl = readRelayUrl();
  return relayUrl
    ? Effect.succeed(relayUrl)
    : Effect.fail(
        new CloudEnvironmentLinkError({ message: m(msg("Relay URL is not configured.")) }),
      );
}

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  const mismatch = validateLinkedEnvironmentResponse(input);
  if (mismatch === "environment_mismatch") {
    return new CloudEnvironmentLinkError({
      message: m(msg("Relay returned credentials for a different environment.")),
    });
  }
  if (mismatch === "provider_mismatch") {
    return new CloudEnvironmentLinkError({
      message: m(msg("Relay returned credentials for a different endpoint provider.")),
    });
  }
  return Effect.void;
}

const decodeRelayOkResponse = Schema.decodeUnknownEffect(RelayOkResponse);

export const updateLinkedEnvironmentLiveActivityPreference = Effect.fn(
  "linkEnvironment.updateLinkedEnvironmentLiveActivityPreference",
)(function* (liveActivitiesEnabled: boolean) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  if (Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))) {
    return "disconnected" as const;
  }

  return yield* executeConnectedEnvironmentHttpRequest<
    "connect",
    HttpClientResponse.HttpClientResponse,
    unknown,
    never
  >({
    group: "connect",
    method: "POST",
    url: (urls) => urls.liveActivityPreference(),
    timeoutMs: 8_000,
    requestInit: { redirect: "error" },
    isUnauthorizedResponse: (response) => response.status === 401,
    request: ({ client, headers }) =>
      client.liveActivityPreference({
        headers,
        payload: { liveActivitiesEnabled },
        responseMode: "response-only",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status === 404) return "unsupported" as const;
        if (response.status === 200) {
          const json = yield* response.json;
          const result = yield* decodeRelayOkResponse(json);
          return result.ok ? ("updated" as const) : ("unlinked" as const);
        }
        return yield* new CloudEnvironmentLinkError({
          message: m(msg("Environment returned HTTP {status}."), { status: response.status }),
        });
      }),
    ),
    Effect.mapError(
      cloudEnvironmentLinkError(
        m(msg("Could not update the environment's Live Activity preference.")),
        (detail) =>
          m(msg("Could not update the environment's Live Activity preference: {detail}"), {
            detail,
          }),
      ),
    ),
  );
});

/** Links the supervised environment, signing its requests with this device's own credential. */
export const linkEnvironmentToCloudWithPreference = Effect.fn(
  "linkEnvironment.linkEnvironmentToCloudWithPreference",
)(function* (input: { readonly clerkToken: string; readonly liveActivitiesEnabled: boolean }) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new CloudEnvironmentLinkError({
      message: m(msg("The environment is not connected.")),
    });
  }
  const { environmentId, httpBaseUrl } = prepared.value;
  const wsBaseUrl = preparedConnectionWsBaseUrl(prepared.value);
  const relayUrl = yield* requireRelayUrl();
  // Publishing is a host-local setting, so enable it before committing a link a retry would skip.
  yield* executeConnectedEnvironmentHttpRequest({
    group: "connect",
    method: "POST",
    url: (urls) => urls.preferences(),
    timeoutMs: CLOUD_LINK_REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.preferences({ headers, payload: { publishAgentActivity: true } }),
  }).pipe(
    Effect.mapError(
      cloudEnvironmentLinkError(m(msg("Could not turn on agent activity publishing.")), (detail) =>
        m(msg("Could not turn on agent activity publishing: {detail}", { detail })),
      ),
    ),
  );
  const relayClient = yield* ManagedRelay.ManagedRelayClient;
  const storage = yield* MobileStorage.MobileStorage;
  const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
    Effect.mapError(
      cloudEnvironmentLinkError(m(msg("Could not load the mobile device id.")), (detail) =>
        m(msg("Could not load the mobile device id: {detail}", { detail })),
      ),
    ),
  );
  const liveActivitiesEnabled = input.liveActivitiesEnabled;
  const challenge = yield* relayClient
    .createEnvironmentLinkChallenge({
      clerkToken: input.clerkToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled,
        managedTunnelsEnabled: false,
      },
    })
    .pipe(
      Effect.mapError(
        decodedRelayClientError(`${relayUrl}/v1/client/environment-link-challenges failed`),
      ),
    );
  const proof = yield* executeConnectedEnvironmentHttpRequest({
    group: "connect",
    method: "POST",
    url: (urls) => urls.linkProof(),
    timeoutMs: CLOUD_LINK_REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.linkProof({
        headers,
        payload: {
          challenge: challenge.challenge,
          relayIssuer: relayUrl,
          // Live Activities need only agent activity, so a phone never starts a tunnel on the host.
          endpoint: { httpBaseUrl, wsBaseUrl, providerKind: CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND },
          origin: cloudLinkEndpointOrigin(httpBaseUrl),
        },
      }),
  }).pipe(
    Effect.mapError(
      cloudEnvironmentLinkError(m(msg("Could not obtain environment link proof.")), (detail) =>
        m(msg("Could not obtain environment link proof: {detail}", { detail })),
      ),
    ),
  );
  const link = yield* relayClient
    .linkEnvironment({
      clerkToken: input.clerkToken,
      payload: {
        deviceId,
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled,
        managedTunnelsEnabled: false,
      },
    })
    .pipe(
      Effect.mapError(decodedRelayClientError(`${relayUrl}/v1/client/environment-links failed`)),
    );
  yield* ensureLinkedEnvironmentMatches({
    expectedEnvironmentId: environmentId,
    expectedProviderKind: CLOUD_LINK_PUBLISH_ONLY_PROVIDER_KIND,
    link,
  });

  yield* executeConnectedEnvironmentHttpRequest({
    group: "connect",
    method: "POST",
    url: (urls) => urls.relayConfig(),
    timeoutMs: CLOUD_LINK_REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.relayConfig({
        headers,
        payload: cloudLinkRelayConfigPayload(relayUrl, link),
      }),
  }).pipe(
    Effect.mapError(
      cloudEnvironmentLinkError(
        m(msg("Could not configure environment relay access.")),
        (detail) => m(msg("Could not configure environment relay access: {detail}", { detail })),
        { relayLinkCommitted: true },
      ),
    ),
  );
});
