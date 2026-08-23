import {
  MAX_MEDIA_ROUTE_REVISION,
  type RouteDemandReason,
  type RouteDiagnosticFinalRoute,
  type RouteDiagnosticRejectionBucket,
  type RouteDiagnosticSnapshot,
} from "../shared/protocol.js";
import { assertEndpointMediaCopyCapacity } from "../shared/media-copy-accounting.js";

export type CandidateTuple =
  | { kind: "peer"; parentPeerId: string; transport: "direct" }
  | { kind: "sfu"; publication: "reuse" | "create" | "replace" };

export type CandidateReservation<Resource> =
  | { kind: "direct"; overlap?: Resource }
  | { kind: "sfu-reuse"; edge: Resource; overlap?: Resource }
  | { kind: "sfu-create"; edge: Resource; publication: Resource; overlap?: Resource };

export type EndpointRetirement =
  | {
    kind: "edge";
    childPeerId: string;
    childSessionId: string;
    parentPeerId: string;
    parentSessionId: string;
    transport: "direct";
    connectionId: string;
  }
  | {
    kind: "publication";
    hostSessionId: string;
    generation: string;
    connectionId: string;
  };

export type EndpointTransition =
  | { kind: "none"; producerPeerId?: string }
  | { kind: "overlap"; producerPeerId: string }
  | { kind: "bounded-gap"; producerPeerId: string; retire: EndpointRetirement };

export interface CandidatePlan {
  tuple: CandidateTuple;
  endpointTransition: EndpointTransition;
}

export type CommittedEdge<Resource> =
  | { kind: "peer"; childSessionId: string; parentPeerId: string; parentSessionId: string; transport: "direct"; connectionId: string; usable: boolean; physicalActive: boolean }
  | { kind: "sfu"; childSessionId: string; publicationGeneration: string; transport: "sfu"; connectionId: string; usable: boolean; physicalActive: boolean; resource: Resource };

export type CommittedEdgeSeed<Resource> =
  | Omit<Extract<CommittedEdge<Resource>, { transport: "direct" }>, "childSessionId" | "parentSessionId">
  | Omit<Extract<CommittedEdge<Resource>, { transport: "sfu" }>, "childSessionId">;

export interface ParticipantInput {
  peerId: string;
  role: "host" | "viewer";
  sessionId: string;
  effectiveDownstreamCapacity: number;
}

export interface EdgeGuard {
  childPeerId: string;
  childSessionId: string;
  routeRevision: number;
  connectionId: string;
  parentSessionId?: string;
}

export interface CandidateGuard {
  childPeerId: string;
  childSessionId: string;
  revision: number;
  connectionId: string;
}

export interface CandidateCursorGuard {
  childPeerId: string;
  childSessionId: string;
  baseRevision: number;
  factVersion: number;
  cursor: number;
  plan: CandidatePlan;
}

export interface ControllerOptions {
  hostPeerId: string;
  endpointMediaCopyCapacity: number;
  operationTimeoutMs: number;
  sfuEnabled?: boolean;
}

interface Participant {
  peerId: string;
  role: "host" | "viewer";
  sessionId: string | null;
  departureConfirmed: boolean;
  joinOrder: number;
  effectiveDownstreamCapacity: number;
  blockedAtFactVersion?: number;
  failedTuple?: { key: string; factVersion: number };
}

interface Attempt<Resource> {
  tuple: CandidateTuple;
  revision: number;
  connectionId: string;
  childSessionId: string;
  parentSessionId?: string;
  publicationGeneration?: string;
  publicationConnectionId?: string;
  reservation: CandidateReservation<Resource>;
}

interface ChildOperation<Resource> {
  childPeerId: string;
  childSessionId: string;
  reason: RouteDemandReason;
  baseRevision: number;
  candidates: CandidatePlan[];
  cursor: number;
  deadlineAtMs: number;
  builtAtFactVersion: number;
  current?: Attempt<Resource>;
}

export interface OperationSnapshot {
  childPeerId: string;
  childSessionId: string;
  reason: RouteDemandReason;
  baseRevision: number;
  factVersion: number;
  candidates: readonly CandidatePlan[];
  cursor: number;
  deadlineAtMs: number;
  wakeAtMs: number;
  current?: { tuple: CandidateTuple; revision: number; connectionId: string };
}

export interface RouteSnapshot<Resource> {
  revision: number;
  paused: boolean;
  factVersion: number;
  upstreamByViewer: ReadonlyMap<string, CommittedEdge<Resource>>;
  hostPublication: HostPublication<Resource> | null;
  operation?: OperationSnapshot;
}

export interface ReconcileResult<Resource> {
  operation?: OperationSnapshot;
  removedPeerIds: readonly string[];
  failedPeerIds: readonly string[];
  released: readonly Resource[];
}

export interface SettleResult<Resource> {
  accepted: boolean;
  exhausted?: boolean;
  activeRevision: number;
  released: readonly Resource[];
}

export interface BeginResult<Resource> {
  accepted: boolean;
  operation?: OperationSnapshot;
  exhausted?: boolean;
  released: readonly Resource[];
}

interface HostPublication<Resource> {
  generation: string;
  hostSessionId: string;
  connectionId: string;
  usable: boolean;
  physicalActive: boolean;
  resource: Resource;
}

interface RouteTimingRecord {
  demandAtMs: number;
  reason: RouteDemandReason;
  operationStartedAtMs?: number;
  candidateStartedAtMs?: number;
  firstDecodedFrameAtMs?: number;
  finalAtMs?: number;
  finalRoute: RouteDiagnosticFinalRoute;
  rejectionBucket: RouteDiagnosticRejectionBucket;
}

export class RoomRouteController<Resource = unknown> {
  private readonly participants = new Map<string, Participant>();
  private readonly upstreamByViewer = new Map<string, CommittedEdge<Resource>>();
  private hostPublication: HostPublication<Resource> | null = null;
  private operation?: ChildOperation<Resource>;
  private revision = 0;
  private latestRevision = 0;
  private factVersion = 0;
  private nextJoinOrder = 0;
  private paused = false;
  private readonly routeTimings = new Map<string, RouteTimingRecord>();

  constructor(private readonly options: ControllerOptions) {
    assertEndpointMediaCopyCapacity(options.endpointMediaCopyCapacity);
    if (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0) {
      throw new Error("Route operation timeout must be a positive integer");
    }
  }

  snapshot(): RouteSnapshot<Resource> {
    return {
      revision: this.revision,
      paused: this.paused,
      factVersion: this.factVersion,
      upstreamByViewer: new Map([...this.upstreamByViewer].map(([id, edge]) => [id, { ...edge }])),
      hostPublication: this.hostPublication ? { ...this.hostPublication } : null,
      operation: this.operationSnapshot(),
    };
  }

  routeDiagnosticSnapshot(nowMs: number): RouteDiagnosticSnapshot {
    const viewers = [...this.participants.values()]
      .filter(
        (participant) =>
          participant.role === "viewer" &&
          participant.sessionId !== null &&
          !participant.departureConfirmed,
      )
      .sort(compareParticipant);
    const ordinals = new Map(
      viewers.map((viewer, index) => [viewer.peerId, index + 1] as const),
    );
    const children: RouteDiagnosticSnapshot["children"] = viewers.map(
      (viewer) => {
        const ordinal = ordinals.get(viewer.peerId)!;
        const edge = this.upstreamByViewer.get(viewer.peerId);
        const record = this.routeTimings.get(viewer.peerId);
        const finalRoute = this.currentFinalRoute(viewer.peerId);
        return {
          ordinal,
          parent: this.diagnosticParent(edge, ordinals),
          effectiveCapacity: viewer.effectiveDownstreamCapacity,
          childCount: this.childrenOf(viewer.peerId).filter((childPeerId) => {
            const childEdge = this.upstreamByViewer.get(childPeerId);
            return childEdge?.kind === "peer" && childEdge.physicalActive;
          }).length,
          demandAgeMs: record
            ? elapsedMs(record.demandAtMs, nowMs)
            : null,
          queueWaitMs:
            record?.operationStartedAtMs === undefined
              ? null
              : elapsedMs(record.demandAtMs, record.operationStartedAtMs),
          candidateStartMs:
            record?.candidateStartedAtMs === undefined
              ? null
              : elapsedMs(record.demandAtMs, record.candidateStartedAtMs),
          firstDecodedFrameMs:
            record?.firstDecodedFrameAtMs === undefined
              ? null
              : elapsedMs(record.demandAtMs, record.firstDecodedFrameAtMs),
          finalMs:
            record?.finalAtMs === undefined
              ? null
              : elapsedMs(record.demandAtMs, record.finalAtMs),
          finalRoute:
            finalRoute === "waiting"
              ? record?.finalRoute === "failed"
                ? "failed"
                : "waiting"
              : finalRoute,
          rejectionBucket: record?.rejectionBucket ?? "none",
        };
      },
    );
    const operation = this.operation;
    const childOrdinal = operation
      ? ordinals.get(operation.childPeerId)
      : undefined;
    return {
      children,
      operation:
        operation && childOrdinal !== undefined
          ? {
              childOrdinal,
              reason: operation.reason,
              stage: operation.current ? "first-frame" : "admission",
              cursor: operation.cursor,
              candidateCount: operation.candidates.length,
            }
          : null,
    };
  }

