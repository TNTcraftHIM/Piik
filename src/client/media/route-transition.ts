import type {
  ClientMessage,
  MediaRoutePhase,
  ParticipantRouteAssignment,
} from "../../shared/protocol";

export interface RouteUpdateInput {
  revision: number;
  phase: MediaRoutePhase;
  assignment: ParticipantRouteAssignment;
}

export interface RouteOperationToken {
  revision: number;
  generation: number;
}

export type RouteUpdateResult = "accepted" | "duplicate" | "stale";

export class MediaRouteTransition {
  private revision = -1;
  private phase: MediaRoutePhase | null = null;
  private plannedAssignment: ParticipantRouteAssignment | null = null;
  private activeAssignment: ParticipantRouteAssignment | null = null;
  private mediaAssignment: ParticipantRouteAssignment | null = null;
  private generation = 0;

  accept(update: RouteUpdateInput): RouteUpdateResult {
    if (update.revision < this.revision) {
      return "stale";
    }
    if (update.revision === this.revision) {
      if (
        !this.plannedAssignment ||
        !sameAssignment(this.plannedAssignment, update.assignment) ||
        (this.phase === "active" && update.phase === "prepare")
      ) {
        return "stale";
      }
      if (this.phase === update.phase) {
        return "duplicate";
      }
    }

    this.revision = update.revision;
    this.phase = update.phase;
    this.plannedAssignment = cloneAssignment(update.assignment);
    if (update.phase === "active") {
      this.activeAssignment = cloneAssignment(update.assignment);
    }
    this.generation += 1;
    return "accepted";
  }

  acceptsConfig(revision: number): boolean {
    return revision === this.revision && this.phase !== null;
  }

  token(): RouteOperationToken | null {
    if (this.revision < 0 || this.phase === null) {
      return null;
    }
    return { revision: this.revision, generation: this.generation };
  }

  owns(token: RouteOperationToken, phase?: MediaRoutePhase): boolean {
    return (
      token.revision === this.revision &&
      token.generation === this.generation &&
      (phase === undefined || this.phase === phase)
    );
  }

  markMediaActive(token: RouteOperationToken): boolean {
    if (!this.owns(token, "active") || !this.activeAssignment) {
      return false;
    }
    this.mediaAssignment = cloneAssignment(this.activeAssignment);
    return true;
  }

  getRevision(): number | null {
    return this.revision < 0 ? null : this.revision;
  }

  getPhase(): MediaRoutePhase | null {
    return this.phase;
  }

  getPlannedAssignment(): ParticipantRouteAssignment | null {
    return this.plannedAssignment
      ? cloneAssignment(this.plannedAssignment)
      : null;
  }

  getActiveAssignment(): ParticipantRouteAssignment | null {
    return this.activeAssignment ? cloneAssignment(this.activeAssignment) : null;
  }

  getMediaAssignment(): ParticipantRouteAssignment | null {
    return this.mediaAssignment ? cloneAssignment(this.mediaAssignment) : null;
  }

  reset(): void {
    this.revision = -1;
    this.phase = null;
    this.plannedAssignment = null;
    this.activeAssignment = null;
    this.mediaAssignment = null;
    this.generation += 1;
  }
}

export function reportActivePeerRouteFailure(
  route: MediaRouteTransition,
  parentPeerId: string,
  connectionId: string,
  send: (message: ClientMessage) => boolean,
): boolean {
  const assignment = route.getActiveAssignment();
  const revision = route.getRevision();
  if (
    route.getPhase() !== "active" ||
    revision === null ||
    assignment?.upstream.kind !== "peer" ||
    assignment.upstream.peerId !== parentPeerId
  ) {
    return true;
  }
  return send({
    type: "route-failed",
    revision,
    phase: "active",
    connectionId,
  });
}

function sameAssignment(
  left: ParticipantRouteAssignment,
  right: ParticipantRouteAssignment,
): boolean {
  return (
    left.upstream.kind === right.upstream.kind &&
    (left.upstream.kind !== "peer" ||
      (right.upstream.kind === "peer" &&
        left.upstream.peerId === right.upstream.peerId)) &&
    left.sfuPublicationGeneration === right.sfuPublicationGeneration &&
    left.childPeerIds.length === right.childPeerIds.length &&
    left.childPeerIds.every((peerId, index) => peerId === right.childPeerIds[index])
  );
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
