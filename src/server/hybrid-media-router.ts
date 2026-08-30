import { randomBytes } from "node:crypto";
import { debuglog } from "node:util";

import type {
  ClientMessage,
  MediaRouteUpstream,
  ParticipantRouteAssignment,
  PreparedRouteCandidate,
  RoutePolicy,
  Role,
  ServerMessage,
} from "../shared/protocol.js";
import { assertEndpointMediaCopyCapacity } from "../shared/media-copy-accounting.js";
import type { SfuTokenIssuer } from "./livekit-token.js";
import {
  RoomRouteController,
  type CandidateCursorGuard,
  type CandidatePlan,
  type CandidateReservation,
  type CandidateTuple,
  type OperationSnapshot,
  type RouteQualityEvidenceInput,
  type RouteQualityEvidenceResult,
  type SenderQualityEvidenceInput,
  type SfuPublisherQualityEvidenceInput,
  type RouteSnapshot,
} from "./room-route-controller.js";
import type { RoomStore } from "./room-store.js";
import type { SfuRoomControl } from "./sfu-room-control.js";
import { managedSfuRoomName } from "./sfu-room-control.js";
import type {
  SfuResourceAdmission,
  SfuResourceFence,
  SfuSubscriptionFence,
} from "./sfu-resource-admission.js";

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

const DEFAULT_ROUTE_OPERATION_TIMEOUT_MS = 20_000;
const DEFAULT_SFU_DRAIN_RETRY_MS = 1_000;
const DEFAULT_HOST_OFFLINE_CHECK_MS = 5_000;
const routeDebug = debuglog("screener-route");

interface RouteResourceBase {
  released: boolean;
}

interface SfuSubscriptionRouteResource extends RouteResourceBase {
  kind: "sfu-subscription";
  fence: SfuSubscriptionFence;
}

interface SfuPublicationRouteResource extends RouteResourceBase {
  kind: "sfu-publication";
  fence: SfuResourceFence;
}

interface OverlapRouteResource extends RouteResourceBase {
  kind: "overlap";
  endpointPeerId: string;
}

type RouteResource =
  | SfuSubscriptionRouteResource
  | SfuPublicationRouteResource
  | OverlapRouteResource;

type SfuDrainTarget =
  | { kind: "publication"; fence: SfuResourceFence }
  | { kind: "subscription"; fence: SfuSubscriptionFence };

type SfuDrainTask = SfuDrainTarget & {
  operation?: Promise<void>;
  retryTimer?: NodeJS.Timeout;
};

interface HostOfflineCheck {
  hostPeerId: string;
  fence: SfuResourceFence;
  hostSessionId: string;
  connectionId: string;
  timer: NodeJS.Timeout;
}

interface RoomRuntime {
  hostPeerId?: string;
  controller?: RoomRouteController<RouteResource>;
  advertisedCapacityByViewer: Map<string, number>;
  requested: boolean;
  pump?: Promise<void>;
  deadlineTimer?: NodeJS.Timeout;
  sfuRefreshesInFlight: Set<string>;
}

interface PreparedCandidate {
  reservation: CandidateReservation<RouteResource>;
  connectionId: string;
  publicationGeneration?: string;
  publicationConnectionId?: string;
  hostSessionId?: string;
  hostSfuConfig?: Extract<ServerMessage, { type: "sfu-config" }>;
  viewerSfuConfig?: Extract<ServerMessage, { type: "sfu-config" }>;
}

type PrepareResult =
  | {
      kind: "denied";
      rejectionBucket: "stale" | "sfu-admission" | "candidate-failed";
    }
  | { kind: "ready"; prepared: PreparedCandidate };

type QualitySampleReference =
  | {
      kind: "peer";
      childPeerId: string;
      routeRevision: number;
      connectionId: string;
    }
  | {
      kind: "sfu";
      routeRevision: number;
      publicationGeneration: string;
      hostSessionId: string;
    };

interface QualityCopyContext {
  committedCopies: number;
  candidateReservedCopies: number;
  possibleCopies: number;
  endpointCapacity: number;
  operationReason: OperationSnapshot["reason"] | null;
  candidateTransition:
    | CandidatePlan["endpointTransition"]["kind"]
    | null;
  sampleRole: "active" | "candidate" | "unknown";
}

export type ActiveViewerMediaEdge =
  | {
      revision: number;
      connectionId: string;
      upstream: { kind: "peer"; peerId: string };
    }
  | {
      revision: number;
      connectionId: string;
      upstream: { kind: "sfu" };
    };

export interface SfuFallbackOptions {
  url: string;
  tokenIssuer: SfuTokenIssuer;
  admission: SfuResourceAdmission;
  roomControl: SfuRoomControl;
  prepareTimeoutMs?: number;
  drainRetryMs?: number;
  hostOfflineCheckMs?: number;
}

export interface HybridMediaRouterOptions {
  roomStore: RoomStore;
  endpointMediaCopyCapacity: number;
  sfuFallback?: SfuFallbackOptions;
  sendToSession: (sessionId: string, message: ServerMessage) => void;
  getConnectionId: (roomId: string, viewerPeerId: string) => string | undefined;
  setConnectionId: (roomId: string, viewerPeerId: string, connectionId: string) => void;
  deleteConnectionId: (roomId: string, viewerPeerId: string) => void;
  getShareGeneration: (roomId: string) => string | undefined;
  onRoutesChanged?: (roomId: string) => void;
  now?: () => number;
}

export interface HybridAuthenticationState {
  routeRevision: number;
  routeAssignment: ParticipantRouteAssignment;
}

export interface AuthenticatedRouteParticipant {
  roomId: string;
  role: Role;
  peerId: string;
  sessionId: string;
  routePolicy?: RoutePolicy;
}

export class HybridMediaRouter {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly resourceWaiters = new Set<string>();
  private readonly sfuDrainTasks = new Map<string, SfuDrainTask>();
  private readonly hostOfflineChecks = new Map<string, HostOfflineCheck>();
  private readonly now: () => number;
  private closing = false;