  upsertParticipant(
    input: ParticipantInput,
    nowMs?: number,
  ): readonly Resource[] {
    if ((input.peerId === this.options.hostPeerId) !== (input.role === "host")) {
      throw new Error("Route Host identity is inconsistent");
    }
    const capacity = this.effectiveCapacity(input.effectiveDownstreamCapacity);
    const current = this.participants.get(input.peerId);
    if (current && current.role !== input.role) throw new Error("Route role cannot change");
    if (current) {
      let changed = false;
      const released: Resource[] = [];
      const previousSessionId = current.sessionId;
      if (previousSessionId !== input.sessionId) {
        const revisionBefore = this.revision;
        released.push(...this.abortOperation(nowMs, "stale"));
        current.sessionId = input.sessionId;
        const rebound = this.rebindCommittedSession(input.peerId, input.sessionId);
        released.push(...rebound.released);
        if (rebound.retired && this.revision === revisionBefore) {
          this.revision = this.allocateRevision();
        }
        changed = true;
      }
      if (current.departureConfirmed) {
        current.departureConfirmed = false;
        changed = true;
      }
      if (current.effectiveDownstreamCapacity !== capacity) {
        current.effectiveDownstreamCapacity = capacity;
        changed = true;
      }
      if (changed && current.blockedAtFactVersion !== undefined) {
        current.blockedAtFactVersion = undefined;
      }
      if (changed) this.touchFacts();
      if (
        input.role === "viewer" &&
        nowMs !== undefined &&
        !this.usableRoute(input.peerId)
      ) {
        this.recordDemand(input.peerId, nowMs, "join");
      }
      return released;
    } else {
      this.participants.set(input.peerId, {
        ...input,
        effectiveDownstreamCapacity: capacity,
        departureConfirmed: false,
        joinOrder: this.nextJoinOrder++,
      });
    }
    if (input.role === "viewer" && nowMs !== undefined) {
      this.recordDemand(input.peerId, nowMs, "join");
    }
    this.touchFacts();
    return [];
  }

  disconnectSession(peerId: string, sessionId: string): boolean {
    const participant = this.participants.get(peerId);
    if (!participant || participant.sessionId !== sessionId) return false;
    participant.sessionId = null;
    this.touchFacts();
    return true;
  }

  confirmDeparture(peerId: string, nowMs?: number): boolean {
    const participant = this.participants.get(peerId);
    if (!participant || participant.role === "host") return false;
    this.routeTimings.delete(peerId);
    if (participant.departureConfirmed && participant.sessionId === null &&
        participant.effectiveDownstreamCapacity === 0) return true;
    participant.sessionId = null;
    participant.departureConfirmed = true;
    participant.effectiveDownstreamCapacity = 0;
    if (nowMs !== undefined) {
      for (const childPeerId of this.childrenOf(peerId)) {
        this.recordDemand(childPeerId, nowMs, "parent-departed");
      }
    }
    this.touchFacts();
    return true;
  }

  setEffectiveCapacity(
    peerId: string,
    sessionId: string,
    value: number,
    nowMs?: number,
  ): boolean {
    const participant = this.participants.get(peerId);
    if (!participant || participant.sessionId !== sessionId) return false;
    const capacity = this.effectiveCapacity(value);
    const changed = participant.effectiveDownstreamCapacity !== capacity;
    if (!changed) return true;
    participant.effectiveDownstreamCapacity = capacity;
    participant.blockedAtFactVersion = undefined;
    if (nowMs !== undefined) {
      for (const childPeerId of this.overflowPeerChildren(peerId)) {
        this.recordDemand(childPeerId, nowMs, "capacity-reduction");
      }
    }
    this.touchFacts();
    return true;
  }

  touchExternalFacts(): void {
    this.touchFacts();
  }

  hydrateEdge(
    childPeerId: string,
    edge: CommittedEdgeSeed<Resource>,
  ): void {
    if (this.operation) throw new Error("Cannot hydrate while an operation is active");
    this.assertViewer(childPeerId);
    const childSessionId = this.participants.get(childPeerId)!.sessionId;
    if (!childSessionId) throw new Error("Route child has no current session");
    this.upstreamByViewer.set(childPeerId, edge.kind === "peer" ? {
      ...edge,
      childSessionId,
      parentSessionId:
        this.participants.get(edge.parentPeerId)?.sessionId ?? "",
    } : { ...edge, childSessionId });
    this.assertGraph();
  }

  hydrateHostPublication(
    generation: string,
    resource: Resource,
    connectionId = `publication:${generation}`,
  ): void {
    if (this.operation) throw new Error("Cannot hydrate while an operation is active");
    const hostSessionId = this.participants.get(this.options.hostPeerId)?.sessionId;
    if (!hostSessionId) throw new Error("Route Host has no current session");
    this.hostPublication = {
      generation,
      hostSessionId,
      connectionId,
      usable: true,
      physicalActive: true,
      resource,
    };
    this.assertGraph();
  }

  invalidateEdge(guard: EdgeGuard, nowMs?: number): boolean {
    const child = this.participants.get(guard.childPeerId);
    const edge = this.upstreamByViewer.get(guard.childPeerId);
    if (!child || child.sessionId !== guard.childSessionId || this.revision !== guard.routeRevision ||
        !edge || edge.connectionId !== guard.connectionId ||
        edge.childSessionId !== guard.childSessionId ||
        (edge.kind === "peer" && edge.parentSessionId !== guard.parentSessionId)) {
      return false;
    }
    if (edge.usable) {
      edge.usable = false;
      child.blockedAtFactVersion = undefined;
      this.touchFacts();
      child.failedTuple = {
        key: edgeTupleKey(edge),
        factVersion: this.factVersion,
      };
      if (nowMs !== undefined) {
        this.recordDemand(guard.childPeerId, nowMs, "edge-unavailable");
      }
    }
    return true;
  }

  invalidateHostPublication(guard: {
    hostSessionId: string;
    routeRevision: number;
    generation: string;
    connectionId: string;
  }, nowMs?: number): boolean {
    const publication = this.hostPublication;
    if (!publication || this.revision !== guard.routeRevision ||
        publication.hostSessionId !== guard.hostSessionId ||
        publication.generation !== guard.generation ||
        publication.connectionId !== guard.connectionId) return false;
    if (publication.usable) {
      publication.usable = false;
      if (nowMs !== undefined) {
        for (const [childPeerId, edge] of this.upstreamByViewer) {
          if (edge.kind === "sfu") {
            this.recordDemand(childPeerId, nowMs, "edge-unavailable");
          }
        }
      }
      this.touchFacts();
    }
    return true;
  }

  adoptDirectConnection(input: EdgeGuard & { newConnectionId: string }): boolean {
    const edge = this.upstreamByViewer.get(input.childPeerId);
    if (
      this.operation?.childPeerId === input.childPeerId ||
      this.revision !== input.routeRevision ||
      !edge ||
      edge.kind !== "peer" ||
      edge.transport !== "direct" ||
      !edge.usable ||
      !edge.physicalActive ||
      edge.childSessionId !== input.childSessionId ||
      edge.parentSessionId !== input.parentSessionId ||
      edge.connectionId !== input.connectionId ||
      !input.newConnectionId
    ) {
      return false;
    }
    if (input.newConnectionId === edge.connectionId) return true;
    edge.connectionId = input.newConnectionId;
    const child = this.participants.get(input.childPeerId);
    if (child) {
      child.blockedAtFactVersion = undefined;
      child.failedTuple = undefined;
    }
    this.touchFacts();
    return true;
  }

  retireCommittedTransport(guard: EdgeGuard): readonly Resource[] {
    const child = this.participants.get(guard.childPeerId);
    const edge = this.upstreamByViewer.get(guard.childPeerId);
    if (this.operation?.current || !child || child.sessionId !== guard.childSessionId || this.revision !== guard.routeRevision ||
        !edge || edge.connectionId !== guard.connectionId || !edge.physicalActive ||
        edge.childSessionId !== guard.childSessionId ||
        (edge.kind === "peer" && edge.parentSessionId !== guard.parentSessionId)) {
      return [];
    }
    edge.physicalActive = false;
    edge.usable = false;
    child.blockedAtFactVersion = undefined;
    this.revision = this.allocateRevision();
    if (this.operation) this.operation.baseRevision = this.revision;
    this.touchFacts();
    return edge.transport === "direct" ? [] : [edge.resource];
  }

