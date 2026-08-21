import type {
  ClientMessage,
  MediaAssignment,
  SignalPayload,
} from "../../shared/protocol";
import {
  CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT,
  CURRENT_HOST_MEDIA_EDGE_LIMIT,
} from "../../shared/protocol";

export const MAX_HOST_MEDIA_CHILDREN = CURRENT_HOST_MEDIA_EDGE_LIMIT;
export const MAX_VIEWER_MEDIA_CHILDREN =
  CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT;

export function limitMediaAssignment(
  assignment: MediaAssignment,
  maxChildren: number,
): MediaAssignment {
  return {
    parentPeerId: assignment.parentPeerId,
    childPeerIds: [...new Set(assignment.childPeerIds)].slice(0, maxChildren),
  };
}

export function retainSelectedMediaParent(
  assignment: MediaAssignment,
  parentPeerId: string,
): MediaAssignment {
  return {
    parentPeerId,
    childPeerIds: assignment.childPeerIds,
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
  peerAssisted: boolean,
  targetPeerId: string,
  payload: SignalPayload,
): Extract<ClientMessage, { type: "signal" }> {
  return peerAssisted
    ? { type: "signal", targetPeerId, payload }
    : { type: "signal", payload };
}

export function viewerRestartMessage(
  peerAssisted: boolean,
  targetPeerId: string,
  connectionId: string,
  rebuild: boolean,
): Extract<ClientMessage, { type: "restart-request" }> {
  return peerAssisted
    ? {
        type: "restart-request",
        targetPeerId,
        connectionId,
        rebuild,
      }
    : { type: "restart-request", connectionId, rebuild };
}
