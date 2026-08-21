import type {
  MediaAssignment,
  RelayDownstreamEdges,
} from "../shared/protocol.js";
import {
  CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT,
  CURRENT_HOST_MEDIA_EDGE_LIMIT,
  DEFAULT_PEER_RELAY_DOWNSTREAM_EDGES,
  MAX_PEER_RELAY_DOWNSTREAM_EDGES,
} from "../shared/protocol.js";

export interface MediaAssignmentChange {
  peerId: string;
  previousParentPeerId?: string | null;
  mediaAssignment: MediaAssignment;
}

export interface RelayCapacityUpdateOptions {
  rescueUnassignedRelay?: boolean;
}

export const MAX_PEER_RELAY_DEPTH = 4;

interface RelayViewer {
  order: number;
  parentPeerId: string | null;
  childPeerIds: string[];
  downstreamEdges: RelayDownstreamEdges;
  relayEligible: boolean;
}

interface RelayRoom {
  hostPeerId?: string;
  hostChildPeerIds: string[];
  maxHostDownstreamEdges: RelayDownstreamEdges;
  maxViewerDownstreamEdges: RelayDownstreamEdges;
  viewers: Map<string, RelayViewer>;
  nextOrder: number;
}

export class PeerRelayTopology {
  private readonly rooms = new Map<string, RelayRoom>();
  private readonly maxHostDownstreamEdges: RelayDownstreamEdges;
  private readonly maxViewerDownstreamEdges: RelayDownstreamEdges;