  retireHostPublication(guard: {
    hostSessionId: string;
    routeRevision: number;
    generation: string;
    connectionId: string;
  }): readonly Resource[] {
    const publication = this.hostPublication;
    if (this.operation?.current || !publication || !publication.physicalActive ||
        this.revision !== guard.routeRevision ||
        publication.hostSessionId !== guard.hostSessionId ||
        publication.generation !== guard.generation ||
        publication.connectionId !== guard.connectionId) return [];
    publication.physicalActive = false;
    publication.usable = false;
    this.revision = this.allocateRevision();
    if (this.operation) this.operation.baseRevision = this.revision;
    this.touchFacts();
    return [publication.resource];
  }

  setPaused(paused: boolean, nowMs?: number): readonly Resource[] {
    if (this.paused === paused) return [];
    this.paused = paused;
    this.touchFacts();
    return paused ? this.abortOperation(nowMs, "aborted") : [];
  }

  reconcile(nowMs: number): ReconcileResult<Resource> {
    const released: Resource[] = [];
    const validation = this.validateOrAdvance(nowMs);
    released.push(...validation.released);
    const failedPeerIds = validation.exhaustedChildPeerId
      ? [validation.exhaustedChildPeerId]
      : [];
    if (this.paused || this.operation) {
      return {
        operation: this.operationSnapshot(),
        removedPeerIds: [],
        failedPeerIds,
        released,
      };
    }
    const removedPeerIds = this.pruneDepartedLeaves(released);

    for (let remaining = this.participants.size; remaining > 0; remaining -= 1) {
      const bootstrap = this.bootstrapForBlockedDemand();
      const childPeerId = bootstrap ?? this.selectNextChild();
      if (!childPeerId) return { removedPeerIds, failedPeerIds, released };
      const child = this.participants.get(childPeerId)!;
      const reason = bootstrap
        ? "sfu-bootstrap"
        : (this.routeTimings.get(childPeerId)?.reason ??
          this.routeDemandReason(childPeerId));
      this.ensureDemand(childPeerId, nowMs, reason);
      const candidates = this.buildCandidates(childPeerId, bootstrap !== undefined);
      if (candidates.length === 0) {
        if (this.retireInvalidOperationEdge(childPeerId, released)) {
          this.revision = this.allocateRevision();
          this.touchFacts();
        }
        child.blockedAtFactVersion = this.factVersion;
        this.finishTiming(
          childPeerId,
          nowMs,
          "failed",
          reason === "capacity-reduction"
            ? "endpoint-capacity"
            : "candidate-failed",
        );
        if (bootstrap === undefined) failedPeerIds.push(childPeerId);
        continue;
      }
      this.startOperationTiming(childPeerId, nowMs);
      this.operation = {
        childPeerId,
        childSessionId: child.sessionId!,
        reason,
        baseRevision: this.revision,
        candidates,
        cursor: 0,
        deadlineAtMs: nowMs + this.options.operationTimeoutMs,
        builtAtFactVersion: this.factVersion,
      };
      return {
        operation: this.operationSnapshot(),
        removedPeerIds,
        failedPeerIds,
        released,
      };
    }
    return { removedPeerIds, failedPeerIds, released };
  }

  beginCurrentCandidate(input: {
    guard: CandidateCursorGuard;
    nowMs: number;
    connectionId: string;
    reservation: CandidateReservation<Resource>;
    publicationGeneration?: string;
    publicationConnectionId?: string;
  }): BeginResult<Resource> {
    const validation = this.validateOrAdvance(input.nowMs);
    const operation = this.operation;
    if (!operation || operation.current || operation.baseRevision !== this.revision ||
        !this.cursorGuardMatches(input.guard, operation)) {
      return {
        accepted: false,
        released: [...validation.released, ...reservationResources(input.reservation)],
        exhausted: validation.exhausted,
      };
    }
    const plan = operation.candidates[operation.cursor];
    if (!plan || !this.candidateValid(operation.childPeerId, plan)) {
      return {
        accepted: false,
        released: [...validation.released, ...reservationResources(input.reservation)],
        exhausted: validation.exhausted,
      };
    }
    if (plan.endpointTransition.kind === "bounded-gap") {
      return {
        accepted: false,
        operation: this.operationSnapshot(),
        released: [...validation.released, ...reservationResources(input.reservation)],
      };
    }
    const tuple = plan.tuple;
    this.assertReservation(tuple, input.reservation, plan.endpointTransition.kind === "overlap");
    const publicationGeneration = tuple.kind === "sfu"
      ? tuple.publication === "reuse" ? this.hostPublication?.generation : input.publicationGeneration
      : undefined;
    if (tuple.kind === "sfu" && !publicationGeneration) throw new Error("SFU candidate needs a publication generation");
    if (tuple.kind === "sfu" && tuple.publication !== "reuse" && !input.publicationConnectionId) {
      throw new Error("SFU publication candidate needs an ingress connection identity");
    }
    operation.current = {
      tuple,
      revision: this.allocateRevision(),
      connectionId: input.connectionId,
      childSessionId: operation.childSessionId,
      parentSessionId: tuple.kind === "peer" ? this.participants.get(tuple.parentPeerId)?.sessionId ?? undefined : undefined,
      publicationGeneration,
      publicationConnectionId: input.publicationConnectionId,
      reservation: input.reservation,
    };
    this.startCandidateTiming(operation.childPeerId, input.nowMs);
    return { accepted: true, operation: this.operationSnapshot(), released: validation.released };
  }

  noteCurrentCandidateRejection(
    guard: CandidateCursorGuard,
    bucket: RouteDiagnosticRejectionBucket,
  ): boolean {
    const operation = this.operation;
    if (
      !operation ||
      operation.current ||
      !this.cursorGuardMatches(guard, operation)
    ) {
      return false;
    }
    this.noteRejection(operation.childPeerId, bucket);
    return true;
  }

  skipCurrentCandidate(
    guard: CandidateCursorGuard,
    nowMs: number,
    bucket: RouteDiagnosticRejectionBucket = "stale",
  ): BeginResult<Resource> {
    const validation = this.validateOrAdvance(nowMs);
    const operation = this.operation;
    if (!operation || operation.current || !this.cursorGuardMatches(guard, operation)) {
      return { accepted: false, released: validation.released, exhausted: validation.exhausted };
    }
    this.noteRejection(operation.childPeerId, bucket);
    operation.cursor += 1;
    this.clearCandidateTiming(operation.childPeerId);
    const advanced = this.validateOrAdvance(nowMs);
    return {
      operation: this.operationSnapshot(),
      accepted: true,
      released: [...validation.released, ...advanced.released],
      exhausted: advanced.exhausted,
    };
  }

  retireCurrentCandidateProducer(
    guard: CandidateCursorGuard,
    nowMs: number,
  ): BeginResult<Resource> {
    const validation = this.validateOrAdvance(nowMs);
    const operation = this.operation;
    if (!operation || operation.current || !this.cursorGuardMatches(guard, operation)) {
      return { accepted: false, released: validation.released, exhausted: validation.exhausted };
    }
    const plan = operation.candidates[operation.cursor];
    if (!plan || plan.endpointTransition.kind !== "bounded-gap") {
      return { accepted: false, operation: this.operationSnapshot(), released: validation.released };
    }
    const released = [...validation.released];
    const retirement = plan.endpointTransition.retire;
    let restoreTuple: CandidateTuple | undefined;
    if (retirement.kind === "edge") {
      const edge = this.upstreamByViewer.get(retirement.childPeerId);
      if (!edge || edge.kind !== "peer" || !edge.physicalActive ||
          edge.childSessionId !== retirement.childSessionId ||
          edge.parentPeerId !== retirement.parentPeerId ||
          edge.parentSessionId !== retirement.parentSessionId ||
          edge.transport !== retirement.transport ||
          edge.connectionId !== retirement.connectionId) {
        return { accepted: false, operation: this.operationSnapshot(), released };
      }
      if (edge.usable) {
        restoreTuple = {
          kind: "peer",
          parentPeerId: edge.parentPeerId,
          transport: edge.transport,
        };
      }
      this.upstreamByViewer.delete(retirement.childPeerId);
    } else {
      const publication = this.hostPublication;
      if (!publication || !publication.physicalActive ||
          publication.hostSessionId !== retirement.hostSessionId ||
          publication.generation !== retirement.generation ||
          publication.connectionId !== retirement.connectionId) {
        return { accepted: false, operation: this.operationSnapshot(), released };
      }
      released.push(...this.removePublicationGeneration(retirement.generation));
    }
    this.advanceActiveRevision(operation);
    this.touchFacts();
    const nextTuple = retirement.kind === "publication" && plan.tuple.kind === "sfu" &&
      plan.tuple.publication === "replace"
      ? { ...plan.tuple, publication: "create" as const }
      : plan.tuple;
    this.replanRemaining(operation, nextTuple, restoreTuple);
    if (operation.cursor >= operation.candidates.length) {
      const advanced = this.validateOrAdvance(nowMs);
      return {
        accepted: true,
        operation: this.operationSnapshot(),
        exhausted: advanced.exhausted,
        released: [...released, ...advanced.released],
      };
    }
    return { accepted: true, operation: this.operationSnapshot(), released };
  }

