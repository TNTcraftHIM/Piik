import {
  CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT,
  CURRENT_HOST_MEDIA_EDGE_LIMIT,
  CURRENT_SFU_ROOT_LIMIT,
  DEFAULT_PEER_RELAY_DOWNSTREAM_EDGES,
  MAX_MEDIA_ROUTE_REVISION,
  MAX_PEER_RELAY_DOWNSTREAM_EDGES,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  participantRouteAssignmentSchema,
  sfuPublicationGenerationSchema,
  type MediaRoutePhase,
  type ParticipantRouteAssignment,
} from "../shared/protocol.js";

const MAX_PARTICIPANTS_PER_ROOM = MAX_VIEWERS_PER_ROOM_LIMIT + 1;

export interface RoomSfuRoute {
  publicationGeneration: string | null;
  rootPeerIds: readonly string[];
}

export interface RoomMediaRoute {
  revision: number;
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>;
  sfu: RoomSfuRoute;
}

export interface PendingRoomMediaRoute {
  route: RoomMediaRoute;
  expectedParticipantIds: ReadonlySet<string>;
  readyParticipantIds: ReadonlySet<string>;
}

export interface MediaRouteControllerOptions {
  hostPeerId: string;
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>;
  revision?: number;
  sfuPublicationGeneration?: string | null;
  sfuRootPeerIds?: readonly string[];
  maxEndpointMediaEdges?: number;
}

export interface PrepareMediaRouteInput {
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>;
  expectedParticipantIds: ReadonlySet<string>;
  sfuPublicationGeneration?: string | null;
  sfuRootPeerIds?: readonly string[];
}

export interface ReconcileBaselineInput {
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>;
  sfuPublicationGeneration?: string | null;
  sfuRootPeerIds?: readonly string[];
}

interface StoredPendingRoute {
  route: RoomMediaRoute;
  expectedParticipantIds: Set<string>;
  readyParticipantIds: Set<string>;
}

export class MediaRouteController {
  private activeRoute: RoomMediaRoute;
  private pendingRoute: StoredPendingRoute | undefined;
  private latestRevision: number;
  private readonly hostPeerId: string;
  private readonly maxHostMediaEdges: number;
  private readonly maxViewerMediaEdges: number;

  constructor(options: MediaRouteControllerOptions) {
    this.hostPeerId = options.hostPeerId;
    const deploymentMediaEdgeLimit =
      options.maxEndpointMediaEdges ?? DEFAULT_PEER_RELAY_DOWNSTREAM_EDGES;
    if (
      !Number.isSafeInteger(deploymentMediaEdgeLimit) ||
      deploymentMediaEdgeLimit < 1 ||
      deploymentMediaEdgeLimit > MAX_PEER_RELAY_DOWNSTREAM_EDGES
    ) {
      throw new Error("Endpoint media edge budget is invalid");
    }
    this.maxHostMediaEdges = Math.min(
      deploymentMediaEdgeLimit,
      CURRENT_HOST_MEDIA_EDGE_LIMIT,
    );
    this.maxViewerMediaEdges = Math.min(
      deploymentMediaEdgeLimit,
      CURRENT_BROWSER_RELAY_DOWNSTREAM_EDGE_LIMIT,
    );
    const revision = options.revision ?? 0;
    assertRevision(revision);
    this.activeRoute = createRoute(
      revision,
      options.assignments,
      options.sfuPublicationGeneration ?? null,
      options.sfuRootPeerIds ?? [],
      this.hostPeerId,
      this.maxHostMediaEdges,
      this.maxViewerMediaEdges,
    );
    this.latestRevision = revision;
  }

  getActiveRoute(): RoomMediaRoute {
    return cloneRoute(this.activeRoute);
  }

  getPendingRoute(): PendingRoomMediaRoute | undefined {
    const pending = this.pendingRoute;
    return pending
      ? {
          route: cloneRoute(pending.route),
          expectedParticipantIds: new Set(pending.expectedParticipantIds),
          readyParticipantIds: new Set(pending.readyParticipantIds),
        }
      : undefined;
  }

  reconcileBaseline(input: ReconcileBaselineInput): number | undefined {
    if (this.pendingRoute) {
      return undefined;
    }

    const revision = this.nextRevision();
    const route = createRoute(
      revision,
      input.assignments,
      input.sfuPublicationGeneration === undefined
        ? this.activeRoute.sfu.publicationGeneration
        : input.sfuPublicationGeneration,
      input.sfuRootPeerIds ?? this.activeRoute.sfu.rootPeerIds,
      this.hostPeerId,
      this.maxHostMediaEdges,
      this.maxViewerMediaEdges,
    );
    if (hasSameTopology(route, this.activeRoute)) {
      return undefined;
    }

    this.activeRoute = route;
    this.latestRevision = revision;
    return revision;
  }

