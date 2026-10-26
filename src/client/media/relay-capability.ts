import { MAX_ENDPOINT_MEDIA_COPY_CAPACITY } from "../../shared/media-copy-accounting";
import { MAX_VIEWERS_PER_ROOM_LIMIT, type ClientMessage } from "../../shared/protocol";

export function relayVolunteerLimit(requested: number | null, ordinary: number, backend: number) {
  const maximum = Math.min(backend, MAX_VIEWERS_PER_ROOM_LIMIT);
  return {
    capacity: Math.min(maximum, Math.max(ordinary + 1, requested ?? ordinary + 1)),
    minimum: Math.min(ordinary + 1, maximum),
    maximum,
    available: maximum > ordinary,
  };
}

type RelayCapacityMessage = Extract<
  ClientMessage,
  { type: "relay-capacity" }
>;

export function relayCapacityMessageForBrowser(
): RelayCapacityMessage {
  return {
    type: "relay-capacity",
    downstreamEdges: MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
  };
}