  candidateReady(
    guard: CandidateGuard,
    nowMs: number,
    commitReservation: (reservation: CandidateReservation<Resource>) => boolean = () => true,
  ): SettleResult<Resource> {
    const validation = this.validateOrAdvance(nowMs);
    const operation = this.operation;
    const attempt = operation?.current;
    if (!operation || !attempt || !this.guardMatches(guard, operation, attempt)) {
      return { accepted: false, exhausted: validation.exhausted, activeRevision: this.revision, released: validation.released };
    }
    if (!commitReservation(attempt.reservation)) {
      this.noteRejection(operation.childPeerId, "candidate-failed");
      const failed = this.validateOrAdvance(nowMs, guard);
      return {
        accepted: false,
        exhausted: failed.exhausted,
        activeRevision: this.revision,
        released: [...validation.released, ...failed.released],
      };
    }
    this.finishTiming(
      operation.childPeerId,
      nowMs,
      attempt.tuple.kind === "peer" ? "direct" : "sfu",
      "none",
      true,
    );
    const displacedSfuChildren =
      attempt.tuple.kind === "sfu" && attempt.tuple.publication === "replace"
        ? [...this.upstreamByViewer]
            .filter(
              ([childPeerId, edge]) =>
                childPeerId !== operation.childPeerId && edge.kind === "sfu",
            )
            .map(([childPeerId]) => childPeerId)
        : [];
    const released = [...validation.released, ...this.commitAttempt(operation, attempt)];
    for (const childPeerId of displacedSfuChildren) {
      this.ensureDemand(childPeerId, nowMs, "edge-unavailable");
    }
    return { accepted: true, activeRevision: this.revision, released };
  }

  candidateFailed(guard: CandidateGuard, nowMs: number): SettleResult<Resource> {
    const operation = this.operation;
    if (
      operation?.current &&
      this.guardMatches(guard, operation, operation.current)
    ) {
      this.noteRejection(operation.childPeerId, "candidate-failed");
    }
    const validation = this.validateOrAdvance(nowMs, guard);
    if (validation.consumedGuard) {
      return { accepted: true, exhausted: validation.exhausted, activeRevision: this.revision, released: validation.released };
    }
    return { accepted: false, exhausted: validation.exhausted, activeRevision: this.revision, released: validation.released };
  }

  operationExpired(nowMs: number): SettleResult<Resource> {
    const validation = this.validateOrAdvance(nowMs);
    return { accepted: validation.expired, exhausted: validation.exhausted, activeRevision: this.revision, released: validation.released };
  }

  dispose(): readonly Resource[] {
    const resources = new Set<Resource>();
    if (this.operation?.current) {
      for (const resource of reservationResources(this.operation.current.reservation)) {
        resources.add(resource);
      }
    }
    for (const resource of this.committedResources()) resources.add(resource);
    this.operation = undefined;
    this.upstreamByViewer.clear();
    this.hostPublication = null;
    this.participants.clear();
    this.routeTimings.clear();
    this.paused = true;
    return [...resources];
  }

  private validateOrAdvance(nowMs: number, failedGuard?: CandidateGuard): {
    released: Resource[];
    exhausted?: boolean;
    exhaustedChildPeerId?: string;
    expired: boolean;
    consumedGuard: boolean;
  } {
    const released: Resource[] = [];
    const result: {
      released: Resource[];
      exhausted?: boolean;
      exhaustedChildPeerId?: string;
      expired: boolean;
      consumedGuard: boolean;
    } = { released, expired: false, consumedGuard: false };
    let operation = this.operation;
    if (!operation) return result;
    if (nowMs >= operation.deadlineAtMs) {
      if (operation.current) released.push(...reservationResources(operation.current.reservation));
      if (operation.current) this.advanceActiveRevision(operation);
      const factsChanged = operation.builtAtFactVersion !== this.factVersion;
      this.finishTiming(
        operation.childPeerId,
        nowMs,
        factsChanged ? "waiting" : "failed",
        factsChanged ? "stale" : "operation-deadline",
      );
      this.blockAndClear(operation, !factsChanged, released);
      return {
        ...result,
        exhausted: !factsChanged,
        exhaustedChildPeerId: factsChanged
          ? undefined
          : operation.childPeerId,
        expired: true,
      };
    }
    if (this.advanceExpiredCandidateStage(operation, nowMs, released)) {
      result.expired = true;
    }
    if (this.participants.get(operation.childPeerId)?.sessionId !== operation.childSessionId) {
      if (operation.current) released.push(...reservationResources(operation.current.reservation));
      if (operation.current) this.advanceActiveRevision(operation);
      this.finishTiming(
        operation.childPeerId,
        nowMs,
        this.currentFinalRoute(operation.childPeerId),
        "aborted",
      );
      this.operation = undefined;
      return result;
    }

    while ((operation = this.operation)) {
      const attempt = operation.current;
      if (!attempt && operation.builtAtFactVersion !== this.factVersion) {
        this.replanRemaining(operation);
      }
      if (attempt) {
        const guardFailed = failedGuard && this.guardMatches(failedGuard, operation, attempt);
        const plan = operation.candidates[operation.cursor];
        if (!guardFailed && plan && this.candidateValid(operation.childPeerId, plan, attempt)) return result;
        if (!guardFailed) {
          this.noteRejection(operation.childPeerId, "stale");
        }
        released.push(...reservationResources(attempt.reservation));
        this.advanceActiveRevision(operation);
        operation.current = undefined;
        operation.cursor += 1;
        this.clearCandidateTiming(operation.childPeerId);
        result.consumedGuard = Boolean(guardFailed);
        this.replanRemaining(operation);
      }
      while (operation.cursor < operation.candidates.length &&
             !this.candidateValid(operation.childPeerId, operation.candidates[operation.cursor]!)) {
        this.noteRejection(operation.childPeerId, "stale");
        operation.cursor += 1;
        this.clearCandidateTiming(operation.childPeerId);
      }
      if (operation.cursor < operation.candidates.length) return result;
      const factsChanged = operation.builtAtFactVersion !== this.factVersion;
      this.finishTiming(
        operation.childPeerId,
        nowMs,
        factsChanged ? "waiting" : "failed",
        factsChanged
          ? "stale"
          : this.routeTimings.get(operation.childPeerId)?.rejectionBucket ===
              "none"
            ? "candidate-failed"
            : this.routeTimings.get(operation.childPeerId)!.rejectionBucket,
      );
      this.blockAndClear(operation, !factsChanged, released);
      result.exhausted = !factsChanged && !this.bootstrapForBlockedDemand();
      if (result.exhausted) {
        result.exhaustedChildPeerId = operation.childPeerId;
      }
    }
    return result;
  }