  prepare(input: PrepareMediaRouteInput): number | undefined {
    if (this.pendingRoute) {
      return undefined;
    }

    const revision = this.nextRevision();
    const route = createRoute(
      revision,
      input.assignments,
      input.sfuPublicationGeneration ?? null,
      input.sfuRootPeerIds ?? [],
      this.hostPeerId,
      this.maxHostMediaEdges,
      this.maxViewerMediaEdges,
    );
    const expectedParticipantIds = new Set(input.expectedParticipantIds);
    if (expectedParticipantIds.size > MAX_PARTICIPANTS_PER_ROOM) {
      throw new Error("Too many expected media route participants");
    }
    for (const peerId of expectedParticipantIds) {
      if (!route.assignments.has(peerId)) {
        throw new Error(`Expected participant ${peerId} has no route assignment`);
      }
    }

    this.latestRevision = revision;
    this.pendingRoute = {
      route,
      expectedParticipantIds,
      readyParticipantIds: new Set(),
    };
    return revision;
  }

  ready(peerId: string, revision: number, phase: MediaRoutePhase): boolean {
    const pending = this.pendingRoute;
    if (
      phase !== "prepare" ||
      !pending ||
      pending.route.revision !== revision ||
      !pending.expectedParticipantIds.has(peerId) ||
      pending.readyParticipantIds.has(peerId)
    ) {
      return false;
    }

    pending.readyParticipantIds.add(peerId);
    return true;
  }

  commit(revision: number): boolean {
    const pending = this.pendingRoute;
    if (!pending || pending.route.revision !== revision) {
      return false;
    }
    for (const peerId of pending.expectedParticipantIds) {
      if (!pending.readyParticipantIds.has(peerId)) {
        return false;
      }
    }

    this.activeRoute = pending.route;
    this.pendingRoute = undefined;
    return true;
  }

  abort(revision: number): boolean {
    const pending = this.pendingRoute;
    if (!pending || pending.route.revision !== revision) {
      return false;
    }

    const rollbackRevision = this.nextRevision();
    this.activeRoute = cloneRoute(this.activeRoute, rollbackRevision);
    this.latestRevision = rollbackRevision;
    this.pendingRoute = undefined;
    return true;
  }

  hostActiveMediaEdges(): number {
    const edgeCount = hostMediaEdges(this.activeRoute, this.hostPeerId);
    if (edgeCount > this.maxHostMediaEdges) {
      throw new Error("Host active media edge budget exceeded");
    }
    return edgeCount;
  }

  private nextRevision(): number {
    if (this.latestRevision >= MAX_MEDIA_ROUTE_REVISION) {
      throw new Error("Media route revision space exhausted");
    }
    return this.latestRevision + 1;
  }
}

function createRoute(
  revision: number,
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>,
  publicationGeneration: string | null,
  rootPeerIds: readonly string[],
  hostPeerId: string,
  maxHostMediaEdges: number,
  maxViewerMediaEdges: number,
): RoomMediaRoute {
  assertRevision(revision);
  if (
    assignments.size === 0 ||
    assignments.size > MAX_PARTICIPANTS_PER_ROOM
  ) {
    throw new Error("Media route participant count is outside room bounds");
  }
  if (publicationGeneration !== null) {
    sfuPublicationGenerationSchema.parse(publicationGeneration);
  }

  const clonedAssignments = new Map<string, ParticipantRouteAssignment>();
  for (const [peerId, assignment] of assignments) {
    const parsed = participantRouteAssignmentSchema.parse(assignment);
    clonedAssignments.set(peerId, cloneAssignment(parsed));
  }
  const route: RoomMediaRoute = {
    revision,
    assignments: clonedAssignments,
    sfu: {
      publicationGeneration,
      rootPeerIds: [...rootPeerIds],
    },
  };
  assertRouteInvariants(
    route,
    hostPeerId,
    maxHostMediaEdges,
    maxViewerMediaEdges,
  );
  return route;
}