  constructor(private readonly options: HybridMediaRouterOptions) {
    assertEndpointMediaCopyCapacity(options.endpointMediaCopyCapacity);
    this.now = options.now ?? Date.now;
    if (options.sfuFallback) new URL(options.sfuFallback.url);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const roomId of [...this.rooms.keys()]) this.clearRoom(roomId);
    this.resourceWaiters.clear();
    for (const check of this.hostOfflineChecks.values()) clearTimeout(check.timer);
    this.hostOfflineChecks.clear();
    const fallback = this.options.sfuFallback;
    if (!fallback) return;
    for (const fence of fallback.admission.beginDrainAll()) {
      this.scheduleSfuPublicationDrain(fence);
    }
    for (const [key, task] of [...this.sfuDrainTasks]) {
      if (task.retryTimer) clearTimeout(task.retryTimer);
      if (task.operation) await task.operation;
      if (this.sfuDrainTasks.get(key) === task) await this.runSfuDrain(key, task);
    }
  }

  connectParticipant(input: AuthenticatedRouteParticipant): HybridAuthenticationState {
    const room = this.room(input.roomId);
    if (input.role === "host") {
      if (room.controller && room.hostPeerId !== input.peerId) {
        this.clearDeadline(room);
        for (const viewerPeerId of this.options.roomStore.getViewerPeerIds(
          input.roomId,
        )) {
          this.options.deleteConnectionId(input.roomId, viewerPeerId);
        }
        this.releaseResources(
          room.controller.rebindHostIdentity(
            input.peerId,
            input.sessionId,
            this.now(),
          ),
        );
      }
      room.hostPeerId = input.peerId;
      this.cancelHostOfflineCheck(input.roomId);
      if (!room.controller) this.createController(input.roomId, room, input);
    } else {
      room.advertisedCapacityByViewer.set(
        input.peerId,
        room.advertisedCapacityByViewer.get(input.peerId) ?? 0,
      );
    }
    if (room.controller) {
      this.releaseResources(
        room.controller.upsertParticipant({
          peerId: input.peerId,
          role: input.role,
          sessionId: input.sessionId,
          effectiveDownstreamCapacity:
            input.role === "host"
              ? this.options.endpointMediaCopyCapacity
              : (room.advertisedCapacityByViewer.get(input.peerId) ?? 0),
        }, this.now()),
      );
    }
    const snapshot = room.controller?.snapshot();
    const assignment = snapshot
      ? this.assignments(input.roomId, snapshot).get(input.peerId) ?? emptyAssignment()
      : emptyAssignment();
    if (input.role === "viewer") {
      const edge = snapshot?.upstreamByViewer.get(input.peerId);
      if (snapshot && edge && this.pathIsPhysical(input.roomId, snapshot, input.peerId)) {
        this.options.setConnectionId(input.roomId, input.peerId, edge.connectionId);
      } else {
        this.options.deleteConnectionId(input.roomId, input.peerId);
      }
    }
    return {
      routeRevision: snapshot?.revision ?? 0,
      routeAssignment: assignment,
    };
  }

  completeAuthentication(
    participant: AuthenticatedRouteParticipant,
    _state: HybridAuthenticationState,
  ): void {
    const room = this.rooms.get(participant.roomId);
    if (!room?.controller) return;
    this.broadcastActive(participant.roomId, room);
    void this.sendFreshSfuConfig(participant).catch(() => undefined);
    this.requestPump(participant.roomId);
  }

  setPaused(roomId: string, paused: boolean): void {
    const room = this.rooms.get(roomId);
    if (!room?.controller) return;
    const before = room.controller.snapshot().revision;
    this.releaseResources(room.controller.setPaused(paused, this.now()));
    if (room.controller.snapshot().revision !== before) this.broadcastActive(roomId, room);
    if (!paused) this.requestPump(roomId);
  }

  routeDiagnosticSnapshot(
    roomId: string,
  ): Extract<ServerMessage, { type: "route-diagnostic-snapshot" }>["snapshot"] {
    return (
      this.rooms.get(roomId)?.controller?.routeDiagnosticSnapshot(this.now()) ?? {
        children: [],
        operation: null,
      }
    );
  }

  observeQualityEvidence(
    input: RouteQualityEvidenceInput & { roomId: string },
  ): RouteQualityEvidenceResult {
    const { roomId, ...evidence } = input;
    const result =
      this.rooms.get(roomId)?.controller?.observeQualityEvidence(evidence) ??
      "rejected";
    if (result !== "rejected") {
      this.debug(roomId, "viewer-quality-evidence", {
        viewer: this.debugPeer(roomId, input.childPeerId),
        upstream:
          input.upstream.kind === "peer"
            ? `p2p:${this.debugPeer(roomId, input.upstream.peerId)}`
            : "sfu",
        framesPerSecond: input.metrics.framesPerSecond,
        bitrateKbps: input.metrics.bitrateKbps,
        width: input.metrics.width,
        height: input.metrics.height,
        framesDecoded: input.metrics.framesDecodedDelta,
        freezes: input.metrics.freezeCountDelta,
        pauses: input.metrics.pauseCountDelta,
      });
    }
    return result;
  }

  observeSenderQualityEvidence(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "sender-quality-evidence" }>,
  ): boolean {
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    if (!room || !controller) {
      return false;
    }
    const snapshot = controller.snapshot();
    const before = snapshot.revision;
    const copyContext = this.qualityCopyContext(
      snapshot,
      room.hostPeerId ?? "",
      participant.peerId,
      participant.role === "host"
        ? this.options.endpointMediaCopyCapacity
        : Math.min(
            room.advertisedCapacityByViewer.get(participant.peerId) ?? 0,
            this.options.endpointMediaCopyCapacity,
          ),
      {
        kind: "peer",
        childPeerId: message.childPeerId,
        routeRevision: message.routeRevision,
        connectionId: message.connectionId,
      },
    );
    const input: SenderQualityEvidenceInput = {
      parentPeerId: participant.peerId,
      parentSessionId: participant.sessionId,
      childPeerId: message.childPeerId,
      routeRevision: message.routeRevision,
      connectionId: message.connectionId,
      senderIdentity:
        message.rtpStatsId && message.trackIdentifier
          ? `${message.rtpStatsId}\u0000${message.trackIdentifier}`
          : null,
      sampleTimestampMs: message.sampleTimestampMs,
      state: message.state,
      acceptedAtMs: this.now(),
    };
    const result = controller.observeSenderQualityEvidence(
      input,
      (reservation) => this.commitReservation(reservation),
    );
    if (result.accepted) {
      this.debug(participant.roomId, "sender-quality-evidence", {
        parent: this.debugPeer(participant.roomId, participant.peerId),
        child: this.debugPeer(participant.roomId, message.childPeerId),
        routeRevision: message.routeRevision,
        ...copyContext,
        state: message.state,
        reason: message.diagnostics.reason,
        framesPerSecond: message.diagnostics.framesPerSecond,
        bitrateKbps: message.diagnostics.bitrateKbps,
        captureFramesPerSecond:
          message.diagnostics.captureFramesPerSecond ?? null,
        mediaSourceFramesPerSecond:
          message.diagnostics.mediaSourceFramesPerSecond ?? null,
        width: message.diagnostics.width ?? null,
        height: message.diagnostics.height ?? null,
        availableOutgoingKbps:
          message.diagnostics.availableOutgoingKbps ?? null,
        rttMs: message.diagnostics.rttMs ?? null,
        packetLossPercent: message.diagnostics.packetLossPercent ?? null,
      });
    }
    this.releaseResources(result.released);
    if (result.committed) {
      this.resourceWaiters.delete(participant.roomId);
      this.options.setConnectionId(
        participant.roomId,
        message.childPeerId,
        message.connectionId,
      );
    }
    if (controller.snapshot().revision !== before) {
      this.broadcastActive(participant.roomId, room);
    }
    this.sendRouteFailures(
      participant.roomId,
      result.failedPeerIds,
      controller.snapshot().revision,
    );
    if (result.accepted) {
      this.requestPump(participant.roomId);
    }
    return result.accepted;
  }

  observeSfuPublisherQualityEvidence(
    participant: AuthenticatedRouteParticipant,
    message: Extract<
      ClientMessage,
      { type: "sfu-publisher-quality-evidence" }
    >,
  ): boolean {
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    if (!room || !controller || participant.role !== "host") {
      return false;
    }
    const snapshot = controller.snapshot();
    const operation = snapshot.operation;
    const candidateChildPeerId = operation?.childPeerId;
    const candidateConnectionId = operation?.current?.connectionId;
    const before = snapshot.revision;
    const copyContext = this.qualityCopyContext(
      snapshot,
      participant.peerId,
      participant.peerId,
      this.options.endpointMediaCopyCapacity,
      {
        kind: "sfu",
        routeRevision: message.routeRevision,
        publicationGeneration: message.publicationGeneration,
        hostSessionId: participant.sessionId,
      },
    );
    const input: SfuPublisherQualityEvidenceInput = {
      hostPeerId: participant.peerId,
      hostSessionId: participant.sessionId,
      publicationGeneration: message.publicationGeneration,
      routeRevision: message.routeRevision,
      state: message.state,
      sampleTimestampMs: message.sampleTimestampMs,
      acceptedAtMs: this.now(),
    };
    const result = controller.observeSfuPublisherQualityEvidence(
      input,
      (reservation) => this.commitReservation(reservation),
    );
    if (result.accepted) {
      this.debug(participant.roomId, "sfu-publisher-quality-evidence", {
        routeRevision: message.routeRevision,
        ...copyContext,
        state: message.state,
        reason: message.diagnostics.reason,
        framesPerSecond: message.diagnostics.framesPerSecond,
        bitrateKbps: message.diagnostics.bitrateKbps,
        captureFramesPerSecond:
          message.diagnostics.captureFramesPerSecond ?? null,
        mediaSourceFramesPerSecond:
          message.diagnostics.mediaSourceFramesPerSecond ?? null,
        width: message.diagnostics.width ?? null,
        height: message.diagnostics.height ?? null,
        availableOutgoingKbps:
          message.diagnostics.availableOutgoingKbps ?? null,
        rttMs: message.diagnostics.rttMs ?? null,
        packetLossPercent: message.diagnostics.packetLossPercent ?? null,
      });
    }
    this.releaseResources(result.released);
    if (
      result.committed &&
      candidateChildPeerId &&
      candidateConnectionId
    ) {
      this.resourceWaiters.delete(participant.roomId);
      this.options.setConnectionId(
        participant.roomId,
        candidateChildPeerId,
        candidateConnectionId,
      );
    }
    if (controller.snapshot().revision !== before) {
      this.broadcastActive(participant.roomId, room);
    }
    this.sendRouteFailures(
      participant.roomId,
      result.failedPeerIds,
      controller.snapshot().revision,
    );
    if (result.accepted) {
      this.requestPump(participant.roomId);
    }
    return result.accepted;
  }

  resetSenderQuality(participant: AuthenticatedRouteParticipant): void {
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    if (!room || !controller) {
      return;
    }
    const before = controller.snapshot().revision;
    this.releaseResources(
      controller.resetSenderQuality(
        participant.peerId,
        participant.sessionId,
        this.now(),
      ),
    );
    if (controller.snapshot().revision !== before) {
      this.broadcastActive(participant.roomId, room);
    }
    this.requestPump(participant.roomId);
  }

  isActivePeerParentOf(
    roomId: string,
    parentPeerId: string,
    childPeerId: string,
  ): boolean {
    return this.resolveActivePeerEdge(roomId, childPeerId)?.parentPeerId === parentPeerId;
  }

  resolveActivePeerEdge(
    roomId: string,
    childPeerId: string,
  ): { revision: number; parentPeerId: string } | undefined {
    const activeEdge = this.resolveActiveViewerMediaEdge(roomId, childPeerId);
    return activeEdge?.upstream.kind === "peer"
      ? {
          revision: activeEdge.revision,
          parentPeerId: activeEdge.upstream.peerId,
        }
      : undefined;
  }

  resolveActiveViewerMediaEdge(
    roomId: string,
    childPeerId: string,
  ): ActiveViewerMediaEdge | undefined {
    const snapshot = this.rooms.get(roomId)?.controller?.snapshot();
    const edge = snapshot?.upstreamByViewer.get(childPeerId);
    if (
      !snapshot ||
      !edge ||
      !this.pathIsPhysical(roomId, snapshot, childPeerId)
    ) {
      return undefined;
    }
    return edge.kind === "peer"
      ? {
          revision: snapshot.revision,
          connectionId: edge.connectionId,
          upstream: { kind: "peer", peerId: edge.parentPeerId },
        }
      : {
          revision: snapshot.revision,
          connectionId: edge.connectionId,
          upstream: { kind: "sfu" },
        };
  }

  getViewerRouteUpstream(roomId: string, viewerPeerId: string): MediaRouteUpstream {
    const snapshot = this.rooms.get(roomId)?.controller?.snapshot();
    return snapshot
      ? (this.assignments(roomId, snapshot).get(viewerPeerId)?.upstream ?? { kind: "none" })
      : { kind: "none" };
  }

  peerSignalAuthorization(input: {
    roomId: string;
    sourcePeerId: string;
    sourceSessionId: string;
    targetPeerId: string;
    targetSessionId: string;
    connectionId: string;
    signalKind: "candidate" | "description";
    descriptionType?: "offer" | "answer";
  }): boolean | "probe" | undefined {
    const controller = this.rooms.get(input.roomId)?.controller;
    const snapshot = controller?.snapshot();
    if (!controller || !snapshot) return undefined;
    const operation = snapshot.operation;
    const current = operation?.current;
    if (operation && current?.tuple.kind === "peer") {
      const parent = this.connectedPeer(input.roomId, current.tuple.parentPeerId);
      const child = this.options.roomStore.getConnectedViewer(
        input.roomId,
        operation.childPeerId,
      );
      const parentToChild =
        input.sourcePeerId === current.tuple.parentPeerId &&
        input.targetPeerId === operation.childPeerId;
      const childToParent =
        input.sourcePeerId === operation.childPeerId &&
        input.targetPeerId === current.tuple.parentPeerId;
      if (parentToChild || childToParent) {
        return Boolean(
          parent &&
            child &&
            parent.sessionId === (parentToChild ? input.sourceSessionId : input.targetSessionId) &&
            child.sessionId === (childToParent ? input.sourceSessionId : input.targetSessionId) &&
            input.connectionId === current.connectionId &&
            (input.signalKind === "candidate" ||
              (parentToChild && input.descriptionType === "offer") ||
              (childToParent && input.descriptionType === "answer")),
        )
          ? "probe"
          : false;
      }
    }

    const childPeerId = this.childForPair(snapshot, input.sourcePeerId, input.targetPeerId);
    const edge = childPeerId ? snapshot.upstreamByViewer.get(childPeerId) : undefined;
    if (!childPeerId || edge?.kind !== "peer" || !edge.physicalActive) return undefined;
    const parentToChild = input.sourcePeerId === edge.parentPeerId;
    const sessionsMatch =
      (parentToChild &&
        input.sourceSessionId === edge.parentSessionId &&
        input.targetSessionId === edge.childSessionId) ||
      (!parentToChild &&
        input.sourceSessionId === edge.childSessionId &&
        input.targetSessionId === edge.parentSessionId);
    if (!sessionsMatch) return false;
    if (
      edge.transport === "direct" &&
      parentToChild &&
      input.signalKind === "description" &&
      input.descriptionType === "offer" &&
      input.connectionId !== edge.connectionId
    ) {
      const adopted = controller.adoptDirectConnection({
        childPeerId,
        childSessionId: edge.childSessionId,
        parentSessionId: edge.parentSessionId,
        routeRevision: snapshot.revision,
        connectionId: edge.connectionId,
        newConnectionId: input.connectionId,
      });
      if (adopted) this.options.setConnectionId(input.roomId, childPeerId, input.connectionId);
      return adopted;
    }
    return input.connectionId === edge.connectionId;
  }

  debugPeerSignal(input: {
    roomId: string;
    sourcePeerId: string;
    targetPeerId: string;
    signalKind: "candidate" | "description";
    descriptionType?: "offer" | "answer";
    authorization: boolean | "probe" | undefined;
  }): void {
    this.debug(input.roomId, "peer-signal", {
      source: this.debugPeer(input.roomId, input.sourcePeerId),
      target: this.debugPeer(input.roomId, input.targetPeerId),
      signalKind: input.signalKind,
      descriptionType: input.descriptionType ?? null,
      authorization:
        input.authorization === undefined ? "assignment" : input.authorization,
    });
  }

  setViewerRelayCapacity(
    participant: AuthenticatedRouteParticipant,
    downstreamEdges: number,
  ): void {
    const room = this.room(participant.roomId);
    this.debug(participant.roomId, "relay-capacity-received", {
      participant: this.debugPeer(participant.roomId, participant.peerId),
      downstreamEdges,
    });
    room.advertisedCapacityByViewer.set(participant.peerId, downstreamEdges);
    if (
      room.controller?.setEffectiveCapacity(
        participant.peerId,
        participant.sessionId,
        downstreamEdges,
        this.now(),
      )
    ) {
      this.requestPump(participant.roomId);
    }
  }

  handleRouteReady(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-ready" }>,
  ): void {
    if (participant.role !== "viewer" || message.phase !== "prepare") return;
    this.debug(participant.roomId, "route-ready-received", {
      participant: this.debugPeer(participant.roomId, participant.peerId),
      revision: message.revision,
    });
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    const operation = controller?.snapshot().operation;
    const current = operation?.current;
    if (
      !room ||
      !controller ||
      !operation ||
      !current ||
      operation.childPeerId !== participant.peerId ||
      operation.childSessionId !== participant.sessionId ||
      current.revision !== message.revision
    ) {
      return;
    }
    const before = controller.snapshot().revision;
    const settled = controller.candidateReady(
      {
        childPeerId: participant.peerId,
        childSessionId: participant.sessionId,
        revision: message.revision,
        connectionId: current.connectionId,
      },
      this.now(),
      (reservation) => this.commitReservation(reservation),
      { relativeQualityApproved: message.qualityApproved === true },
    );
    this.debug(participant.roomId, "route-ready-settled", {
      participant: this.debugPeer(participant.roomId, participant.peerId),
      revision: message.revision,
      accepted: settled.accepted,
      exhausted: settled.failedPeerIds.length > 0,
    });
    this.releaseResources(settled.released);
    if (settled.committed !== false && settled.accepted) {
      this.resourceWaiters.delete(participant.roomId);
      this.options.setConnectionId(
        participant.roomId,
        participant.peerId,
        current.connectionId,
      );
    }
    if (controller.snapshot().revision !== before) this.broadcastActive(participant.roomId, room);
    this.sendRouteFailures(
      participant.roomId,
      settled.failedPeerIds,
      controller.snapshot().revision,
    );
    this.requestPump(participant.roomId);
  }

  handleRouteTransportConnected(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-transport-connected" }>,
  ): void {
    if (participant.role !== "viewer") return;
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    const operation = controller?.snapshot().operation;
    const current = operation?.current;
    if (
      !room ||
      !controller ||
      !operation ||
      !current ||
      operation.childPeerId !== participant.peerId ||
      operation.childSessionId !== participant.sessionId ||
      current.revision !== message.revision ||
      current.connectionId !== message.connectionId ||
      current.tuple.kind !== "peer"
    ) {
      return;
    }
    const before = controller.snapshot().revision;
    const progressed = controller.candidateTransportConnected(
      {
        childPeerId: participant.peerId,
        childSessionId: participant.sessionId,
        revision: message.revision,
        connectionId: message.connectionId,
      },
      this.now(),
    );
    this.releaseResources(progressed.released);
    if (controller.snapshot().revision !== before) {
      this.broadcastActive(participant.roomId, room);
    }
    this.sendRouteFailures(
      participant.roomId,
      progressed.failedPeerIds,
      controller.snapshot().revision,
    );
    const after = controller.snapshot().operation;
    if (!progressed.accepted || after?.wakeAtMs !== operation.wakeAtMs) {
      this.requestPump(participant.roomId);
    }
  }

  handleRouteMediaUnavailable(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-media-unavailable" }>,
  ): void {
    if (participant.role !== "viewer") return;
    this.debug(participant.roomId, "sfu-media-unavailable", {
      participant: this.debugPeer(participant.roomId, participant.peerId),
      revision: message.revision,
    });
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    const snapshot = controller?.snapshot();
    const edge = snapshot?.upstreamByViewer.get(participant.peerId);
    if (
      !room ||
      !controller ||
      !snapshot ||
      snapshot.paused ||
      snapshot.revision !== message.revision ||
      edge?.kind !== "sfu" ||
      edge.childSessionId !== participant.sessionId
    ) {
      return;
    }
    controller.invalidateEdge({
      childPeerId: participant.peerId,
      childSessionId: participant.sessionId,
      routeRevision: snapshot.revision,
      connectionId: edge.connectionId,
    }, this.now());
    this.requestPump(participant.roomId);
  }

  handleRouteFailed(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-failed" }>,
  ): void {
    this.debug(participant.roomId, "route-failed-received", {
      participant: this.debugPeer(participant.roomId, participant.peerId),
      role: participant.role,
      phase: message.phase,
      revision: message.revision,
      hasConnectionId: Boolean(message.connectionId),
    });
    const room = this.rooms.get(participant.roomId);
    const controller = room?.controller;
    const snapshot = controller?.snapshot();
    if (!room || !controller || !snapshot) return;
    if (message.phase === "prepare") {
      const operation = snapshot.operation;
      const current = operation?.current;
      if (!operation || !current || current.revision !== message.revision) return;
      const ownsChild =
        participant.role === "viewer" &&
        participant.peerId === operation.childPeerId &&
        participant.sessionId === operation.childSessionId;
      const ownsParent =
        current.tuple.kind === "peer" &&
        participant.peerId === current.tuple.parentPeerId &&
        this.connectedPeer(participant.roomId, participant.peerId)?.sessionId ===
          participant.sessionId;
      const ownsPublication =
        current.tuple.kind === "sfu" &&
        participant.role === "host" &&
        participant.peerId === room.hostPeerId &&
        this.options.roomStore.getConnectedHost(participant.roomId)
          ?.sessionId === participant.sessionId;
      if (!ownsChild && !ownsParent && !ownsPublication) return;
      if (message.connectionId && message.connectionId !== current.connectionId) return;
      const before = snapshot.revision;
      const settled = controller.candidateFailed(
        {
          childPeerId: operation.childPeerId,
          childSessionId: operation.childSessionId,
          revision: current.revision,
          connectionId: current.connectionId,
        },
        this.now(),
      );
      this.releaseResources(settled.released);
      if (controller.snapshot().revision !== before) this.broadcastActive(participant.roomId, room);
      this.sendRouteFailures(
        participant.roomId,
        settled.failedPeerIds,
        controller.snapshot().revision,
      );
      this.requestPump(participant.roomId);
      return;
    }

    if (snapshot.revision !== message.revision) return;
    if (participant.role === "host") {
      if (
        message.connectionId &&
        controller.invalidateDirectEdgeFromParent(
          {
            parentPeerId: participant.peerId,
            parentSessionId: participant.sessionId,
            routeRevision: snapshot.revision,
            connectionId: message.connectionId,
          },
          this.now(),
        )
      ) {
        this.requestPump(participant.roomId);
        return;
      }
      const publication = snapshot.hostPublication;
      if (
        !publication ||
        publication.hostSessionId !== participant.sessionId ||
        (message.connectionId && message.connectionId !== publication.connectionId)
      ) {
        return;
      }
      controller.invalidateHostPublication({
        hostSessionId: participant.sessionId,
        routeRevision: snapshot.revision,
        generation: publication.generation,
        connectionId: publication.connectionId,
      }, this.now());
      const invalid = controller.snapshot();
      this.releaseResources(
        controller.retireHostPublication({
          hostSessionId: participant.sessionId,
          routeRevision: invalid.revision,
          generation: publication.generation,
          connectionId: publication.connectionId,
        }),
      );
      this.broadcastActive(participant.roomId, room);
      this.requestPump(participant.roomId);
      return;
    }

    const edge = snapshot.upstreamByViewer.get(participant.peerId);
    if (
      !edge ||
      edge.childSessionId !== participant.sessionId ||
      (message.connectionId && message.connectionId !== edge.connectionId)
    ) {
      return;
    }
    const invalidated = controller.invalidateEdge({
      childPeerId: participant.peerId,
      childSessionId: participant.sessionId,
      routeRevision: snapshot.revision,
      connectionId: edge.connectionId,
      ...(edge.kind === "peer" ? { parentSessionId: edge.parentSessionId } : {}),
    }, this.now());
    if (invalidated && edge.usable && snapshot.paused) {
      this.options.onRoutesChanged?.(participant.roomId);
    }
    this.requestPump(participant.roomId);
  }

  refreshSfu(participant: AuthenticatedRouteParticipant, revision: number): void {
    const room = this.rooms.get(participant.roomId);
    const snapshot = room?.controller?.snapshot();
    if (!room || !snapshot || revision > snapshot.revision) return;
    const currentRevision = snapshot.revision;
    const key = `${currentRevision}\u0000${participant.peerId}\u0000${participant.sessionId}`;
    if (room.sfuRefreshesInFlight.has(key)) return;
    room.sfuRefreshesInFlight.add(key);
    void this.sendFreshSfuConfig(participant)
      .catch(() => this.failCurrentSfuRoute(participant, currentRevision))
      .finally(() => room.sfuRefreshesInFlight.delete(key));
  }

  private failCurrentSfuRoute(
    participant: AuthenticatedRouteParticipant,
    revision: number,
  ): void {
    const room = this.rooms.get(participant.roomId);
    const snapshot = room?.controller?.snapshot();
    if (!room || !snapshot || snapshot.revision !== revision) return;
    const edge = snapshot.upstreamByViewer.get(participant.peerId);
    const connectionId =
      participant.peerId === room.hostPeerId
        ? snapshot.hostPublication?.connectionId
        : edge?.kind === "sfu"
          ? edge.connectionId
          : undefined;
    if (!connectionId) return;
    this.handleRouteFailed(participant, {
      type: "route-failed",
      revision,
      phase: "active",
      connectionId,
    });
  }

  disconnectParticipant(roomId: string, peerId: string, sessionId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.controller?.disconnectSession(peerId, sessionId)) return;
    if (peerId === room.hostPeerId) this.scheduleHostOfflineCheck(roomId, peerId);
    this.requestPump(roomId);
  }

  removeViewer(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    room?.advertisedCapacityByViewer.delete(peerId);
    this.options.deleteConnectionId(roomId, peerId);
    if (room?.controller?.confirmDeparture(peerId, this.now())) {
      this.requestPump(roomId);
    } else if (room && !room.controller && room.advertisedCapacityByViewer.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  stopRoom(roomId: string): void {
    const capacities = new Map(
      this.rooms.get(roomId)?.advertisedCapacityByViewer ?? [],
    );
    this.clearRoom(roomId);
    if (capacities.size > 0) {
      const room = this.room(roomId);
      for (const [peerId, capacity] of capacities) {
        room.advertisedCapacityByViewer.set(peerId, capacity);
      }
    }
  }

  deleteRoom(roomId: string): void {
    this.clearRoom(roomId);
  }

  private room(roomId: string): RoomRuntime {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        advertisedCapacityByViewer: new Map(),
        requested: false,
        sfuRefreshesInFlight: new Set(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private createController(
    roomId: string,
    room: RoomRuntime,
    host: AuthenticatedRouteParticipant,
  ): void {
    const routePolicy = host.routePolicy;
    room.controller = new RoomRouteController<RouteResource>({
      hostPeerId: host.peerId,
      debugRoomId: roomId,
      endpointMediaCopyCapacity: this.options.endpointMediaCopyCapacity,
      operationTimeoutMs:
        this.options.sfuFallback?.prepareTimeoutMs ?? DEFAULT_ROUTE_OPERATION_TIMEOUT_MS,
      sfuEnabled: Boolean(this.options.sfuFallback) && routePolicy?.peerOnly !== true,
      qualityConvergenceEnabled:
        routePolicy?.topologyOptimization === true,
    });
    room.controller.upsertParticipant({
      peerId: host.peerId,
      role: "host",
      sessionId: host.sessionId,
      effectiveDownstreamCapacity: this.options.endpointMediaCopyCapacity,
    }, this.now());
    for (const viewer of this.options.roomStore.getConnectedViewers(roomId)) {
      room.controller.upsertParticipant({
        peerId: viewer.peerId,
        role: "viewer",
        sessionId: viewer.sessionId,
        effectiveDownstreamCapacity:
          room.advertisedCapacityByViewer.get(viewer.peerId) ?? 0,
      }, this.now());
    }
  }

  private requestPump(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.controller || this.closing) return;
    room.requested = true;
    if (room.pump) return;
    room.pump = (async () => {
      try {
        while (room.requested && !this.closing) {
          room.requested = false;
          await this.pumpRoom(roomId, room);
        }
      } finally {
        room.pump = undefined;
        if (room.requested && !this.closing) this.requestPump(roomId);
      }
    })().catch(() => {
      console.error("Media route reconciliation failed");
      this.sendRoomError(roomId, "SERVER_ERROR", "Media routing failed");
    });
  }

  private async pumpRoom(roomId: string, room: RoomRuntime): Promise<void> {
    const controller = room.controller;
    if (!controller) return;
    let broadcastRevision = controller.snapshot().revision;
    const broadcastRevisionChange = (): void => {
      const revision = controller.snapshot().revision;
      if (revision === broadcastRevision) return;
      this.broadcastActive(roomId, room);
      broadcastRevision = revision;
    };
    for (;;) {
      const reconciled = controller.reconcile(this.now());
      this.releaseResources(reconciled.released);
      broadcastRevisionChange();
      this.sendRouteFailures(
        roomId,
        reconciled.failedPeerIds,
        controller.snapshot().revision,
      );
      const operation = reconciled.operation ?? controller.snapshot().operation;
      if (!operation) {
        this.clearDeadline(room);
        this.resourceWaiters.delete(roomId);
        return;
      }
      if (operation.current) {
        this.resourceWaiters.delete(roomId);
        this.scheduleDeadline(roomId, room, operation);
        return;
      }
      const plan = operation.candidates[operation.cursor];
      if (!plan) {
        this.resourceWaiters.delete(roomId);
        return;
      }
      const guard = cursorGuard(operation, plan);
      this.resourceWaiters.delete(roomId);
      const preparation = await this.prepareCandidate(
        roomId,
        room,
        operation,
        plan,
        operation.baseRevision +
          (plan.endpointTransition.kind === "bounded-gap" ? 2 : 1),
      );
      if (preparation.kind === "denied") {
        this.debug(roomId, "candidate-preparation-denied", {
          child: this.debugPeer(roomId, operation.childPeerId),
          route: this.debugTuple(roomId, plan.tuple),
          rejectionBucket: preparation.rejectionBucket,
          cursor: operation.cursor,
        });
        if (
          operation.reason === "quality-convergence" ||
          operation.reason === "root-convergence"
        ) {
          const skipped = controller.skipCurrentCandidate(
            guard,
            this.now(),
            preparation.rejectionBucket,
          );
          this.releaseResources(skipped.released);
          continue;
        }
        if (preparation.rejectionBucket !== "sfu-admission") {
          this.resourceWaiters.delete(roomId);
        }
        if (preparation.rejectionBucket === "sfu-admission") {
          if (
            !controller.noteCurrentCandidateRejection(
              guard,
              "sfu-admission",
            )
          ) {
            continue;
          }
          this.resourceWaiters.add(roomId);
          this.sendViewerRouteStatus(roomId, operation.demandPeerId, {
            type: "route-status",
            revision: operation.baseRevision,
            state: "waiting",
            reason: "sfu-admission",
          });
          this.scheduleDeadline(roomId, room, operation);
          return;
        }
        const skipped = controller.skipCurrentCandidate(
          guard,
          this.now(),
          preparation.rejectionBucket,
        );
        this.releaseResources(skipped.released);
        this.sendRouteFailures(
          roomId,
          skipped.failedPeerIds,
          controller.snapshot().revision,
        );
        continue;
      }
      this.resourceWaiters.delete(roomId);
      this.debug(roomId, "candidate-prepared", {
        child: this.debugPeer(roomId, operation.childPeerId),
        route: this.debugTuple(roomId, plan.tuple),
        cursor: operation.cursor,
      });
      let beginGuard = guard;
      let currentOperation = controller.snapshot().operation;
      if (plan.endpointTransition.kind === "bounded-gap") {
        const gap = controller.retireCurrentCandidateProducer(guard, this.now());
        this.releaseResources(gap.released);
        this.sendRouteFailures(
          roomId,
          gap.failedPeerIds,
          controller.snapshot().revision,
        );
        if (!gap.accepted) {
          this.releaseReservation(preparation.prepared.reservation);
          continue;
        }
        broadcastRevisionChange();
        currentOperation = controller.snapshot().operation;
        const currentPlan = currentOperation?.candidates[currentOperation.cursor];
        if (!currentOperation || !currentPlan) {
          this.releaseReservation(preparation.prepared.reservation);
          continue;
        }
        beginGuard = cursorGuard(currentOperation, currentPlan);
      }
      const begun = controller.beginCurrentCandidate({
        guard: beginGuard,
        nowMs: this.now(),
        connectionId: preparation.prepared.connectionId,
        reservation: preparation.prepared.reservation,
        publicationGeneration: preparation.prepared.publicationGeneration,
        publicationConnectionId: preparation.prepared.publicationConnectionId,
        hostSessionId: preparation.prepared.hostSessionId,
      });
      this.debug(roomId, "candidate-begin-settled", {
        child: this.debugPeer(roomId, operation.childPeerId),
        route: this.debugTuple(roomId, plan.tuple),
        accepted: begun.accepted,
        exhausted: begun.failedPeerIds.length > 0,
      });
      this.releaseResources(begun.released);
      if (!begun.accepted || !begun.operation?.current) {
        this.sendRouteFailures(
          roomId,
          begun.failedPeerIds,
          controller.snapshot().revision,
        );
        continue;
      }
      this.sendPrepareMessages(
        roomId,
        room,
        begun.operation,
        preparation.prepared,
      );
      this.debug(roomId, "candidate-prepare-sent", {
        child: this.debugPeer(roomId, operation.childPeerId),
        route: this.debugTuple(roomId, plan.tuple),
        revision: begun.operation.current.revision,
      });
      this.scheduleDeadline(roomId, room, begun.operation);
      return;
    }
  }

  private async prepareCandidate(
    roomId: string,
    room: RoomRuntime,
    operation: OperationSnapshot,
    plan: CandidatePlan,
    revision: number,
  ): Promise<PrepareResult> {
    const snapshot = room.controller!.snapshot();
    const child = this.options.roomStore.getConnectedViewer(roomId, operation.childPeerId);
    const shareGeneration = this.options.getShareGeneration(roomId);
    if (!child || child.sessionId !== operation.childSessionId || !shareGeneration) {
      return { kind: "denied", rejectionBucket: "stale" };
    }
    const connectionId = opaqueId();
    const overlap =
      plan.endpointTransition.kind === "overlap"
        ? overlapResource(plan.endpointTransition.producerPeerId)
        : undefined;
    if (plan.tuple.kind === "peer") {
      return {
        kind: "ready",
        prepared: {
          connectionId,
          reservation: { kind: "direct", ...(overlap ? { overlap } : {}) },
        },
      };
    }

    const fallback = this.options.sfuFallback;
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (
      !fallback ||
      !host ||
      host.peerId !== room.hostPeerId
    ) {
      return { kind: "denied", rejectionBucket: "stale" };
    }
    if (plan.tuple.publication === "reuse") {
      const publication = snapshot.hostPublication;
      if (
        !publication ||
        publication.resource.kind !== "sfu-publication"
      ) {
        return { kind: "denied", rejectionBucket: "stale" };
      }
      const fence: SfuSubscriptionFence = {
        ...publication.resource.fence,
        viewerPeerId: operation.childPeerId,
      };
      const currentEdge = snapshot.upstreamByViewer.get(operation.childPeerId);
      const borrowedEdge =
        currentEdge?.kind === "sfu" &&
        currentEdge.publicationGeneration === publication.generation &&
        currentEdge.resource.kind === "sfu-subscription" &&
        !currentEdge.resource.released
          ? currentEdge.resource
          : null;
      if (!borrowedEdge && !(await this.reserveSfuSubscription(fence))) {
        return { kind: "denied", rejectionBucket: "sfu-admission" };
      }
      const edge = borrowedEdge ?? subscriptionResource(fence);
      try {
        const token = await fallback.tokenIssuer.issueToken({
          roomId,
          role: "viewer",
          peerId: operation.childPeerId,
          shareGeneration,
          publicationGeneration: publication.generation,
        });
        return {
          kind: "ready",
          prepared: {
            connectionId,
            hostSessionId: host.sessionId,
            reservation: {
              kind: "sfu-reuse",
              edge,
              ...(borrowedEdge ? { borrowed: true as const } : {}),
              ...(overlap ? { overlap } : {}),
            },
            publicationGeneration: publication.generation,
            viewerSfuConfig: {
              type: "sfu-config",
              revision,
              url: fallback.url,
              token,
            },
          },
        };
      } catch {
        if (!borrowedEdge) this.releaseResource(edge);
        return { kind: "denied", rejectionBucket: "candidate-failed" };
      }
    }

    return await this.prepareNewPublication(
      roomId,
      operation,
      revision,
      connectionId,
      shareGeneration,
      host,
      overlap,
    );
  }

  private async prepareNewPublication(
    roomId: string,
    operation: OperationSnapshot,
    revision: number,
    connectionId: string,
    shareGeneration: string,
    host: { peerId: string; sessionId: string },
    overlap?: OverlapRouteResource,
  ): Promise<PrepareResult> {
    const fallback = this.options.sfuFallback!;
    const publicationGeneration = opaqueId();
    const publicationFence: SfuResourceFence = {
      roomId,
      shareGeneration,
      publicationGeneration,
    };
    const subscriptionFence: SfuSubscriptionFence = {
      ...publicationFence,
      viewerPeerId: operation.childPeerId,
    };
    if (!fallback.admission.reservePublication(publicationFence)) {
      return { kind: "denied", rejectionBucket: "sfu-admission" };
    }
    if (!fallback.admission.reserveSubscription(subscriptionFence)) {
      fallback.admission.beginDrain(publicationFence);
      this.scheduleSfuPublicationDrain(publicationFence);
      return { kind: "denied", rejectionBucket: "sfu-admission" };
    }
    const subscription = subscriptionResource(subscriptionFence);
    const publicationConnectionId = publicationGeneration;
    const publication = publicationResource(publicationFence);
    try {
      await fallback.roomControl.createRoom(publicationFence);
      const [hostToken, viewerToken] = await Promise.all([
        fallback.tokenIssuer.issueToken({
          roomId,
          role: "host",
          peerId: host.peerId,
          shareGeneration,
          publicationGeneration,
        }),
        fallback.tokenIssuer.issueToken({
          roomId,
          role: "viewer",
          peerId: operation.childPeerId,
          shareGeneration,
          publicationGeneration,
        }),
      ]);
      return {
        kind: "ready",
        prepared: {
          connectionId,
          hostSessionId: host.sessionId,
          publicationGeneration,
          publicationConnectionId,
          reservation: {
            kind: "sfu-create",
            edge: subscription,
            publication,
            ...(overlap ? { overlap } : {}),
          },
          hostSfuConfig: {
            type: "sfu-config",
            revision,
            url: fallback.url,
            token: hostToken,
          },
          viewerSfuConfig: {
            type: "sfu-config",
            revision,
            url: fallback.url,
            token: viewerToken,
          },
        },
      };
    } catch {
      this.releaseResource(subscription);
      this.releaseResource(publication);
      return { kind: "denied", rejectionBucket: "candidate-failed" };
    }
  }

  private sendPrepareMessages(
    roomId: string,
    room: RoomRuntime,
    operation: OperationSnapshot,
    prepared: PreparedCandidate,
  ): void {
    const current = operation.current!;
    const candidate = preparedRouteCandidate(operation, current.tuple, current.connectionId);
    const assignments = this.assignments(
      roomId,
      room.controller!.snapshot(),
      current.tuple,
      operation.childPeerId,
      prepared.publicationGeneration,
    );
    const child = this.options.roomStore.getConnectedViewer(roomId, operation.childPeerId);
    if (!child || child.sessionId !== operation.childSessionId) return;
    const childUpdate: ServerMessage = {
      type: "route-update",
      revision: current.revision,
      phase: "prepare",
      assignment: assignments.get(operation.childPeerId) ?? emptyAssignment(),
      candidate,
    };
    if (current.tuple.kind === "peer") {
      const parent = this.connectedPeer(roomId, current.tuple.parentPeerId);
      if (!parent) return;
      this.options.sendToSession(child.sessionId, childUpdate);
      this.options.sendToSession(parent.sessionId, {
        type: "route-update",
        revision: current.revision,
        phase: "prepare",
        assignment: assignments.get(parent.peerId) ?? emptyAssignment(),
        candidate,
      });
      return;
    }
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (
      prepared.hostSfuConfig &&
      host &&
      host.sessionId === prepared.hostSessionId
    ) {
      this.options.sendToSession(host.sessionId, {
        type: "route-update",
        revision: current.revision,
        phase: "prepare",
        assignment: assignments.get(host.peerId) ?? emptyAssignment(),
        candidate,
      });
      this.options.sendToSession(host.sessionId, prepared.hostSfuConfig);
    }
    this.options.sendToSession(child.sessionId, childUpdate);
    if (prepared.viewerSfuConfig) {
      this.options.sendToSession(child.sessionId, prepared.viewerSfuConfig);
    }
  }

  private assignments(
    roomId: string,
    snapshot: RouteSnapshot<RouteResource>,
    candidateTuple?: CandidateTuple,
    candidateChildPeerId?: string,
    candidatePublicationGeneration?: string,
  ): Map<string, ParticipantRouteAssignment> {
    const hostPeerId = this.rooms.get(roomId)?.hostPeerId;
    if (!hostPeerId) return new Map();
    const peerIds = new Set([hostPeerId, ...this.options.roomStore.getViewerPeerIds(roomId)]);
    const edges = new Map<
      string,
      { kind: "peer"; parentPeerId: string } | { kind: "sfu"; publicationGeneration: string }
    >();
    for (const [childPeerId, edge] of snapshot.upstreamByViewer) {
      if (!edge.physicalActive) continue;
      edges.set(
        childPeerId,
        edge.kind === "peer"
          ? { kind: "peer", parentPeerId: edge.parentPeerId }
          : { kind: "sfu", publicationGeneration: edge.publicationGeneration },
      );
    }
    let publicationGeneration = snapshot.hostPublication?.physicalActive
      ? snapshot.hostPublication.generation
      : null;
    if (candidateTuple && candidateChildPeerId) {
      edges.delete(candidateChildPeerId);
      if (candidateTuple.kind === "peer") {
        edges.set(candidateChildPeerId, {
          kind: "peer",
          parentPeerId: candidateTuple.parentPeerId,
        });
        const old = snapshot.upstreamByViewer.get(candidateChildPeerId);
        if (
          old?.kind === "sfu" &&
          [...edges.values()].every((edge) => edge.kind !== "sfu")
        ) {
          publicationGeneration = null;
        }
      } else {
        if (candidateTuple.publication !== "reuse") {
          for (const [peerId, edge] of [...edges]) {
            if (edge.kind === "sfu") edges.delete(peerId);
          }
          publicationGeneration = candidatePublicationGeneration ?? null;
        }
        if (publicationGeneration) {
          edges.set(candidateChildPeerId, {
            kind: "sfu",
            publicationGeneration,
          });
        }
      }
    }
    const sourceReachable = (peerId: string, seen = new Set<string>()): boolean => {
      if (peerId === hostPeerId) return true;
      if (seen.has(peerId)) return false;
      seen.add(peerId);
      const edge = edges.get(peerId);
      if (!edge) return false;
      return edge.kind === "sfu"
        ? publicationGeneration === edge.publicationGeneration
        : sourceReachable(edge.parentPeerId, seen);
    };
    const assignments = new Map<string, ParticipantRouteAssignment>();
    for (const peerId of peerIds) {
      const edge = edges.get(peerId);
      const reachable = sourceReachable(peerId);
      const childPeerIds = [...edges]
        .filter(([, candidate]) =>
          candidate.kind === "peer" &&
          candidate.parentPeerId === peerId,
        )
        .map(([childPeerId]) => childPeerId);
      assignments.set(peerId, {
        upstream:
          peerId === hostPeerId || !edge
            ? { kind: "none" }
            : edge.kind === "peer"
              ? { kind: "peer", peerId: edge.parentPeerId }
              : reachable
                ? { kind: "sfu" }
                : { kind: "none" },
        childPeerIds,
        sfuPublicationGeneration:
          peerId === hostPeerId
            ? publicationGeneration
            : reachable && edge?.kind === "sfu"
              ? edge.publicationGeneration
              : null,
      });
    }
    return assignments;
  }

  private broadcastActive(roomId: string, room: RoomRuntime): void {
    const snapshot = room.controller?.snapshot();
    if (!snapshot) return;
    this.debug(roomId, "active-topology", {
      revision: snapshot.revision,
      paused: snapshot.paused,
      hostPublication: snapshot.hostPublication?.physicalActive === true,
      routes: [...snapshot.upstreamByViewer].map(([childPeerId, edge]) => ({
        child: this.debugPeer(roomId, childPeerId),
        parent:
          edge.kind === "peer"
            ? this.debugPeer(roomId, edge.parentPeerId)
            : "sfu",
        usable: edge.usable,
        physicalActive: edge.physicalActive,
      })),
    });
    const assignments = this.assignments(roomId, snapshot);
    const participants = [
      this.options.roomStore.getConnectedHost(roomId),
      ...this.options.roomStore.getConnectedViewers(roomId),
    ].filter((peer): peer is { peerId: string; sessionId: string } => Boolean(peer));
    for (const participant of participants) {
      const assignment = assignments.get(participant.peerId) ?? emptyAssignment();
      this.options.sendToSession(participant.sessionId, {
        type: "route-update",
        revision: snapshot.revision,
        phase: "active",
        assignment,
      });
      if (participant.peerId !== room.hostPeerId) {
        const edge = snapshot.upstreamByViewer.get(participant.peerId);
        if (edge && this.pathIsPhysical(roomId, snapshot, participant.peerId)) {
          this.options.setConnectionId(roomId, participant.peerId, edge.connectionId);
        } else {
          this.options.deleteConnectionId(roomId, participant.peerId);
        }
      }
    }
    this.options.onRoutesChanged?.(roomId);
  }

  private pathIsPhysical(
    roomId: string,
    snapshot: RouteSnapshot<RouteResource>,
    childPeerId: string,
  ): boolean {
    const hostPeerId = this.rooms.get(roomId)?.hostPeerId;
    if (!hostPeerId) return false;
    const seen = new Set<string>();
    let current = childPeerId;
    while (current !== hostPeerId) {
      if (seen.has(current)) return false;
      seen.add(current);
      const edge = snapshot.upstreamByViewer.get(current);
      if (!edge?.physicalActive || !edge.usable) return false;
      if (edge.kind === "sfu") {
        return Boolean(
          snapshot.hostPublication?.physicalActive &&
            snapshot.hostPublication.generation === edge.publicationGeneration,
        );
      }
      if (edge.parentPeerId === hostPeerId) return true;
      current = edge.parentPeerId;
    }
    return true;
  }

  private childForPair(
    snapshot: RouteSnapshot<RouteResource>,
    firstPeerId: string,
    secondPeerId: string,
  ): string | undefined {
    const first = snapshot.upstreamByViewer.get(firstPeerId);
    if (first?.kind === "peer" && first.parentPeerId === secondPeerId) return firstPeerId;
    const second = snapshot.upstreamByViewer.get(secondPeerId);
    return second?.kind === "peer" && second.parentPeerId === firstPeerId
      ? secondPeerId
      : undefined;
  }

  private connectedPeer(roomId: string, peerId: string) {
    const host = this.options.roomStore.getConnectedHost(roomId);
    return host?.peerId === peerId
      ? host
      : this.options.roomStore.getConnectedViewer(roomId, peerId);
  }

  private commitReservation(
    reservation: CandidateReservation<RouteResource>,
  ): boolean {
    if (reservation.kind === "direct") return true;
    if (reservation.kind === "sfu-reuse") {
      return reservation.edge.kind === "sfu-subscription" &&
        this.options.sfuFallback?.admission.commitSubscription(
          reservation.edge.fence,
        ) === true;
    }
    if (reservation.publication.kind !== "sfu-publication") return false;
    const draining = this.options.sfuFallback?.admission.commitPublication(
      reservation.publication.fence,
    );
    if (!draining) return false;
    for (const fence of draining) this.scheduleSfuPublicationDrain(fence);
    return true;
  }

  private releaseReservation(reservation: CandidateReservation<RouteResource>): void {
    this.releaseResources(reservationResources(reservation));
  }

  private releaseResources(resources: readonly RouteResource[]): void {
    // Publication drains own accounting; subscription drains only remove exact participants.
    for (const resource of resources) {
      if (resource.kind === "sfu-publication") this.releaseResource(resource);
    }
    for (const resource of resources) {
      if (resource.kind !== "sfu-publication") this.releaseResource(resource);
    }
  }

  private releaseResource(resource: RouteResource): void {
    if (resource.released) return;
    resource.released = true;
    if (resource.kind === "overlap") return;
    if (resource.kind === "sfu-subscription") {
      this.releaseSubscription(resource.fence);
      return;
    }
    if (this.options.sfuFallback?.admission.beginDrain(resource.fence)) {
      this.scheduleSfuPublicationDrain(resource.fence);
    }
  }

  private releaseSubscription(fence: SfuSubscriptionFence): boolean {
    const admission = this.options.sfuFallback?.admission;
    if (!admission) return false;
    const accepted = admission.beginSubscriptionDrain(fence);
    if (accepted) this.scheduleSfuSubscriptionDrain(fence);
    return accepted;
  }

  private async reserveSfuSubscription(
    fence: SfuSubscriptionFence,
  ): Promise<boolean> {
    const fallback = this.options.sfuFallback;
    if (!fallback) return false;
    const key = sfuDrainKey({ kind: "subscription", fence });
    const pending = this.sfuDrainTasks.get(key);
    if (pending?.operation) {
      try {
        await pending.operation;
      } catch {
        return false;
      }
      if (this.sfuDrainTasks.get(key) === pending) return false;
    }
    const task = this.sfuDrainTasks.get(key);
    if (task?.kind === "subscription") {
      if (task.retryTimer) clearTimeout(task.retryTimer);
      this.sfuDrainTasks.delete(key);
    }
    return fallback.admission.reserveSubscription(fence);
  }

  private wakeResourceWaiters(): void {
    const roomIds = [...this.resourceWaiters];
    this.resourceWaiters.clear();
    for (const roomId of roomIds) {
      const controller = this.rooms.get(roomId)?.controller;
      if (!controller) continue;
      controller.touchExternalFacts();
      this.requestPump(roomId);
    }
  }

  private scheduleDeadline(
    roomId: string,
    room: RoomRuntime,
    operation: OperationSnapshot,
  ): void {
    this.clearDeadline(room);
    this.debug(roomId, "deadline-scheduled", {
      child: this.debugPeer(roomId, operation.childPeerId),
      wakeInMs: Math.max(0, operation.wakeAtMs - this.now()),
      cursor: operation.cursor,
      candidateCount: operation.candidates.length,
      current: operation.current
        ? this.debugTuple(roomId, operation.current.tuple)
        : null,
    });
    const timer = setTimeout(() => {
      if (room.deadlineTimer !== timer || !room.controller) return;
      room.deadlineTimer = undefined;
      const before = room.controller.snapshot().revision;
      const expired = room.controller.operationExpired(this.now());
      this.debug(roomId, "deadline-fired", {
        child: this.debugPeer(roomId, operation.childPeerId),
        accepted: expired.accepted,
        exhausted: expired.failedPeerIds.length > 0,
      });
      this.releaseResources(expired.released);
      if (room.controller.snapshot().revision !== before) this.broadcastActive(roomId, room);
      this.sendRouteFailures(
        roomId,
        expired.failedPeerIds,
        room.controller.snapshot().revision,
      );
      this.requestPump(roomId);
    }, Math.max(0, operation.wakeAtMs - this.now()));
    timer.unref();
    room.deadlineTimer = timer;
  }

  private clearDeadline(room: RoomRuntime): void {
    if (room.deadlineTimer) clearTimeout(room.deadlineTimer);
    room.deadlineTimer = undefined;
  }

  private async sendFreshSfuConfig(
    participant: AuthenticatedRouteParticipant,
  ): Promise<void> {
    const fallback = this.options.sfuFallback;
    const room = this.rooms.get(participant.roomId);
    const snapshot = room?.controller?.snapshot();
    const publication = snapshot?.hostPublication;
    const shareGeneration = this.options.getShareGeneration(participant.roomId);
    if (!fallback || !room || !snapshot || !publication?.physicalActive || !shareGeneration) {
      return;
    }
    const isHost = participant.peerId === room.hostPeerId;
    const edge = snapshot.upstreamByViewer.get(participant.peerId);
    if (!isHost && (edge?.kind !== "sfu" || !edge.physicalActive)) return;
    const token = await fallback.tokenIssuer.issueToken({
      roomId: participant.roomId,
      role: isHost ? "host" : "viewer",
      peerId: participant.peerId,
      shareGeneration,
      publicationGeneration: publication.generation,
    });
    const current = room.controller?.snapshot();
    if (
      current?.revision !== snapshot.revision ||
      current.hostPublication?.generation !== publication.generation ||
      this.connectedPeer(participant.roomId, participant.peerId)?.sessionId !==
        participant.sessionId
    ) {
      return;
    }
    this.options.sendToSession(participant.sessionId, {
      type: "sfu-config",
      revision: snapshot.revision,
      url: fallback.url,
      token,
    });
  }

  private activeHostPublication(
    roomId: string,
  ): Omit<HostOfflineCheck, "hostPeerId" | "timer"> | null {
    const publication = this.rooms.get(roomId)?.controller?.snapshot().hostPublication;
    return publication?.physicalActive &&
      publication.resource.kind === "sfu-publication"
      ? {
          fence: publication.resource.fence,
          hostSessionId: publication.hostSessionId,
          connectionId: publication.connectionId,
        }
      : null;
  }

  private scheduleHostOfflineCheck(roomId: string, hostPeerId: string): void {
    this.cancelHostOfflineCheck(roomId);
    const fallback = this.options.sfuFallback;
    const publication = this.activeHostPublication(roomId);
    if (!fallback || !publication || this.closing) return;
    const timer = setTimeout(() => {
      void this.checkHostOffline(roomId).catch(() => undefined);
    }, fallback.hostOfflineCheckMs ?? DEFAULT_HOST_OFFLINE_CHECK_MS);
    timer.unref();
    this.hostOfflineChecks.set(roomId, {
      hostPeerId,
      ...publication,
      timer,
    });
  }

  private async checkHostOffline(roomId: string): Promise<void> {
    const check = this.hostOfflineChecks.get(roomId);
    const fallback = this.options.sfuFallback;
    if (!check || !fallback || this.closing) return;
    if (this.options.roomStore.getConnectedHost(roomId)) {
      this.cancelHostOfflineCheck(roomId);
      return;
    }
    let exists = true;
    try {
      exists = await fallback.roomControl.hostParticipantExists(check.fence);
    } catch {
      if (this.hostOfflineChecks.get(roomId) !== check) return;
      this.hostOfflineChecks.delete(roomId);
      this.scheduleHostOfflineCheck(roomId, check.hostPeerId);
      return;
    }
    if (this.hostOfflineChecks.get(roomId) !== check) return;
    this.hostOfflineChecks.delete(roomId);
    if (exists) {
      this.scheduleHostOfflineCheck(roomId, check.hostPeerId);
      return;
    }
    const room = this.rooms.get(roomId);
    const controller = room?.controller;
    const snapshot = controller?.snapshot();
    const publication = snapshot?.hostPublication;
    if (!room || !controller || !snapshot || !publication) return;
    if (
      publication.resource.kind !== "sfu-publication" ||
      publication.resource.fence.roomId !== check.fence.roomId ||
      publication.resource.fence.shareGeneration !==
        check.fence.shareGeneration ||
      publication.resource.fence.publicationGeneration !==
        check.fence.publicationGeneration ||
      publication.generation !== check.fence.publicationGeneration ||
      publication.hostSessionId !== check.hostSessionId ||
      publication.connectionId !== check.connectionId ||
      !publication.physicalActive
    ) {
      this.scheduleHostOfflineCheck(roomId, check.hostPeerId);
      return;
    }
    const beforeRevision = snapshot.revision;
    controller.invalidateHostPublication({
      hostSessionId: publication.hostSessionId,
      routeRevision: snapshot.revision,
      generation: publication.generation,
      connectionId: publication.connectionId,
    }, this.now());
    const invalid = controller.snapshot();
    this.releaseResources(
      controller.retireHostPublication({
        hostSessionId: publication.hostSessionId,
        routeRevision: invalid.revision,
        generation: publication.generation,
        connectionId: publication.connectionId,
      }),
    );
    const afterRetirement = controller.snapshot().hostPublication;
    if (
      afterRetirement?.generation === publication.generation &&
      afterRetirement.connectionId === publication.connectionId &&
      afterRetirement.physicalActive
    ) {
      if (controller.snapshot().revision !== beforeRevision) {
        this.broadcastActive(roomId, room);
      }
      this.scheduleHostOfflineCheck(roomId, check.hostPeerId);
      this.requestPump(roomId);
      return;
    }
    this.broadcastActive(roomId, room);
    this.requestPump(roomId);
  }

  private cancelHostOfflineCheck(roomId: string): void {
    const check = this.hostOfflineChecks.get(roomId);
    if (check) clearTimeout(check.timer);
    this.hostOfflineChecks.delete(roomId);
  }

  private scheduleSfuPublicationDrain(fence: SfuResourceFence): void {
    const roomName = managedSfuRoomName(fence);
    for (const [key, task] of this.sfuDrainTasks) {
      if (
        task.kind === "subscription" &&
        managedSfuRoomName(task.fence) === roomName
      ) {
        if (task.retryTimer) clearTimeout(task.retryTimer);
        this.sfuDrainTasks.delete(key);
      }
    }
    this.scheduleSfuDrain({ kind: "publication", fence });
  }

  private scheduleSfuSubscriptionDrain(fence: SfuSubscriptionFence): void {
    if (this.sfuDrainTasks.has(managedSfuRoomName(fence))) return;
    this.scheduleSfuDrain({ kind: "subscription", fence });
  }

  private scheduleSfuDrain(target: SfuDrainTarget): void {
    if (!this.options.sfuFallback) return;
    const key = sfuDrainKey(target);
    let task = this.sfuDrainTasks.get(key);
    if (!task) {
      task =
        target.kind === "publication"
          ? { kind: "publication", fence: { ...target.fence } }
          : { kind: "subscription", fence: { ...target.fence } };
      this.sfuDrainTasks.set(key, task);
    }
    if (!task.operation && !task.retryTimer) {
      void this.runSfuDrain(key, task).catch(() => undefined);
    }
  }

  private runSfuDrain(key: string, task: SfuDrainTask): Promise<void> {
    if (task.operation) return task.operation;
    const fallback = this.options.sfuFallback;
    if (!fallback) return Promise.resolve();
    let tracked!: Promise<void>;
    tracked = (async () => {
      try {
        if (task.kind === "publication") {
          await fallback.roomControl.deleteRoom(task.fence);
        } else {
          await fallback.roomControl.drainSubscription(task.fence);
        }
        if (this.sfuDrainTasks.get(key) !== task) return;
        if (
          task.kind === "publication" &&
          !fallback.admission.completeDrain(task.fence)
        ) {
          throw new Error("LiveKit drain has no matching resource generation");
        }
        this.sfuDrainTasks.delete(key);
        if (task.kind === "publication") {
          this.wakeResourceWaiters();
        } else {
          this.requestPump(task.fence.roomId);
        }
      } catch (error) {
        if (this.sfuDrainTasks.get(key) !== task) return;
        if (this.closing) throw error;
        task.retryTimer = setTimeout(() => {
          task.retryTimer = undefined;
          void this.runSfuDrain(key, task).catch(() => undefined);
        }, fallback.drainRetryMs ?? DEFAULT_SFU_DRAIN_RETRY_MS);
        task.retryTimer.unref();
      }
    })().finally(() => {
      if (task.operation === tracked) task.operation = undefined;
    });
    task.operation = tracked;
    return tracked;
  }

  private clearRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.clearDeadline(room);
    this.cancelHostOfflineCheck(roomId);
    const controller = room.controller;
    room.controller = undefined;
    room.requested = false;
    if (controller) this.releaseResources(controller.dispose());
    this.rooms.delete(roomId);
    this.resourceWaiters.delete(roomId);
    for (const fence of this.options.sfuFallback?.admission.beginDrainRoom(roomId) ?? []) {
      this.scheduleSfuPublicationDrain(fence);
    }
  }

  private debugPeer(roomId: string, peerId: string): string {
    const room = this.rooms.get(roomId);
    if (peerId === room?.hostPeerId) return "host";
    return (
      room?.controller?.diagnosticParticipantLabel(peerId) ?? "viewer-unknown"
    );
  }

  private qualityCopyContext(
    snapshot: RouteSnapshot<RouteResource>,
    hostPeerId: string,
    observedPeerId: string,
    endpointCapacity: number,
    sample: QualitySampleReference,
  ): QualityCopyContext {
    let committedCopies = 0;
    for (const edge of snapshot.upstreamByViewer.values()) {
      if (
        edge.kind === "peer" &&
        edge.parentPeerId === observedPeerId &&
        edge.physicalActive
      ) {
        committedCopies += 1;
      }
    }
    if (
      observedPeerId === hostPeerId &&
      snapshot.hostPublication?.physicalActive
    ) {
      committedCopies += 1;
    }

    const operation = snapshot.operation;
    const current = operation?.current;
    const currentPlan = current
      ? operation.candidates[operation.cursor]
      : undefined;
    const candidateReservedCopies =
      current?.tuple.kind === "peer" &&
      current.tuple.parentPeerId === observedPeerId
        ? 1
        : current?.tuple.kind === "sfu" &&
            observedPeerId === hostPeerId &&
            current.tuple.publication !== "reuse"
          ? 1
          : 0;

    const candidateSample =
      sample.kind === "peer"
        ? current?.tuple.kind === "peer" &&
          operation?.childPeerId === sample.childPeerId &&
          current.tuple.parentPeerId === observedPeerId &&
          current.revision === sample.routeRevision &&
          current.connectionId === sample.connectionId
        : current?.tuple.kind === "sfu" &&
          observedPeerId === hostPeerId &&
          current.revision === sample.routeRevision;
    const activeEdge =
      sample.kind === "peer"
        ? snapshot.upstreamByViewer.get(sample.childPeerId)
        : undefined;
    const activeSample =
      sample.kind === "peer"
        ? sample.routeRevision === snapshot.revision &&
          activeEdge?.kind === "peer" &&
          activeEdge.physicalActive &&
          activeEdge.usable &&
          activeEdge.parentPeerId === observedPeerId &&
          activeEdge.connectionId === sample.connectionId
        : sample.routeRevision === snapshot.revision &&
          snapshot.hostPublication?.physicalActive === true &&
          snapshot.hostPublication.usable &&
          snapshot.hostPublication.generation ===
            sample.publicationGeneration &&
          snapshot.hostPublication.hostSessionId === sample.hostSessionId;

    return {
      committedCopies,
      candidateReservedCopies,
      possibleCopies: committedCopies + candidateReservedCopies,
      endpointCapacity,
      operationReason: operation?.reason ?? null,
      candidateTransition: currentPlan?.endpointTransition.kind ?? null,
      sampleRole: candidateSample
        ? "candidate"
        : activeSample
          ? "active"
          : "unknown",
    };
  }

  private debugTuple(roomId: string, tuple: CandidateTuple): string {
    return tuple.kind === "peer"
      ? `p2p:${this.debugPeer(roomId, tuple.parentPeerId)}${
          tuple.regenerate ? ":regenerate" : ""
        }`
      : `sfu:${tuple.publication}`;
  }

  private debug(
    roomId: string,
    event: string,
    details: Record<string, unknown>,
  ): void {
    routeDebug("%s", JSON.stringify({ event, roomId, ...details }));
  }

  private sendRoomError(roomId: string, code: ErrorCode, message: string): void {
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (host) this.options.sendToSession(host.sessionId, { type: "error", code, message });
  }

  private sendViewerRouteStatus(
    roomId: string,
    viewerPeerId: string,
    message: Extract<ServerMessage, { type: "route-status" }>,
  ): void {
    const viewer = this.options.roomStore.getConnectedViewer(roomId, viewerPeerId);
    if (viewer) this.options.sendToSession(viewer.sessionId, message);
  }

  private sendRouteFailures(
    roomId: string,
    failedPeerIds: readonly string[],
    revision: number,
  ): void {
    for (const peerId of new Set(failedPeerIds)) {
      this.sendViewerRouteStatus(roomId, peerId, {
        type: "route-status",
        revision,
        state: "failed",
        reason: "route-exhausted",
      });
    }
  }
}

function cursorGuard(
  operation: OperationSnapshot,
  plan: CandidatePlan,
): CandidateCursorGuard {
  return {
    childPeerId: operation.childPeerId,
    childSessionId: operation.childSessionId,
    baseRevision: operation.baseRevision,
    factVersion: operation.factVersion,
    cursor: operation.cursor,
    plan,
  };
}

function emptyAssignment(): ParticipantRouteAssignment {
  return {
    upstream: { kind: "none" },
    childPeerIds: [],
    sfuPublicationGeneration: null,
  };
}

function preparedRouteCandidate(
  operation: OperationSnapshot,
  tuple: CandidateTuple,
  connectionId: string,
): PreparedRouteCandidate {
  return {
    childPeerId: operation.childPeerId,
    connectionId,
    transport: tuple.kind === "peer" ? tuple.transport : "sfu",
    qualityProbe: operation.reason === "quality-convergence",
  };
}

function opaqueId(): string {
  return randomBytes(16).toString("base64url");
}

function sfuDrainKey(target: SfuDrainTarget): string {
  const roomName = managedSfuRoomName(target.fence);
  return target.kind === "publication"
    ? roomName
    : `${roomName}\u0000viewer:${target.fence.viewerPeerId}`;
}

function overlapResource(endpointPeerId: string): OverlapRouteResource {
  return { kind: "overlap", endpointPeerId, released: false };
}

function subscriptionResource(
  fence: SfuSubscriptionFence,
): SfuSubscriptionRouteResource {
  return { kind: "sfu-subscription", fence, released: false };
}

function publicationResource(
  fence: SfuResourceFence,
): SfuPublicationRouteResource {
  return {
    kind: "sfu-publication",
    fence,
    released: false,
  };
}

function reservationResources(
  reservation: CandidateReservation<RouteResource>,
): RouteResource[] {
  const resources: RouteResource[] = [];
  if (
    "edge" in reservation &&
    (reservation.kind !== "sfu-reuse" || !reservation.borrowed)
  ) {
    resources.push(reservation.edge);
  }
  if ("publication" in reservation) resources.push(reservation.publication);
  if ("overlap" in reservation && reservation.overlap) {
    resources.push(reservation.overlap);
  }
  return resources;
}
