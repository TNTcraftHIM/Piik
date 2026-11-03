import { MAX_VIEWERS_PER_ROOM_LIMIT } from "../../shared/protocol";

export function relayVolunteerLimit(requested: number | null, ordinary: number, backend: number) {
  const maximum = Math.min(backend, MAX_VIEWERS_PER_ROOM_LIMIT);
  return {
    capacity: Math.min(maximum, Math.max(ordinary + 1, requested ?? ordinary + 1)),
    minimum: Math.min(ordinary + 1, maximum),
    maximum,
    available: maximum > ordinary,
  };
}
