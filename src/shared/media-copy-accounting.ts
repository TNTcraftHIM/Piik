export const DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY = 2;
export const MAX_ENDPOINT_MEDIA_COPY_CAPACITY = 3;

export type EndpointMediaCopyPhase = "steady" | "transition";

export interface EndpointMediaCopySnapshot {
  childPeerIds: readonly string[];
  publicationGeneration?: string | null;
  selectedChildPeerIds?: Iterable<string>;
}

export function countEndpointMediaCopies(
  snapshot: EndpointMediaCopySnapshot,
): number {
  const childPeerIds = new Set(snapshot.childPeerIds);
  const hiddenSelectedChildPeerIds = new Set<string>();
  for (const childPeerId of snapshot.selectedChildPeerIds ?? []) {
    if (!childPeerIds.has(childPeerId)) {
      hiddenSelectedChildPeerIds.add(childPeerId);
    }
  }
  return (
    snapshot.childPeerIds.length +
    (snapshot.publicationGeneration ? 1 : 0) +
    hiddenSelectedChildPeerIds.size
  );
}

export function endpointMediaCopyLimit(
  capacity: number,
  phase: EndpointMediaCopyPhase,
): number {
  assertEndpointMediaCopyCapacity(capacity);
  return phase === "steady"
    ? capacity
    : Math.min(capacity + 1, MAX_ENDPOINT_MEDIA_COPY_CAPACITY);
}

export function endpointMediaCopyCountFits(
  count: number,
  capacity: number,
  phase: EndpointMediaCopyPhase = "steady",
): boolean {
  return (
    Number.isSafeInteger(count) &&
    count >= 0 &&
    isEndpointMediaCopyCapacity(capacity) &&
    count <= endpointMediaCopyLimit(capacity, phase)
  );
}

export function isEndpointMediaCopyCapacity(capacity: number): boolean {
  return (
    Number.isSafeInteger(capacity) &&
    capacity >= 1 &&
    capacity <= MAX_ENDPOINT_MEDIA_COPY_CAPACITY
  );
}

export function assertEndpointMediaCopyCapacity(capacity: number): void {
  if (!isEndpointMediaCopyCapacity(capacity)) {
    throw new Error("Endpoint media copy capacity must be 1, 2, or 3");
  }
}
