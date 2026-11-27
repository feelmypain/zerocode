import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentId,
  managedCapabilityDenial,
} from "@zerocode/contracts";

import { useManagedPolicy } from "../state/managedPolicy";
import { useEnvironmentCanConfigureRelay, useEnvironmentScope } from "../state/session";
import { useCloudLinkState } from "./cloudLinkState";
import { hasCloudPublicConfig } from "./publicConfig";
import { resolveZeroCodeConnectTurnOn } from "./zeroCodeConnectState";

/** Whether this client can turn on ZeroCode Connect for `environmentId`, and if not, why. */
export function useZeroCodeConnectTurnOn(environmentId: EnvironmentId | null) {
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const canConfigureRelay = useEnvironmentCanConfigureRelay(environmentId);
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  const linkState = useCloudLinkState(environmentId).data;
  return resolveZeroCodeConnectTurnOn({
    // Unknown while loading and on older servers, which keep today's switch in Settings.
    linkableHere: linkState?.linkableHere ?? true,
    cloudConfigured: hasCloudPublicConfig(),
    canReadRelay,
    canWriteRelay: canWriteRelay && canConfigureRelay,
    connectDenial,
  });
}
