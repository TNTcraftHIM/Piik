import { MAX_ENDPOINT_MEDIA_COPY_CAPACITY } from "../../shared/media-copy-accounting";
import type { ClientMessage } from "../../shared/protocol";

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
    downstreamEdges: MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
  };
}
