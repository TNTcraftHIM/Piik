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

export function relaySettingsLimit(requested: number | null, room: number, backend: number, customized: boolean) {
  const maximum = Math.min(backend, MAX_VIEWERS_PER_ROOM_LIMIT);
  return {
    capacity: Math.min(maximum, customized ? requested ?? room : room),
    minimum: 0,
    maximum,
    available: maximum > 0,
  };
}

// Match the source owner's one transition slot without authorizing another child.
export function relayPhysicalCapacity(capacity: number): number {
  return capacity > MAX_ENDPOINT_MEDIA_COPY_CAPACITY ? capacity + 1 : MAX_ENDPOINT_MEDIA_COPY_CAPACITY;
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