function assertRouteInvariants(
  route: RoomMediaRoute,
  hostPeerId: string,
  maxHostMediaEdges: number,
  maxViewerMediaEdges: number,
): void {
  const hostAssignment = route.assignments.get(hostPeerId);
  if (!hostAssignment) {
    throw new Error("Media route is missing its host assignment");
  }
  if (hostAssignment.upstream.kind !== "none") {
    throw new Error("The host cannot have a media upstream");
  }
  if (
    hostAssignment.sfuPublicationGeneration !==
    route.sfu.publicationGeneration
  ) {
    throw new Error("Host and room SFU publication generations differ");
  }

  const rootPeerIds = new Set(route.sfu.rootPeerIds);
  if (
    rootPeerIds.size !== route.sfu.rootPeerIds.length ||
    rootPeerIds.size > CURRENT_SFU_ROOT_LIMIT
  ) {
    throw new Error("SFU root participants must be unique and bounded");
  }
  if (
    (route.sfu.publicationGeneration === null) !== (rootPeerIds.size === 0)
  ) {
    throw new Error("SFU roots and publication generation must be active together");
  }

  for (const [peerId, assignment] of route.assignments) {
    const downstreamEdgeLimit =
      peerId === hostPeerId ? maxHostMediaEdges : maxViewerMediaEdges;
    if (assignment.childPeerIds.length > downstreamEdgeLimit) {
      throw new Error("Participant active media edge budget exceeded");
    }
    if (
      peerId !== hostPeerId &&
      assignment.sfuPublicationGeneration !== null
    ) {
      throw new Error("Only the host may own an SFU publication generation");
    }
    if (assignment.childPeerIds.includes(peerId)) {
      throw new Error("A participant cannot be its own media child");
    }

    for (const childPeerId of assignment.childPeerIds) {
      const childAssignment = route.assignments.get(childPeerId);
      if (!childAssignment) {
        throw new Error(`Media child ${childPeerId} has no assignment`);
      }
      if (
        childAssignment.upstream.kind !== "peer" ||
        childAssignment.upstream.peerId !== peerId
      ) {
        throw new Error("Peer media edges must be reciprocal");
      }
    }

    if (assignment.upstream.kind === "peer") {
      const parentAssignment = route.assignments.get(
        assignment.upstream.peerId,
      );
      if (!parentAssignment?.childPeerIds.includes(peerId)) {
        throw new Error("Peer media edges must be reciprocal");
      }
    }
    if (assignment.upstream.kind === "sfu" && !rootPeerIds.has(peerId)) {
      throw new Error("Every SFU upstream must belong to the root allowlist");
    }
  }

  for (const rootPeerId of rootPeerIds) {
    const rootAssignment = route.assignments.get(rootPeerId);
    if (!rootAssignment || rootAssignment.upstream.kind !== "sfu") {
      throw new Error("Every SFU root must have the SFU as its upstream");
    }
  }

  assertAcyclicPeerEdges(route.assignments);
  if (hostMediaEdges(route, hostPeerId) > maxHostMediaEdges) {
    throw new Error("Host active media edge budget exceeded");
  }
}

function assertAcyclicPeerEdges(
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>,
): void {
  for (const startPeerId of assignments.keys()) {
    const ancestors = new Set([startPeerId]);
    let assignment = assignments.get(startPeerId);
    while (assignment?.upstream.kind === "peer") {
      const parentPeerId = assignment.upstream.peerId;
      if (ancestors.has(parentPeerId)) {
        throw new Error("Peer media route contains a cycle");
      }
      ancestors.add(parentPeerId);
      assignment = assignments.get(parentPeerId);
    }
  }
}

function hostMediaEdges(route: RoomMediaRoute, hostPeerId: string): number {
  const directChildren = route.assignments.get(hostPeerId)?.childPeerIds.length;
  if (directChildren === undefined) {
    throw new Error("Media route is missing its host assignment");
  }
  return directChildren + (route.sfu.publicationGeneration === null ? 0 : 1);
}

function hasSameTopology(left: RoomMediaRoute, right: RoomMediaRoute): boolean {
  if (
    left.sfu.publicationGeneration !== right.sfu.publicationGeneration ||
    left.sfu.rootPeerIds.length !== right.sfu.rootPeerIds.length ||
    left.sfu.rootPeerIds.some(
      (peerId, index) => peerId !== right.sfu.rootPeerIds[index],
    ) ||
    left.assignments.size !== right.assignments.size
  ) {
    return false;
  }

  for (const [peerId, leftAssignment] of left.assignments) {
    const rightAssignment = right.assignments.get(peerId);
    if (
      !rightAssignment ||
      leftAssignment.sfuPublicationGeneration !==
        rightAssignment.sfuPublicationGeneration ||
      leftAssignment.upstream.kind !== rightAssignment.upstream.kind ||
      (leftAssignment.upstream.kind === "peer" &&
        (rightAssignment.upstream.kind !== "peer" ||
          leftAssignment.upstream.peerId !==
            rightAssignment.upstream.peerId)) ||
      leftAssignment.childPeerIds.length !==
        rightAssignment.childPeerIds.length ||
      leftAssignment.childPeerIds.some(
        (childPeerId, index) =>
          childPeerId !== rightAssignment.childPeerIds[index],
      )
    ) {
      return false;
    }
  }
  return true;
}

function cloneRoute(
  route: RoomMediaRoute,
  revision = route.revision,
): RoomMediaRoute {
  return {
    revision,
    assignments: new Map(
      [...route.assignments].map(([peerId, assignment]) => [
        peerId,
        cloneAssignment(assignment),
      ]),
    ),
    sfu: {
      publicationGeneration: route.sfu.publicationGeneration,
      rootPeerIds: [...route.sfu.rootPeerIds],
    },
  };
}

function cloneAssignment(
  assignment: ParticipantRouteAssignment,
): ParticipantRouteAssignment {
  return {
    upstream:
      assignment.upstream.kind === "peer"
        ? { kind: "peer", peerId: assignment.upstream.peerId }
        : { kind: assignment.upstream.kind },
    childPeerIds: [...assignment.childPeerIds],
    sfuPublicationGeneration: assignment.sfuPublicationGeneration,
  };
}

function assertRevision(revision: number): void {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > MAX_MEDIA_ROUTE_REVISION
  ) {
    throw new Error("Media route revision is outside protocol bounds");
  }
}