  private commitAttempt(operation: ChildOperation<Resource>, attempt: Attempt<Resource>): Resource[] {
    const beforeResources = new Set(this.committedResources());
    const old = this.upstreamByViewer.get(operation.childPeerId);

    if (attempt.tuple.kind === "sfu" && attempt.tuple.publication === "replace") {
      this.removePublicationGeneration(this.hostPublication!.generation);
    }

    if (attempt.tuple.kind === "peer") {
      const parentSessionId = this.participants.get(attempt.tuple.parentPeerId)?.sessionId;
      if (!parentSessionId) throw new Error("Candidate parent session is unavailable");
      this.upstreamByViewer.set(operation.childPeerId, {
        kind: "peer", childSessionId: operation.childSessionId,
        parentPeerId: attempt.tuple.parentPeerId, parentSessionId, transport: "direct",
        connectionId: attempt.connectionId, usable: true, physicalActive: true,
      });
    } else {
      const generation = attempt.publicationGeneration!;
      if (attempt.tuple.publication !== "reuse") {
        const reservation = attempt.reservation as Extract<CandidateReservation<Resource>, { kind: "sfu-create" }>;
        const hostSessionId = this.participants.get(this.options.hostPeerId)?.sessionId;
        if (!hostSessionId || !attempt.publicationConnectionId) {
          throw new Error("SFU publication identity is unavailable");
        }
        this.hostPublication = {
          generation,
          hostSessionId,
          connectionId: attempt.publicationConnectionId,
          usable: true,
          physicalActive: true,
          resource: reservation.publication,
        };
      }
      const edge = (attempt.reservation as Extract<CandidateReservation<Resource>, { kind: "sfu-reuse" | "sfu-create" }>).edge;
      this.upstreamByViewer.set(operation.childPeerId, {
        kind: "sfu", childSessionId: operation.childSessionId,
        publicationGeneration: generation, transport: "sfu",
        connectionId: attempt.connectionId, usable: true, physicalActive: true, resource: edge,
      });
    }
    this.revision = attempt.revision;
    this.operation = undefined;
    this.touchFacts();
    const participant = this.participants.get(operation.childPeerId);
    if (participant) {
      participant.blockedAtFactVersion = undefined;
      participant.failedTuple = undefined;
    }
    if (old?.kind === "sfu" && !this.hasSfuSubscribers() && this.hostPublication) {
      this.hostPublication = null;
    }
    this.assertGraph();
    const afterResources = new Set(this.committedResources());
    const released = [...beforeResources].filter((resource) => !afterResources.has(resource));
    if ("overlap" in attempt.reservation && attempt.reservation.overlap !== undefined) {
      released.push(attempt.reservation.overlap);
    }
    return released;
  }

  private buildCandidates(childPeerId: string, sfuOnly: boolean): CandidatePlan[] {
    const child = this.participants.get(childPeerId)!;
    const failedKey = child.failedTuple?.factVersion === this.factVersion
      ? child.failedTuple.key
      : undefined;
    const descendants = this.descendantsOf(childPeerId);
    const parents = [...this.participants.values()]
      .filter((parent) => parent.sessionId && !parent.departureConfirmed && parent.peerId !== childPeerId &&
        !descendants.has(parent.peerId) && this.sourceUsable(parent.peerId) && this.targetFits(parent.peerId, childPeerId))
      .sort((left, right) => this.depth(left.peerId) - this.depth(right.peerId) ||
        this.remaining(right.peerId, childPeerId) - this.remaining(left.peerId, childPeerId) ||
        compareParticipant(left, right));
    const candidates: CandidateTuple[] = [];
    if (!sfuOnly) {
      for (const parent of parents) candidates.push({ kind: "peer", parentPeerId: parent.peerId, transport: "direct" });
    }
    if (this.options.sfuEnabled) {
      if (this.hostPublication?.usable && this.hostPublication.physicalActive) {
        candidates.push({ kind: "sfu", publication: "reuse" });
      } else if (this.hostPublication || this.publicationFits(childPeerId, false)) {
        const publication = this.hostPublication ? "replace" : "create";
        candidates.push({ kind: "sfu", publication });
      }
    }
    return candidates.filter((candidate, index, all) => tupleKey(candidate) !== failedKey &&
      all.findIndex((other) => tupleKey(other) === tupleKey(candidate)) === index)
      .map((candidate) => this.planCandidate(childPeerId, candidate))
      .filter((candidate): candidate is CandidatePlan => candidate !== null &&
        this.candidateValid(childPeerId, candidate));
  }

  private selectNextChild(): string | undefined {
    const viewers = this.availableViewers();
    const departedParent = viewers.find(({ peerId }) => {
      const edge = this.upstreamByViewer.get(peerId);
      return edge?.kind === "peer" && this.participants.get(edge.parentPeerId)?.departureConfirmed;
    });
    if (departedParent) return departedParent.peerId;
    const overflow = this.overflowChildren();
    if (overflow.length > 0) return overflow[0];
    const unusable = viewers.find(({ peerId }) => this.upstreamByViewer.get(peerId)?.usable === false);
    const staleSfu = viewers.find(({ peerId }) => {
      const edge = this.upstreamByViewer.get(peerId);
      return edge?.kind === "sfu" && (!this.hostPublication?.usable ||
        this.hostPublication.generation !== edge.publicationGeneration);
    });
    return unusable?.peerId ?? staleSfu?.peerId ?? viewers.find(({ peerId }) => !this.upstreamByViewer.has(peerId))?.peerId;
  }

  private bootstrapForBlockedDemand(): string | undefined {
    if (!this.options.sfuEnabled || this.hostPublication || this.hostHasPublicationSlot()) return undefined;
    const demand = this.availableViewers(true).find((viewer) => viewer.blockedAtFactVersion === this.factVersion);
    if (!demand) return undefined;
    return this.childrenOf(this.options.hostPeerId)
      .filter((id) => {
        const participant = this.participants.get(id);
        const edge = this.upstreamByViewer.get(id);
        return participant?.sessionId && participant.blockedAtFactVersion !== this.factVersion &&
          edge?.kind === "peer" && edge.transport === "direct" && edge.usable && edge.physicalActive;
      })
      .sort((left, right) => compareParticipant(this.participants.get(right)!, this.participants.get(left)!))[0];
  }

  private availableViewers(includeBlocked = false): Participant[] {
    return [...this.participants.values()].filter((participant) => participant.role === "viewer" &&
      participant.sessionId && !participant.departureConfirmed &&
      (includeBlocked || participant.blockedAtFactVersion !== this.factVersion))
      .sort(compareParticipant);
  }

  private overflowChildren(): string[] {
    const result: string[] = [];
    for (const parent of this.participants.values()) {
      const overflow = this.overflowPeerChildren(parent.peerId).filter((id) => {
        const child = this.participants.get(id);
        return child?.sessionId && !child.departureConfirmed && child.blockedAtFactVersion !== this.factVersion;
      });
      result.push(...overflow.reverse());
    }
    return result;
  }

  private overflowPeerChildren(parentPeerId: string): string[] {
    const parent = this.participants.get(parentPeerId);
    if (!parent) return [];
    const publicationCopies = parent.role === "host" && this.hostPublication?.physicalActive ? 1 : 0;
    const capacity = Math.max(0, parent.effectiveDownstreamCapacity - publicationCopies);
    return this.childrenOf(parentPeerId)
      .filter((id) => {
        const edge = this.upstreamByViewer.get(id);
        return edge?.kind === "peer" && edge.physicalActive;
      })
      .sort((left, right) => compareParticipant(this.participants.get(left)!, this.participants.get(right)!))
      .slice(capacity);
  }

  private candidateValid(childPeerId: string, plan: CandidatePlan, attempt?: Attempt<Resource>): boolean {
    const tuple = plan.tuple;
    const child = this.participants.get(childPeerId);
    if (!child?.sessionId || child.departureConfirmed || (attempt && attempt.childSessionId !== child.sessionId)) return false;
    if (tuple.kind === "peer") {
      const parent = this.participants.get(tuple.parentPeerId);
      if (!parent?.sessionId || parent.departureConfirmed || (attempt && parent.sessionId !== attempt.parentSessionId) ||
          this.descendantsOf(childPeerId).has(parent.peerId) || !this.sourceUsable(parent.peerId) ||
          !this.targetFits(parent.peerId, childPeerId)) return false;
    } else {
      if (!this.options.sfuEnabled) return false;
      if (tuple.publication === "reuse") {
        if (!this.hostPublication?.usable || !this.hostPublication.physicalActive ||
            (attempt && attempt.publicationGeneration !== this.hostPublication.generation)) return false;
      } else if (tuple.publication === "replace") {
        if (!this.hostPublication || this.hostPublication.usable || !this.publicationFits(childPeerId, true)) return false;
      } else if (this.hostPublication || !this.publicationFits(childPeerId, false)) {
        return false;
      }
    }
    const currentPlan = this.planCandidate(childPeerId, tuple);
    return Boolean(currentPlan && endpointTransitionEquals(currentPlan.endpointTransition, plan.endpointTransition));
  }

  private planCandidate(childPeerId: string, tuple: CandidateTuple): CandidatePlan | null {
    if (tuple.kind === "sfu" && tuple.publication === "reuse") {
      return { tuple, endpointTransition: { kind: "none" } };
    }
    const producerPeerId = tuple.kind === "peer" ? tuple.parentPeerId : this.options.hostPeerId;
    const producer = this.participants.get(producerPeerId);
    if (!producer?.sessionId || producer.departureConfirmed) return null;
    const copies = this.physicalCopies(producerPeerId);
    if (copies + 1 <= producer.effectiveDownstreamCapacity) {
      return { tuple, endpointTransition: { kind: "none", producerPeerId } };
    }
    if (copies + 1 <= Math.min(this.options.endpointMediaCopyCapacity + 1, 3)) {
      return { tuple, endpointTransition: { kind: "overlap", producerPeerId } };
    }
    const retire = this.retirementFor(childPeerId, producerPeerId, tuple);
    if (!retire || copies > producer.effectiveDownstreamCapacity) return null;
    return { tuple, endpointTransition: { kind: "bounded-gap", producerPeerId, retire } };
  }

