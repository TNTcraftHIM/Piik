import type { MediaAssignment } from "../shared/protocol.js";

export interface MediaAssignmentChange {
  peerId: string;
  previousParentPeerId?: string | null;
  mediaAssignment: MediaAssignment;
}

interface RelayViewer {
  order: number;
  parentPeerId: string | null;
  childPeerIds: string[];
}

interface RelayRoom {
  hostPeerId?: string;
  hostChildPeerIds: string[];
  viewers: Map<string, RelayViewer>;
  nextOrder: number;
}

export class PeerRelayTopology {
  private readonly rooms = new Map<string, RelayRoom>();

  setHost(
    roomId: string,
    hostPeerId: string,
    connectedPeerIds: ReadonlySet<string>,
  ): MediaAssignmentChange[] {
    const room = this.room(roomId);
    const before = snapshot(room);
    const previousHostPeerId = room.hostPeerId;
    room.hostPeerId = hostPeerId;

    if (previousHostPeerId !== hostPeerId) {
      for (const childPeerId of room.hostChildPeerIds) {
        const child = room.viewers.get(childPeerId);
        if (child) {
          child.parentPeerId = hostPeerId;
        }
      }
    }

    for (const [peerId, viewer] of orderedViewers(room)) {
      if (viewer.parentPeerId === null) {
        this.assignViewer(room, peerId, connectedPeerIds);
      }
    }
    return changedAssignments(before, snapshot(room));
  }

  addViewer(
    roomId: string,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
  ): MediaAssignmentChange[] {
    const room = this.room(roomId);
    const before = snapshot(room);
    if (!room.viewers.has(peerId)) {
      room.viewers.set(peerId, {
        order: room.nextOrder,
        parentPeerId: null,
        childPeerIds: [],
      });
      room.nextOrder += 1;
    }
    for (const [candidatePeerId, viewer] of orderedViewers(room)) {
      if (viewer.parentPeerId === null) {
        this.assignViewer(room, candidatePeerId, connectedPeerIds);
      }
    }
    return changedAssignments(before, snapshot(room));
  }

  removeViewer(
    roomId: string,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
  ): MediaAssignmentChange[] {
    const room = this.rooms.get(roomId);
    const removed = room?.viewers.get(peerId);
    if (!room || !removed) {
      return [];
    }

    const before = snapshot(room);
    this.detach(room, peerId, removed.parentPeerId);
    const subtreeRootPeerId = removed.childPeerIds[0];
    if (subtreeRootPeerId) {
      const subtreeRoot = room.viewers.get(subtreeRootPeerId);
      if (subtreeRoot) {
        subtreeRoot.parentPeerId = null;
      }
    }
    room.viewers.delete(peerId);

    if (subtreeRootPeerId) {
      this.assignViewer(room, subtreeRootPeerId, connectedPeerIds);
    }
    for (const [candidatePeerId, viewer] of orderedViewers(room)) {
      if (viewer.parentPeerId === null) {
        this.assignViewer(room, candidatePeerId, connectedPeerIds);
      }
    }
    return changedAssignments(before, snapshot(room));
  }

  getAssignment(
    roomId: string,
    peerId: string,
  ): MediaAssignment | undefined {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }
    if (room.hostPeerId === peerId) {
      return {
        parentPeerId: null,
        childPeerIds: [...room.hostChildPeerIds],
      };
    }
    const viewer = room.viewers.get(peerId);
    return viewer
      ? {
          parentPeerId: viewer.parentPeerId,
          childPeerIds: [...viewer.childPeerIds],
        }
      : undefined;
  }

  isParentOf(roomId: string, parentPeerId: string, childPeerId: string): boolean {
    return (
      this.rooms.get(roomId)?.viewers.get(childPeerId)?.parentPeerId ===
      parentPeerId
    );
  }

  deleteRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  private room(roomId: string): RelayRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        hostChildPeerIds: [],
        viewers: new Map(),
        nextOrder: 0,
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private assignViewer(
    room: RelayRoom,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
  ): void {
    const viewer = room.viewers.get(peerId);
    if (
      !viewer ||
      viewer.parentPeerId !== null ||
      !connectedPeerIds.has(peerId)
    ) {
      return;
    }
    const parentPeerId = findShallowestAvailableParent(room, connectedPeerIds);
    if (!parentPeerId) {
      return;
    }
    viewer.parentPeerId = parentPeerId;
    const children = childPeerIds(room, parentPeerId);
    children.push(peerId);
    children.sort(
      (left, right) =>
        room.viewers.get(left)!.order - room.viewers.get(right)!.order,
    );
  }

  private detach(
    room: RelayRoom,
    peerId: string,
    parentPeerId: string | null,
  ): void {
    if (!parentPeerId) {
      return;
    }
    const children = childPeerIds(room, parentPeerId);
    const childIndex = children.indexOf(peerId);
    if (childIndex !== -1) {
      children.splice(childIndex, 1);
    }
  }
}

function findShallowestAvailableParent(
  room: RelayRoom,
  connectedPeerIds: ReadonlySet<string>,
): string | undefined {
  const hostPeerId = room.hostPeerId;
  if (!hostPeerId || !connectedPeerIds.has(hostPeerId)) {
    return undefined;
  }

  const queue = [hostPeerId];
  while (queue.length > 0) {
    const peerId = queue.shift()!;
    if (!connectedPeerIds.has(peerId)) {
      continue;
    }
    const children = childPeerIds(room, peerId);
    const capacity = peerId === hostPeerId ? 2 : 1;
    if (children.length < capacity) {
      return peerId;
    }
    queue.push(...children);
  }
  return undefined;
}

function childPeerIds(room: RelayRoom, peerId: string): string[] {
  if (room.hostPeerId === peerId) {
    return room.hostChildPeerIds;
  }
  const viewer = room.viewers.get(peerId);
  if (!viewer) {
    throw new Error("Peer relay topology references an unknown parent");
  }
  return viewer.childPeerIds;
}

function orderedViewers(room: RelayRoom): Array<[string, RelayViewer]> {
  return [...room.viewers.entries()].sort(
    ([, left], [, right]) => left.order - right.order,
  );
}

function snapshot(room: RelayRoom): Map<string, MediaAssignment> {
  const assignments = new Map<string, MediaAssignment>();
  if (room.hostPeerId) {
    assignments.set(room.hostPeerId, {
      parentPeerId: null,
      childPeerIds: [...room.hostChildPeerIds],
    });
  }
  for (const [peerId, viewer] of room.viewers) {
    assignments.set(peerId, {
      parentPeerId: viewer.parentPeerId,
      childPeerIds: [...viewer.childPeerIds],
    });
  }
  return assignments;
}

function changedAssignments(
  before: ReadonlyMap<string, MediaAssignment>,
  after: ReadonlyMap<string, MediaAssignment>,
): MediaAssignmentChange[] {
  const changes: MediaAssignmentChange[] = [];
  for (const [peerId, mediaAssignment] of after) {
    const previous = before.get(peerId);
    if (
      !previous ||
      previous.parentPeerId !== mediaAssignment.parentPeerId ||
      previous.childPeerIds.length !== mediaAssignment.childPeerIds.length ||
      previous.childPeerIds.some(
        (childPeerId, index) =>
          childPeerId !== mediaAssignment.childPeerIds[index],
      )
    ) {
      changes.push({
        peerId,
        previousParentPeerId: previous?.parentPeerId,
        mediaAssignment,
      });
    }
  }
  return changes;
}
