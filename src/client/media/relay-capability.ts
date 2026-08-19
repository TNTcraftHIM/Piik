import type { ClientMessage } from "../../shared/protocol";

export interface BrowserRelayEnvironment {
  userAgent: string;
  userAgentDataMobile?: boolean;
  maxTouchPoints: number;
}

type RelayCapacityMessage = Extract<
  ClientMessage,
  { type: "relay-capacity" }
>;

export function detectBrowserRelayCapacity(
  environment: BrowserRelayEnvironment,
): 0 | 1 {
  if (
    environment.userAgentDataMobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(environment.userAgent) ||
    (/Macintosh/i.test(environment.userAgent) &&
      environment.maxTouchPoints > 1)
  ) {
    return 0;
  }
  return 1;
}

export function relayCapacityMessageForBrowser(
  peerAssisted: boolean,
  environment?: BrowserRelayEnvironment,
): RelayCapacityMessage | null {
  if (!peerAssisted) {
    return null;
  }
  const browser = environment ?? currentBrowserEnvironment();
  return {
    type: "relay-capacity",
    downstreamEdges: detectBrowserRelayCapacity(browser),
  };
}

function currentBrowserEnvironment(): BrowserRelayEnvironment {
  const browserNavigator = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  return {
    userAgent: browserNavigator.userAgent,
    userAgentDataMobile: browserNavigator.userAgentData?.mobile,
    maxTouchPoints: browserNavigator.maxTouchPoints,
  };
}