  private retirementFor(
    childPeerId: string,
    producerPeerId: string,
    tuple: CandidateTuple,
  ): EndpointRetirement | null {
    const old = this.upstreamByViewer.get(childPeerId);
    if (old?.kind === "peer" && old.parentPeerId === producerPeerId && old.physicalActive) {
      return {
        kind: "edge",
        childPeerId,
        childSessionId: old.childSessionId,
        parentPeerId: old.parentPeerId,
        parentSessionId: old.parentSessionId,
        transport: old.transport,
        connectionId: old.connectionId,
      };
    }
    if (producerPeerId !== this.options.hostPeerId || !this.hostPublication?.physicalActive) return null;
    const replacesPublication = tuple.kind === "sfu" && tuple.publication === "replace";
    const releasesLastPublication = tuple.kind === "peer" && old?.kind === "sfu" && old.physicalActive &&
      this.sfuSubscriberCount() === 1;
    if (!replacesPublication && !releasesLastPublication) return null;
    return {
      kind: "publication",
      hostSessionId: this.hostPublication.hostSessionId,
      generation: this.hostPublication.generation,
      connectionId: this.hostPublication.connectionId,
    };
  }

  private physicalCopies(peerId: string): number {
    let copies = [...this.upstreamByViewer.values()].filter((edge) =>
      edge.kind === "peer" && edge.parentPeerId === peerId && edge.physicalActive).length;
    if (peerId === this.options.hostPeerId && this.hostPublication?.physicalActive) copies += 1;
    return copies;
  }

  private assertReservation(tuple: CandidateTuple, reservation: CandidateReservation<Resource>, overlap: boolean): void {
    const expected = tuple.kind === "peer" ? "direct" :
      tuple.publication === "reuse" ? "sfu-reuse" : "sfu-create";
    if (reservation.kind !== expected) throw new Error("Candidate reservation kind does not match tuple");
    if (overlap && !("overlap" in reservation && reservation.overlap !== undefined)) {
      throw new Error("Candidate requires an endpoint overlap reservation");
    }
  }

