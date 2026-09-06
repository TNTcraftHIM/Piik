import type {
  ClientMessage,
  SignalPayload,
} from "../../shared/protocol";
import { MAX_ENDPOINT_MEDIA_COPY_CAPACITY } from "../../shared/media-copy-accounting";

export interface MediaAssignment {
  parentPeerId: string | null;
  childPeerIds: string[];
}

export const MAX_ENDPOINT_MEDIA_CHILDREN = MAX_ENDPOINT_MEDIA_COPY_CAPACITY;

export function limitMediaAssignment(
  assignment: MediaAssignment,
  maxChildren: number,
): MediaAssignment {
  return {
    parentPeerId: assignment.parentPeerId,
    childPeerIds: [...new Set(assignment.childPeerIds)].slice(0, maxChildren),
  };
}

export function reconcileBoundedMediaChildren(
  currentPeerIds: Iterable<string>,
  nextChildPeerIds: readonly string[],
  maxChildren: number,
  removeChild: (peerId: string) => void,
  startChild: (peerId: string) => void,
): void {
  const nextPeerIds = new Set(
    limitMediaAssignment(
      { parentPeerId: null, childPeerIds: [...nextChildPeerIds] },
      maxChildren,
    ).childPeerIds,
  );
  for (const peerId of currentPeerIds) {
    if (!nextPeerIds.has(peerId)) {
      removeChild(peerId);
    }
  }
  for (const peerId of nextPeerIds) {
    startChild(peerId);
  }
}

export function viewerSignalMessage(
  targetPeerId: string,
  payload: SignalPayload,
): Extract<ClientMessage, { type: "signal" }> {
  return { type: "signal", targetPeerId, payload };
}

export function viewerRestartMessage(
  targetPeerId: string,
  connectionId: string,
  rebuild: boolean,
): Extract<ClientMessage, { type: "restart-request" }> {
  return {
    type: "restart-request",
    targetPeerId,
    connectionId,
    rebuild,
  };
}

export function createOwnedViewerRestartSender(
  ownsActivePeer: (targetPeerId: string, connectionId: string) => boolean,
  send: (
    message: Extract<ClientMessage, { type: "restart-request" }>,
  ) => boolean,
): (
  targetPeerId: string,
  connectionId: string,
  rebuild: boolean,
) => boolean {
  return (targetPeerId, connectionId, rebuild) =>
    ownsActivePeer(targetPeerId, connectionId) &&
    send(
      viewerRestartMessage(
        targetPeerId,
        connectionId,
        rebuild,
      ),
    );
}
