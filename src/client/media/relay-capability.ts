import {
  MAX_PEER_RELAY_DOWNSTREAM_EDGES,
  type ClientMessage,
} from "../../shared/protocol";

type RelayCapacityMessage = Extract<
  ClientMessage,
  { type: "relay-capacity" }
>;

export function relayCapacityMessageForBrowser(
  peerAssisted: boolean,
): RelayCapacityMessage | null {
  if (!peerAssisted) {
    return null;
  }
  return {
    type: "relay-capacity",
    downstreamEdges: MAX_PEER_RELAY_DOWNSTREAM_EDGES,
  };
}