  private pruneDepartedLeaves(released: Resource[]): string[] {
    const removed: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const participant of this.participants.values()) {
        if (participant.role !== "viewer" || !participant.departureConfirmed || this.childrenOf(participant.peerId).length > 0) continue;
        const edge = this.upstreamByViewer.get(participant.peerId);
        if (edge && edge.transport !== "direct" && edge.physicalActive) released.push(edge.resource);
        this.upstreamByViewer.delete(participant.peerId);
        this.participants.delete(participant.peerId);
        this.routeTimings.delete(participant.peerId);
        removed.push(participant.peerId);
        changed = true;
      }
    }
    if (removed.length > 0) {
      if (!this.hasSfuSubscribers() && this.hostPublication) {
        if (this.hostPublication.physicalActive) released.push(this.hostPublication.resource);
        this.hostPublication = null;
      }
      this.revision = this.allocateRevision();
      this.touchFacts();
    }
    return removed;
  }

  private abortOperation(
    nowMs?: number,
    bucket: RouteDiagnosticRejectionBucket = "aborted",
  ): Resource[] {
    if (!this.operation) return [];
    if (nowMs !== undefined) {
      this.finishTiming(
        this.operation.childPeerId,
        nowMs,
        this.currentFinalRoute(this.operation.childPeerId),
        bucket,
      );
    }
    const released = this.operation.current ? reservationResources(this.operation.current.reservation) : [];
    if (this.operation.current) this.advanceActiveRevision(this.operation);
    this.operation = undefined;
    return released;
  }

  private advanceActiveRevision(operation: ChildOperation<Resource>): void {
    this.revision = this.allocateRevision();
    operation.baseRevision = this.revision;
  }

  private blockAndClear(
    operation: ChildOperation<Resource>,
    block = true,
    released: Resource[] = [],
  ): void {
    const child = this.participants.get(operation.childPeerId);
    this.operation = undefined;
    if (!block || !child) return;
    if (this.retireInvalidOperationEdge(operation.childPeerId, released)) {
      this.revision = this.allocateRevision();
      this.touchFacts();
    }
    child.blockedAtFactVersion = this.factVersion;
  }

  private retireInvalidOperationEdge(childPeerId: string, released: Resource[]): boolean {
    const edge = this.upstreamByViewer.get(childPeerId);
    if (!edge || !this.edgeRequiresMove(childPeerId, edge)) return false;
    if (edge.kind === "sfu" && edge.physicalActive) released.push(edge.resource);
    edge.physicalActive = false;
    edge.usable = false;
    if (edge.kind === "sfu" && !this.hasSfuSubscribers() && this.hostPublication) {
      if (this.hostPublication.physicalActive) released.push(this.hostPublication.resource);
      this.hostPublication.physicalActive = false;
      this.hostPublication.usable = false;
    }
    return true;
  }

  private edgeRequiresMove(childPeerId: string, edge: CommittedEdge<Resource>): boolean {
    if (!edge.usable || !edge.physicalActive) return true;
    if (edge.kind === "sfu") {
      return !this.hostPublication?.usable ||
        !this.hostPublication.physicalActive ||
        this.hostPublication.generation !== edge.publicationGeneration;
    }
    if (this.participants.get(edge.parentPeerId)?.departureConfirmed) return true;
    return this.overflowPeerChildren(edge.parentPeerId).includes(childPeerId);
  }

  private replanRemaining(
    operation: ChildOperation<Resource>,
    firstTuple?: CandidateTuple,
    restoreTuple?: CandidateTuple,
  ): void {
    const prefix = operation.candidates.slice(0, operation.cursor);
    const tuples = operation.candidates
      .slice(operation.cursor)
      .map((candidate) => candidate.tuple);
    if (firstTuple) {
      if (tuples.length === 0) tuples.push(firstTuple);
      else tuples[0] = firstTuple;
    }
    if (restoreTuple && !tuples.some((tuple) => tupleKey(tuple) === tupleKey(restoreTuple))) {
      tuples.push(restoreTuple);
    }
    const replanned = tuples
      .map((tuple) => this.planCandidate(operation.childPeerId, tuple))
      .filter((plan): plan is CandidatePlan => plan !== null);
    operation.candidates = [...prefix, ...replanned];
    operation.builtAtFactVersion = this.factVersion;
  }

  private operationSnapshot(): OperationSnapshot | undefined {
    const operation = this.operation;
    if (!operation) return undefined;
    return { childPeerId: operation.childPeerId, childSessionId: operation.childSessionId,
      reason: operation.reason,
      baseRevision: operation.baseRevision, factVersion: operation.builtAtFactVersion,
      candidates: operation.candidates.map(cloneCandidatePlan),
      cursor: operation.cursor, deadlineAtMs: operation.deadlineAtMs,
      wakeAtMs: this.operationWakeAt(operation),
      current: operation.current ? { tuple: { ...operation.current.tuple }, revision: operation.current.revision,
        connectionId: operation.current.connectionId } : undefined };
  }

  private advanceExpiredCandidateStage(
    operation: ChildOperation<Resource>,
    nowMs: number,
    released: Resource[],
  ): boolean {
    const plan = operation.current
      ? { tuple: operation.current.tuple }
      : operation.candidates[operation.cursor];
    if (!plan) {
      return false;
    }
    const stage = candidateStage(plan.tuple);
    const stageDeadlineAtMs = this.stageDeadlineAt(operation, stage);
    if (
      stageDeadlineAtMs >= operation.deadlineAtMs ||
      nowMs < stageDeadlineAtMs
    ) {
      return false;
    }
    if (operation.current) {
      this.noteRejection(operation.childPeerId, "first-frame-timeout");
      released.push(...reservationResources(operation.current.reservation));
      this.advanceActiveRevision(operation);
      operation.current = undefined;
      operation.cursor += 1;
      this.clearCandidateTiming(operation.childPeerId);
    }
    while (
      operation.cursor < operation.candidates.length &&
      candidateStage(operation.candidates[operation.cursor]!.tuple) === stage
    ) {
      operation.cursor += 1;
    }
    return true;
  }

  private operationWakeAt(operation: ChildOperation<Resource>): number {
    const tuple =
      operation.current?.tuple ?? operation.candidates[operation.cursor]?.tuple;
    return tuple
      ? this.stageDeadlineAt(operation, candidateStage(tuple))
      : operation.deadlineAtMs;
  }

  private stageDeadlineAt(
    operation: ChildOperation<Resource>,
    stage: CandidateStage,
  ): number {
    const stages = this.operationStages(operation);
    const index = stages.indexOf(stage);
    if (index === -1 || index === stages.length - 1) {
      return operation.deadlineAtMs;
    }
    const startedAtMs =
      operation.deadlineAtMs - this.options.operationTimeoutMs;
    return (
      startedAtMs +
      Math.floor(
        (this.options.operationTimeoutMs * (index + 1)) / stages.length,
      )
    );
  }

  private operationStages(
    operation: ChildOperation<Resource>,
  ): CandidateStage[] {
    const stages = candidateStages(operation.candidates);
    if (
      !stages.includes("sfu") &&
      this.bootstrapCandidateAvailable()
    ) {
      stages.push("sfu");
    }
    return stages;
  }

  private bootstrapCandidateAvailable(): boolean {
    if (
      !this.options.sfuEnabled ||
      this.hostPublication ||
      this.hostHasPublicationSlot()
    ) {
      return false;
    }
    return this.childrenOf(this.options.hostPeerId).some((id) => {
      const participant = this.participants.get(id);
      const edge = this.upstreamByViewer.get(id);
      return Boolean(
        participant?.sessionId &&
          edge?.kind === "peer" &&
          edge.transport === "direct" &&
          edge.usable &&
          edge.physicalActive,
      );
    });
  }

  private guardMatches(guard: CandidateGuard, operation: ChildOperation<Resource>, attempt: Attempt<Resource>): boolean {
    return guard.childPeerId === operation.childPeerId && guard.childSessionId === operation.childSessionId &&
      guard.revision === attempt.revision && guard.connectionId === attempt.connectionId;
  }

  private cursorGuardMatches(guard: CandidateCursorGuard, operation: ChildOperation<Resource>): boolean {
    const plan = operation.candidates[operation.cursor];
    return Boolean(plan && guard.childPeerId === operation.childPeerId &&
      guard.childSessionId === operation.childSessionId && guard.baseRevision === operation.baseRevision &&
      guard.factVersion === operation.builtAtFactVersion && guard.cursor === operation.cursor &&
      candidatePlanEquals(guard.plan, plan));
  }

  private childrenOf(parentPeerId: string): string[] {
    return [...this.upstreamByViewer].filter(([, edge]) => edge.kind === "peer" && edge.parentPeerId === parentPeerId).map(([id]) => id);
  }

  private descendantsOf(peerId: string): Set<string> {
    const descendants = new Set<string>();
    const queue = [peerId];
    while (queue.length) for (const child of this.childrenOf(queue.pop()!)) if (!descendants.has(child)) {
      descendants.add(child); queue.push(child);
    }
    return descendants;
  }

  private sourceUsable(peerId: string): boolean {
    if (peerId === this.options.hostPeerId) return true;
    const seen = new Set<string>();
    while (!seen.has(peerId)) {
      seen.add(peerId);
      const edge = this.upstreamByViewer.get(peerId);
      if (!edge?.usable || !edge.physicalActive) return false;
      if (edge.kind === "sfu") return Boolean(this.hostPublication?.usable &&
        this.hostPublication.physicalActive && this.hostPublication.generation === edge.publicationGeneration);
      if (edge.parentPeerId === this.options.hostPeerId) return true;
      peerId = edge.parentPeerId;
    }
    return false;
  }

  private targetFits(parentPeerId: string, childPeerId: string): boolean {
    const parent = this.participants.get(parentPeerId)!;
    const edge = this.upstreamByViewer.get(childPeerId);
    const already = edge?.kind === "peer" && edge.parentPeerId === parentPeerId && edge.physicalActive;
    const releasesLastPublication = parent.role === "host" && edge?.kind === "sfu" && edge.physicalActive &&
      this.sfuSubscriberCount() === 1;
    return this.usedSlots(parentPeerId) - (releasesLastPublication ? 1 : 0) +
      (already ? 0 : 1) <= parent.effectiveDownstreamCapacity;
  }

  private publicationFits(childPeerId: string, replacing: boolean): boolean {
    const host = this.participants.get(this.options.hostPeerId);
    const edge = this.upstreamByViewer.get(childPeerId);
    const releasesHost = edge?.kind === "peer" && edge.parentPeerId === this.options.hostPeerId && edge.physicalActive;
    const replacesPhysicalPublication = replacing && Boolean(this.hostPublication?.physicalActive);
    const nextSlots = this.usedSlots(this.options.hostPeerId) - (releasesHost ? 1 : 0) +
      (replacesPhysicalPublication ? 0 : 1);
    return Boolean(host?.sessionId && !host.departureConfirmed && nextSlots <= host.effectiveDownstreamCapacity);
  }

  private hostHasPublicationSlot(): boolean {
    const host = this.participants.get(this.options.hostPeerId);
    return Boolean(host && this.usedSlots(this.options.hostPeerId) + 1 <= host.effectiveDownstreamCapacity);
  }

  private usedSlots(peerId: string): number {
    return this.physicalCopies(peerId);
  }

  private remaining(parentPeerId: string, childPeerId: string): number {
    const parent = this.participants.get(parentPeerId)!;
    const edge = this.upstreamByViewer.get(childPeerId);
    const already = edge?.kind === "peer" && edge.parentPeerId === parentPeerId && edge.physicalActive;
    return parent.effectiveDownstreamCapacity - this.usedSlots(parentPeerId) - (already ? 0 : 1);
  }

  private depth(peerId: string): number {
    if (peerId === this.options.hostPeerId) return 1;
    let depth = 1;
    const seen = new Set<string>();
    while (!seen.has(peerId)) {
      seen.add(peerId);
      const edge = this.upstreamByViewer.get(peerId);
      if (!edge || edge.kind === "sfu") return depth + 1;
      depth += 1;
      if (edge.parentPeerId === this.options.hostPeerId) return depth;
      peerId = edge.parentPeerId;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private hasSfuSubscribers(): boolean {
    return [...this.upstreamByViewer.values()].some((edge) => edge.kind === "sfu" && edge.physicalActive);
  }

  private sfuSubscriberCount(): number {
    return [...this.upstreamByViewer.values()].filter((edge) => edge.kind === "sfu" && edge.physicalActive).length;
  }

  private committedResources(): Resource[] {
    const resources: Resource[] = [];
    for (const edge of this.upstreamByViewer.values()) {
      if (edge.kind === "sfu" && edge.physicalActive) resources.push(edge.resource);
    }
    if (this.hostPublication?.physicalActive) resources.push(this.hostPublication.resource);
    return resources;
  }

  private diagnosticParent(
    edge: CommittedEdge<Resource> | undefined,
    ordinals: ReadonlyMap<string, number>,
  ): RouteDiagnosticSnapshot["children"][number]["parent"] {
    if (!edge || !edge.usable || !edge.physicalActive) {
      return { kind: "none" };
    }
    if (edge.kind === "sfu") {
      return this.hostPublication?.usable &&
        this.hostPublication.physicalActive &&
        this.hostPublication.generation === edge.publicationGeneration
        ? { kind: "sfu" }
        : { kind: "none" };
    }
    if (edge.parentPeerId === this.options.hostPeerId) {
      return { kind: "host" };
    }
    const ordinal = ordinals.get(edge.parentPeerId);
    return ordinal === undefined
      ? { kind: "none" }
      : { kind: "viewer", ordinal };
  }

  private recordDemand(
    childPeerId: string,
    nowMs: number,
    reason: RouteDemandReason,
  ): void {
    const record: RouteTimingRecord = {
      demandAtMs: nowMs,
      reason,
      finalRoute: "waiting",
      rejectionBucket: "none",
    };
    if (this.operation?.childPeerId === childPeerId) {
      this.operation.reason = reason;
      record.operationStartedAtMs = nowMs;
    }
    this.routeTimings.set(childPeerId, record);
  }

  private ensureDemand(
    childPeerId: string,
    nowMs: number,
    reason: RouteDemandReason,
  ): void {
    if (!this.routeTimings.has(childPeerId)) {
      this.recordDemand(childPeerId, nowMs, reason);
    }
  }

  private startOperationTiming(childPeerId: string, nowMs: number): void {
    const record = this.routeTimings.get(childPeerId);
    if (!record) return;
    record.operationStartedAtMs = nowMs;
    record.candidateStartedAtMs = undefined;
    record.firstDecodedFrameAtMs = undefined;
    record.finalAtMs = undefined;
    record.finalRoute = "waiting";
    record.rejectionBucket = "none";
  }

  private startCandidateTiming(childPeerId: string, nowMs: number): void {
    const record = this.routeTimings.get(childPeerId);
    if (!record) return;
    record.candidateStartedAtMs = nowMs;
    record.firstDecodedFrameAtMs = undefined;
    record.finalAtMs = undefined;
    record.finalRoute = "waiting";
    record.rejectionBucket = "none";
  }

  private noteRejection(
    childPeerId: string,
    bucket: RouteDiagnosticRejectionBucket,
  ): void {
    const record = this.routeTimings.get(childPeerId);
    if (record) record.rejectionBucket = bucket;
  }

  private clearCandidateTiming(childPeerId: string): void {
    const record = this.routeTimings.get(childPeerId);
    if (!record) return;
    record.candidateStartedAtMs = undefined;
    record.firstDecodedFrameAtMs = undefined;
    record.finalAtMs = undefined;
    record.finalRoute = "waiting";
  }

  private finishTiming(
    childPeerId: string,
    nowMs: number,
    finalRoute: RouteDiagnosticFinalRoute,
    rejectionBucket: RouteDiagnosticRejectionBucket,
    firstDecodedFrame = false,
  ): void {
    const record = this.routeTimings.get(childPeerId);
    if (!record) return;
    if (firstDecodedFrame) record.firstDecodedFrameAtMs = nowMs;
    record.finalAtMs = nowMs;
    record.finalRoute = finalRoute;
    record.rejectionBucket = rejectionBucket;
  }

  private usableRoute(childPeerId: string): boolean {
    return this.currentFinalRoute(childPeerId) !== "waiting";
  }

  private currentFinalRoute(
    childPeerId: string,
  ): RouteDiagnosticFinalRoute {
    const edge = this.upstreamByViewer.get(childPeerId);
    if (!edge?.usable || !edge.physicalActive) return "waiting";
    if (edge.kind === "peer") {
      return this.sourceUsable(edge.parentPeerId) ? "direct" : "waiting";
    }
    return this.hostPublication?.usable &&
      this.hostPublication.physicalActive &&
      this.hostPublication.generation === edge.publicationGeneration
      ? "sfu"
      : "waiting";
  }

  private routeDemandReason(childPeerId: string): RouteDemandReason {
    const edge = this.upstreamByViewer.get(childPeerId);
    if (!edge) return "join";
    if (
      edge.kind === "peer" &&
      this.participants.get(edge.parentPeerId)?.departureConfirmed
    ) {
      return "parent-departed";
    }
    if (
      edge.kind === "peer" &&
      this.overflowPeerChildren(edge.parentPeerId).includes(childPeerId)
    ) {
      return "capacity-reduction";
    }
    return "edge-unavailable";
  }

  private rebindCommittedSession(
    peerId: string,
    sessionId: string,
  ): { released: Resource[]; retired: boolean } {
    const released = new Set<Resource>();
    const ownEdge = this.upstreamByViewer.get(peerId);
    if (ownEdge) {
      ownEdge.childSessionId = sessionId;
    }
    for (const edge of this.upstreamByViewer.values()) {
      if (edge.kind !== "peer" || edge.parentPeerId !== peerId) continue;
      edge.parentSessionId = sessionId;
    }
    if (peerId === this.options.hostPeerId && this.hostPublication) {
      this.hostPublication.hostSessionId = sessionId;
    }
    return { released: [...released], retired: false };
  }

  private removePublicationGeneration(generation: string): Resource[] {
    const released: Resource[] = [];
    for (const [viewerPeerId, edge] of this.upstreamByViewer) {
      if (edge.kind !== "sfu" || edge.publicationGeneration !== generation) continue;
      if (edge.physicalActive) released.push(edge.resource);
      this.upstreamByViewer.delete(viewerPeerId);
    }
    if (this.hostPublication?.generation === generation) {
      if (this.hostPublication.physicalActive) released.push(this.hostPublication.resource);
      this.hostPublication = null;
    }
    return released;
  }

  private assertGraph(): void {
    const host = this.participants.get(this.options.hostPeerId);
    if (!host || host.role !== "host") throw new Error("Route Host is missing");
    for (const [child, edge] of this.upstreamByViewer) {
      this.assertViewer(child);
      if (edge.kind === "peer" && !this.participants.has(edge.parentPeerId)) throw new Error("Route parent is missing");
      if (edge.kind === "sfu" && this.hostPublication?.generation !== edge.publicationGeneration) throw new Error("SFU publication is stale");
      const seen = new Set<string>();
      let current = child;
      while (current !== this.options.hostPeerId) {
        if (seen.has(current)) throw new Error("Peer route contains a cycle");
        seen.add(current);
        const currentEdge = this.upstreamByViewer.get(current);
        if (!currentEdge) throw new Error("Route is not source-reachable");
        if (currentEdge.kind === "sfu") break;
        current = currentEdge.parentPeerId;
      }
    }
    for (const participant of this.participants.values()) if (this.usedSlots(participant.peerId) > this.options.endpointMediaCopyCapacity) {
      throw new Error("Committed route exceeds endpoint capacity");
    }
  }

  private assertViewer(peerId: string): void {
    if (this.participants.get(peerId)?.role !== "viewer") throw new Error("Route child must be a Viewer");
  }

  private effectiveCapacity(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Effective capacity is invalid");
    return Math.min(value, this.options.endpointMediaCopyCapacity);
  }

  private touchFacts(): void { this.factVersion += 1; }

  private allocateRevision(): number {
    if (this.latestRevision >= MAX_MEDIA_ROUTE_REVISION) throw new Error("Media route revision space exhausted");
    this.latestRevision += 1;
    return this.latestRevision;
  }
}

function compareParticipant(left: Participant, right: Participant): number {
  return left.joinOrder - right.joinOrder || left.peerId.localeCompare(right.peerId);
}

function elapsedMs(startedAtMs: number, endedAtMs: number): number | null {
  const elapsed = Math.floor(endedAtMs - startedAtMs);
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
}

function tupleKey(tuple: CandidateTuple): string {
  return tuple.kind === "peer" ? `peer:${tuple.parentPeerId}` : `sfu:${tuple.publication}`;
}

type CandidateStage = "direct" | "sfu";

function candidateStage(tuple: CandidateTuple): CandidateStage {
  if (tuple.kind === "sfu") {
    return "sfu";
  }
  return "direct";
}

function candidateStages(candidates: readonly CandidatePlan[]): CandidateStage[] {
  const stages = new Set(
    candidates.map((candidate) => candidateStage(candidate.tuple)),
  );
  return (["direct", "sfu"] as const).filter((stage) =>
    stages.has(stage),
  );
}

function edgeTupleKey<Resource>(edge: CommittedEdge<Resource>): string {
  return edge.kind === "peer" ? `peer:${edge.parentPeerId}` : "sfu:reuse";
}

function cloneCandidatePlan(plan: CandidatePlan): CandidatePlan {
  return {
    tuple: { ...plan.tuple },
    endpointTransition: plan.endpointTransition.kind === "bounded-gap"
      ? { ...plan.endpointTransition, retire: { ...plan.endpointTransition.retire } }
      : { ...plan.endpointTransition },
  };
}

function candidatePlanEquals(left: CandidatePlan, right: CandidatePlan): boolean {
  return tupleKey(left.tuple) === tupleKey(right.tuple) &&
    endpointTransitionEquals(left.endpointTransition, right.endpointTransition);
}

function endpointTransitionEquals(left: EndpointTransition, right: EndpointTransition): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "none" && right.kind === "none") {
    return left.producerPeerId === right.producerPeerId;
  }
  if (left.kind === "overlap" && right.kind === "overlap") {
    return left.producerPeerId === right.producerPeerId;
  }
  if (left.kind !== "bounded-gap" || right.kind !== "bounded-gap" ||
      left.producerPeerId !== right.producerPeerId || left.retire.kind !== right.retire.kind) return false;
  if (left.retire.kind === "publication" && right.retire.kind === "publication") {
    return left.retire.hostSessionId === right.retire.hostSessionId &&
      left.retire.generation === right.retire.generation &&
      left.retire.connectionId === right.retire.connectionId;
  }
  if (left.retire.kind === "edge" && right.retire.kind === "edge") {
    return left.retire.childPeerId === right.retire.childPeerId &&
      left.retire.childSessionId === right.retire.childSessionId &&
      left.retire.parentPeerId === right.retire.parentPeerId &&
      left.retire.parentSessionId === right.retire.parentSessionId &&
      left.retire.transport === right.retire.transport &&
      left.retire.connectionId === right.retire.connectionId;
  }
  return false;
}

function reservationResources<Resource>(reservation: CandidateReservation<Resource>): Resource[] {
  const resources: Resource[] = [];
  if ("edge" in reservation) resources.push(reservation.edge);
  if ("publication" in reservation) resources.push(reservation.publication);
  if ("overlap" in reservation && reservation.overlap !== undefined) resources.push(reservation.overlap);
  return resources;
}