  constructor(
    deploymentDownstreamEdgeLimit: RelayDownstreamEdges =
      DEFAULT_PEER_RELAY_DOWNSTREAM_EDGES,
  ) {
    if (
      !Number.isSafeInteger(deploymentDownstreamEdgeLimit) ||
      deploymentDownstreamEdgeLimit < 1 ||
      deploymentDownstreamEdgeLimit > MAX_PEER_RELAY_DOWNSTREAM_EDGES
    ) {
      throw new Error("Peer relay downstream limit is invalid");
    }
    this.maxHostDownstreamEdges = Math.min(
      deploymentDownstreamEdgeLimit,
      CURRENT_HOST_MEDIA_EDGE_LIMIT,
    );
    this.maxViewerDownstreamEdges = Math.min(
      deploymentDownstreamEdgeLimit,
      CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT,
    );
  }

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
    const existingViewer = room.viewers.get(peerId);
    if (!existingViewer) {
      room.viewers.set(peerId, {
        order: room.nextOrder,
        parentPeerId: null,
        childPeerIds: [],
        downstreamEdges: 0,
        relayEligible: true,
      });
      room.nextOrder += 1;
    } else {
      existingViewer.downstreamEdges = 0;
    }
    for (const [candidatePeerId, viewer] of orderedViewers(room)) {
      if (viewer.parentPeerId === null) {
        this.assignViewer(room, candidatePeerId, connectedPeerIds);
      }
    }
    return changedAssignments(before, snapshot(room));
  }

  setViewerRelayCapacity(
    roomId: string,
    peerId: string,
    downstreamEdges: RelayDownstreamEdges,
    connectedPeerIds: ReadonlySet<string>,
    options: RelayCapacityUpdateOptions = {},
  ): MediaAssignmentChange[] {
    const room = this.rooms.get(roomId);
    const viewer = room?.viewers.get(peerId);
    if (!room || !viewer) {
      return [];
    }

    const before = snapshot(room);
    const boundedDownstreamEdges = Math.min(
      downstreamEdges,
      room.maxViewerDownstreamEdges,
    );
    const previousDownstreamEdges = viewer.downstreamEdges;
    viewer.downstreamEdges = boundedDownstreamEdges;
    for (const [candidatePeerId, candidate] of orderedViewers(room)) {
      if (candidate.parentPeerId === null) {
        this.assignViewer(room, candidatePeerId, connectedPeerIds);
      }
    }
    if (
      options.rescueUnassignedRelay &&
      previousDownstreamEdges === 0 &&
      boundedDownstreamEdges > 0
    ) {
      this.rescueUnassignedRelay(room, peerId, connectedPeerIds);
    }
    for (const [candidatePeerId, candidate] of orderedViewers(room)) {
      if (candidate.parentPeerId === null) {
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
    const subtreeRootPeerIds = [...removed.childPeerIds];
    for (const subtreeRootPeerId of subtreeRootPeerIds) {
      const subtreeRoot = room.viewers.get(subtreeRootPeerId);
      if (subtreeRoot) {
        subtreeRoot.parentPeerId = null;
      }
    }
    room.viewers.delete(peerId);

    for (const subtreeRootPeerId of subtreeRootPeerIds) {
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

  getAssignments(roomId: string): Map<string, MediaAssignment> {
    const room = this.rooms.get(roomId);
    return room ? snapshot(room) : new Map();
  }

  getDownstreamCapacity(
    roomId: string,
    peerId: string,
  ): RelayDownstreamEdges {
    const room = this.rooms.get(roomId);
    return room ? downstreamCapacity(room, peerId) : 0;
  }

  getAdvertisedDownstreamCapacity(
    roomId: string,
    peerId: string,
  ): RelayDownstreamEdges {
    const room = this.rooms.get(roomId);
    return room ? advertisedDownstreamCapacity(room, peerId) : 0;
  }

  setViewerRelayEligible(
    roomId: string,
    peerId: string,
    eligible: boolean,
  ): void {
    const viewer = this.rooms.get(roomId)?.viewers.get(peerId);
    if (viewer) {
      viewer.relayEligible = eligible;
    }
  }

  getHostPeerId(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.hostPeerId;
  }

  reassignViewer(
    roomId: string,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
    excludedParentPeerIds: ReadonlySet<string>,
    maxDepth = MAX_PEER_RELAY_DEPTH,
    requiredParentPeerId?: string,
  ): MediaAssignmentChange[] | undefined {
    const parentPeerId = this.findViewerReassignmentParent(
      roomId,
      peerId,
      connectedPeerIds,
      excludedParentPeerIds,
      maxDepth,
    );
    if (!parentPeerId || (requiredParentPeerId && parentPeerId !== requiredParentPeerId)) {
      return undefined;
    }

    const room = this.rooms.get(roomId);
    const viewer = room?.viewers.get(peerId);
    if (!room || !viewer) {
      return undefined;
    }

    const before = snapshot(room);
    this.detach(room, peerId, viewer.parentPeerId);
    viewer.parentPeerId = parentPeerId;
    const children = childPeerIds(room, parentPeerId);
    children.push(peerId);
    children.sort(
      (left, right) =>
        room.viewers.get(left)!.order - room.viewers.get(right)!.order,
    );
    return changedAssignments(before, snapshot(room));
  }

  findViewerReassignmentParent(
    roomId: string,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
    excludedParentPeerIds: ReadonlySet<string>,
    maxDepth = MAX_PEER_RELAY_DEPTH,
  ): string | undefined {
    const room = this.rooms.get(roomId);
    const viewer = room?.viewers.get(peerId);
    if (
      !room?.hostPeerId ||
      !viewer ||
      !connectedPeerIds.has(peerId) ||
      !Number.isSafeInteger(maxDepth) ||
      maxDepth < 1
    ) {
      return undefined;
    }

    const subtreePeerIds = collectSubtreePeerIds(room, peerId);
    const subtreeHeight = maximumSubtreeDepth(room, peerId);
    if (maximumDepthOutsideSubtree(room, subtreePeerIds) > maxDepth) {
      return undefined;
    }
    const parentPeerId = findReassignmentParent(
      room,
      connectedPeerIds,
      excludedParentPeerIds,
      subtreePeerIds,
      maxDepth - subtreeHeight - 1,
    );
    return parentPeerId === viewer.parentPeerId ? undefined : parentPeerId;
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
        maxHostDownstreamEdges: this.maxHostDownstreamEdges,
        maxViewerDownstreamEdges: this.maxViewerDownstreamEdges,
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
    const parentPeerId = findShallowestAvailableParent(
      room,
      connectedPeerIds,
      MAX_PEER_RELAY_DEPTH - maximumSubtreeDepth(room, peerId) - 1,
    );
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

  private rescueUnassignedRelay(
    room: RelayRoom,
    peerId: string,
    connectedPeerIds: ReadonlySet<string>,
  ): void {
    const hostPeerId = room.hostPeerId;
    const candidate = room.viewers.get(peerId);
    if (
      !hostPeerId ||
      !candidate ||
      !connectedPeerIds.has(hostPeerId) ||
      !connectedPeerIds.has(peerId) ||
      candidate.parentPeerId !== null ||
      candidate.childPeerIds.length !== 0 ||
      downstreamCapacity(room, peerId) === 0 ||
      room.hostChildPeerIds.length !== downstreamCapacity(room, hostPeerId)
    ) {
      return;
    }

    const leafPeerId = room.hostChildPeerIds.find((childPeerId) => {
      const child = room.viewers.get(childPeerId);
      return (
        connectedPeerIds.has(childPeerId) &&
        child?.parentPeerId === hostPeerId &&
        child.childPeerIds.length === 0 &&
        downstreamCapacity(room, childPeerId) === 0
      );
    });
    if (!leafPeerId) {
      return;
    }

    const leaf = room.viewers.get(leafPeerId)!;
    const leafIndex = room.hostChildPeerIds.indexOf(leafPeerId);
    room.hostChildPeerIds.splice(leafIndex, 1, peerId);
    room.hostChildPeerIds.sort(
      (left, right) =>
        room.viewers.get(left)!.order - room.viewers.get(right)!.order,
    );
    candidate.parentPeerId = hostPeerId;
    candidate.childPeerIds.push(leafPeerId);
    leaf.parentPeerId = peerId;
  }
}

function findShallowestAvailableParent(
  room: RelayRoom,
  connectedPeerIds: ReadonlySet<string>,
  maximumParentDepth: number,
): string | undefined {
  const hostPeerId = room.hostPeerId;
  if (!hostPeerId || !connectedPeerIds.has(hostPeerId)) {
    return undefined;
  }

  const queue: Array<{ peerId: string; depth: number }> = [
    { peerId: hostPeerId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { peerId, depth } = queue.shift()!;
    if (depth > maximumParentDepth || !connectedPeerIds.has(peerId)) {
      continue;
    }
    const children = childPeerIds(room, peerId);
    const capacity = downstreamCapacity(room, peerId);
    if (children.length < capacity) {
      return peerId;
    }
    for (const childPeerId of children) {
      queue.push({ peerId: childPeerId, depth: depth + 1 });
    }
  }
  return undefined;
}

function findReassignmentParent(
  room: RelayRoom,
  connectedPeerIds: ReadonlySet<string>,
  excludedParentPeerIds: ReadonlySet<string>,
  subtreePeerIds: ReadonlySet<string>,
  maximumParentDepth: number,
): string | undefined {
  const hostPeerId = room.hostPeerId;
  if (!hostPeerId || !connectedPeerIds.has(hostPeerId)) {
    return undefined;
  }

  const queue: Array<{ peerId: string; depth: number }> = [
    { peerId: hostPeerId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { peerId, depth } = queue.shift()!;
    if (depth > maximumParentDepth || !connectedPeerIds.has(peerId)) {
      continue;
    }
    const children = childPeerIds(room, peerId);
    const capacity = downstreamCapacity(room, peerId);
    if (
      children.length < capacity &&
      !excludedParentPeerIds.has(peerId) &&
      !subtreePeerIds.has(peerId)
    ) {
      return peerId;
    }
    for (const childPeerId of children) {
      queue.push({ peerId: childPeerId, depth: depth + 1 });
    }
  }
  return undefined;
}

function downstreamCapacity(
  room: RelayRoom,
  peerId: string,
): RelayDownstreamEdges {
  return room.hostPeerId === peerId || room.viewers.get(peerId)?.relayEligible
    ? advertisedDownstreamCapacity(room, peerId)
    : 0;
}

function advertisedDownstreamCapacity(
  room: RelayRoom,
  peerId: string,
): RelayDownstreamEdges {
  return room.hostPeerId === peerId
    ? room.maxHostDownstreamEdges
    : (room.viewers.get(peerId)?.downstreamEdges ?? 0);
}

function collectSubtreePeerIds(room: RelayRoom, rootPeerId: string): Set<string> {
  const peerIds = new Set<string>();
  const queue = [rootPeerId];
  while (queue.length > 0) {
    const peerId = queue.shift()!;
    if (peerIds.has(peerId)) {
      continue;
    }
    peerIds.add(peerId);
    queue.push(...(room.viewers.get(peerId)?.childPeerIds ?? []));
  }
  return peerIds;
}

function maximumSubtreeDepth(room: RelayRoom, rootPeerId: string): number {
  let maximumDepth = 0;
  const queue: Array<{ peerId: string; depth: number }> = [
    { peerId: rootPeerId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { peerId, depth } = queue.shift()!;
    maximumDepth = Math.max(maximumDepth, depth);
    for (const childPeerId of room.viewers.get(peerId)?.childPeerIds ?? []) {
      queue.push({ peerId: childPeerId, depth: depth + 1 });
    }
  }
  return maximumDepth;
}

function maximumDepthOutsideSubtree(
  room: RelayRoom,
  excludedPeerIds: ReadonlySet<string>,
): number {
  const hostPeerId = room.hostPeerId;
  if (!hostPeerId) {
    return 0;
  }
  let maximumDepth = 0;
  const queue: Array<{ peerId: string; depth: number }> = [
    { peerId: hostPeerId, depth: 0 },
  ];
  while (queue.length > 0) {
    const { peerId, depth } = queue.shift()!;
    maximumDepth = Math.max(maximumDepth, depth);
    for (const childPeerId of childPeerIds(room, peerId)) {
      if (!excludedPeerIds.has(childPeerId)) {
        queue.push({ peerId: childPeerId, depth: depth + 1 });
      }
    }
  }
  return maximumDepth;
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
