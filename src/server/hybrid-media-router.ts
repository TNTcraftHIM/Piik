import { randomBytes } from "node:crypto";

import {
  MAX_MEDIA_ROUTE_REVISION,
  type ClientMessage,
  type MediaAssignment,
  type MediaRouteUpstream,
  type ParentEdgeQualityProof,
  type ParticipantRouteAssignment,
  type RelayDownstreamEdges,
  type Role,
  type ServerMessage,
} from "../shared/protocol.js";
import type { SfuTokenIssuer } from "./livekit-token.js";
import type { SelectedEdgeTurnConfig } from "./config.js";
import {
  MediaRouteController,
  type RoomMediaRoute,
} from "./media-route-controller.js";
import {
  MAX_PEER_RELAY_DEPTH,
  PeerRelayTopology,
  type MediaAssignmentChange,
} from "./peer-relay-topology.js";
import type { RoomStore } from "./room-store.js";
import { issueSelectedEdgeTurnCredential } from "./selected-edge-turn.js";

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

const DEFAULT_SFU_PREPARE_TIMEOUT_MS = 20_000;
const SELECTED_EDGE_TURN_ATTEMPT_TIMEOUT_MS = 30_000;
const VIEWER_QUALITY_BAD_WINDOWS_TO_REASSIGN = 3;
const VIEWER_QUALITY_EVIDENCE_GAP_MS = 5_000;
const VIEWER_QUALITY_REASSIGN_COOLDOWN_MS = 30_000;
const VIEWER_QUALITY_FREEZE_RATIO = 0.5;
const VIEWER_QUALITY_RELAY_FPS_RATIO = 2 / 3;
const VIEWER_QUALITY_MIN_LOSS_PACKETS = 100;
const VIEWER_QUALITY_HIGH_LOSS_RATIO = 0.3;
interface PendingRoutePreparation {
  revision: number;
  intentPeerId: string;
  routeIntent: ViewerRouteIntent;
  qualityIntent: {
    guard: QualityRouteIntentGuard;
    takenOverByRouteFailure: boolean;
  } | null;
  expectedSessionIds: ReadonlyMap<string, string>;
  grantsIssued: boolean;
  hostSfuIngressTurnAttempted: boolean;
  healthyReselection: HealthySfuReselectionProbe | null;
  timer: NodeJS.Timeout;
}

interface ViewerRouteIntent {
  failedParentPeerId: string | null;
  failedParentSessionId?: string;
  failedConnectionId?: string;
  sessionId: string;
  sfuAttempts: number;
  selectedTurnAttempted?: boolean;
  unavailableReported: boolean;
  qualityGuard?: QualityRouteIntentGuard;
}

interface SelectedEdgeTurnAttempt {
  roomId: string;
  revision: number;
  shareGeneration: string;
  parentPeerId: string;
  parentSessionId: string;
  viewerPeerId: string;
  viewerSessionId: string;
  newConnectionId: string;
  answered: boolean;
  timer: NodeJS.Timeout;
}

interface SelectedSfuIngressAttempt {
  roomId: string;
  revision: number;
  shareGeneration: string;
  hostPeerId: string;
  hostSessionId: string;
  publicationGeneration: string;
  oldConnectionId: string;
  newConnectionId: string;
  answered: boolean;
  timer: NodeJS.Timeout;
}

interface ActiveSelectedSfuIngress {
  shareGeneration: string;
  hostPeerId: string;
  hostSessionId: string;
  publicationGeneration: string;
  connectionId: string;
}

interface HealthySfuReselectionProbe {
  activeRevision: number;
  shareGeneration: string;
  publicationGeneration: string;
  rootPeerId: string;
  parentPeerId: string;
}

interface QualityRouteIntentGuard {
  kind: ViewerQualityBadWindowKind;
  viewerSessionId: string;
  connectionId: string;
  routeRevision: number;
  parentPeerId: string;
  parentSessionId: string;
  exclusionOwnedByQuality: boolean;
}

type ViewerQualityBadWindowKind = "severe" | "relative-fps";

interface ViewerQualityEvidenceState {
  viewerSessionId: string;
  parentPeerId: string;
  parentSessionId: string;
  connectionId: string;
  routeRevision: number;
  lastCorrelatedAtMs: number | null;
  badWindowCount: number;
  badWindowKind: ViewerQualityBadWindowKind | null;
  lastCorrelatedFps: {
    correlatedAtMs: number;
    framesPerSecond: number | null;
  } | null;
  pendingViewerEvidence: {
    acceptedAtMs: number;
    evidence: Extract<ServerMessage, { type: "viewer-quality-evidence" }>;
  } | null;
}

interface ForwardedViewerQualityEvidence {
  roomId: string;
  viewerSessionId: string;
  parentSessionId: string;
  evidence: Extract<ServerMessage, { type: "viewer-quality-evidence" }>;
}

interface ForwardedParentEdgeQualityEvidence {
  roomId: string;
  viewerSessionId: string;
  parentSessionId: string;
  evidence: Extract<
    ClientMessage,
    { type: "parent-edge-quality-evidence" }
  >;
}

type SfuPrepareResult = "started" | "busy" | "unavailable";

export interface SfuFallbackOptions {
  url: string;
  tokenIssuer: SfuTokenIssuer;
  maxRoots: number;
  prepareTimeoutMs?: number;
}

export interface HybridMediaRouterOptions {
  roomStore: RoomStore;
  sfuFallback?: SfuFallbackOptions;
  selectedEdgeTurn?: SelectedEdgeTurnConfig;
  sendToSession: (sessionId: string, message: ServerMessage) => void;
  getConnectionId: (roomId: string, viewerPeerId: string) => string | undefined;
  deleteConnectionId: (roomId: string, viewerPeerId: string) => void;
  getShareGeneration: (roomId: string) => string | undefined;
  onActiveRouteChanged?: (roomId: string) => void;
  onViewerMediaState?: (
    roomId: string,
    viewerPeerId: string,
    viewerSessionId: string,
    revision: number,
    sfuPublicationGeneration: string,
    ready: boolean,
  ) => void;
  now?: () => number;
}

export interface HybridAuthenticationState {
  routeRevision: number;
  routeAssignment: ParticipantRouteAssignment;
  mediaAssignment: MediaAssignment;
  assignmentChanges: readonly MediaAssignmentChange[];
  activeRoute?: RoomMediaRoute;
}

export interface AuthenticatedRouteParticipant {
  roomId: string;
  role: Role;
  peerId: string;
  sessionId: string;
}

export class HybridMediaRouter {
  private readonly peerRelayTopology = new PeerRelayTopology();
  private readonly mediaRouteControllers = new Map<
    string,
    MediaRouteController
  >();
  private readonly pendingRoutePreparations = new Map<
    string,
    PendingRoutePreparation
  >();
  private readonly failedParentPeerIdsByViewer = new Map<
    string,
    Set<string>
  >();
  private readonly viewerRouteIntentsByRoom = new Map<
    string,
    Map<string, ViewerRouteIntent>
  >();
  private readonly consumedSfuRefreshesByRoom = new Map<string, Set<string>>();
  private readonly selectedEdgeTurnAttempts = new Map<
    string,
    SelectedEdgeTurnAttempt
  >();
  private readonly selectedSfuIngressAttempts = new Map<
    string,
    SelectedSfuIngressAttempt
  >();
  private readonly activeSelectedSfuIngresses = new Map<
    string,
    ActiveSelectedSfuIngress
  >();
  private readonly relayCapacitySessionsByRoom = new Map<
    string,
    Map<string, string>
  >();
  private readonly sfuDisabledRoomIds = new Set<string>();
  private readonly viewerQualityEvidenceStates = new Map<
    string,
    ViewerQualityEvidenceState
  >();
  private readonly heldQualityParentExclusionsByViewer = new Map<
    string,
    { parentPeerId: string; parentSessionId: string; expiresAtMs: number }
  >();
  private readonly roomQualityMigrationCooldownUntilMs = new Map<
    string,
    number
  >();

  constructor(private readonly options: HybridMediaRouterOptions) {
    const fallback = options.sfuFallback;
    if (options.selectedEdgeTurn && !fallback) {
      throw new Error("Selected-edge TURN requires SFU fallback");
    }
    if (!fallback) {
      return;
    }
    if (
      !Number.isSafeInteger(fallback.maxRoots) ||
      fallback.maxRoots < 1 ||
      fallback.maxRoots > Math.min(2, options.roomStore.maxViewersPerRoom) ||
      (fallback.prepareTimeoutMs !== undefined &&
        (!Number.isSafeInteger(fallback.prepareTimeoutMs) ||
          fallback.prepareTimeoutMs <= 0))
    ) {
      throw new Error("SFU fallback limits are invalid");
    }
    new URL(fallback.url);
  }

  close(): void {
    for (const pending of this.pendingRoutePreparations.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingRoutePreparations.clear();
    for (const attempt of this.selectedEdgeTurnAttempts.values()) {
      clearTimeout(attempt.timer);
    }
    this.selectedEdgeTurnAttempts.clear();
    for (const attempt of this.selectedSfuIngressAttempts.values()) {
      clearTimeout(attempt.timer);
    }
    this.selectedSfuIngressAttempts.clear();
    this.activeSelectedSfuIngresses.clear();
    this.mediaRouteControllers.clear();
    this.failedParentPeerIdsByViewer.clear();
    this.viewerRouteIntentsByRoom.clear();
    this.consumedSfuRefreshesByRoom.clear();
    this.relayCapacitySessionsByRoom.clear();
    this.sfuDisabledRoomIds.clear();
    this.viewerQualityEvidenceStates.clear();
    this.heldQualityParentExclusionsByViewer.clear();
    this.roomQualityMigrationCooldownUntilMs.clear();
  }

  connectParticipant(input: AuthenticatedRouteParticipant): HybridAuthenticationState {
    this.clearRoomViewerQualityEvidenceStates(input.roomId);
    this.clearHeldQualityParentExclusion(input.roomId, input.peerId);
    this.clearSfuRefreshesForPeer(input.roomId, input.peerId);
    if (input.role === "viewer") {
      const connectionKey = viewerConnectionKey(input.roomId, input.peerId);
      this.failedParentPeerIdsByViewer.delete(
        connectionKey,
      );
      this.viewerRouteIntentsByRoom.get(input.roomId)?.delete(input.peerId);
      this.relayCapacitySessionsByRoom.get(input.roomId)?.delete(input.peerId);
    }
    this.abortPendingRouteForTopologyChange(input.roomId, input.peerId);
    const assignmentChanges =
      input.role === "host"
        ? this.peerRelayTopology.setHost(
            input.roomId,
            input.peerId,
            this.connectedPeerIds(input.roomId),
          )
        : this.peerRelayTopology.addViewer(
            input.roomId,
            input.peerId,
            this.connectedPeerIds(input.roomId),
          );
    this.clearChangedConnectionIds(input.roomId, assignmentChanges);
    const controller = this.reconcileMediaRoute(input.roomId, input.peerId);
    const activeRoute = controller?.getActiveRoute();
    const routeAssignment =
      activeRoute?.assignments.get(input.peerId) ??
      participantRouteFromMediaAssignment(
        this.peerRelayTopology.getAssignment(input.roomId, input.peerId),
      );
    if (!routeAssignment) {
      throw new Error("Peer relay topology has no participant assignment");
    }
    return {
      routeRevision: activeRoute?.revision ?? 0,
      routeAssignment,
      mediaAssignment: mediaAssignmentFromParticipantRoute(routeAssignment),
      assignmentChanges,
      activeRoute,
    };
  }

  completeAuthentication(
    participant: AuthenticatedRouteParticipant,
    state: HybridAuthenticationState,
  ): void {
    const activeParentPeerId =
      state.routeAssignment.upstream.kind === "peer"
        ? state.routeAssignment.upstream.peerId
        : undefined;
    this.sendMediaAssignmentChanges(
      participant.roomId,
      state.assignmentChanges,
      participant.peerId,
    );
    if (
      participant.role === "viewer" &&
      activeParentPeerId &&
      !state.assignmentChanges.some(
        ({ peerId }) => peerId === activeParentPeerId,
      )
    ) {
      this.sendCurrentParentAssignment(participant.roomId, participant.peerId);
    }
    if (state.activeRoute?.sfu.publicationGeneration) {
      void this.sendFreshSfuConfig(
        participant.roomId,
        participant.peerId,
        participant.sessionId,
        state.activeRoute.revision,
      );
    }
    this.drainViewerRouteIntents(participant.roomId);
  }

  isActivePeerParentOf(
    roomId: string,
    parentPeerId: string,
    childPeerId: string,
  ): boolean {
    return (
      this.resolveActivePeerEdge(roomId, childPeerId)?.parentPeerId ===
      parentPeerId
    );
  }

  selectedEdgeTurnSignalAuthorization(input: {
    roomId: string;
    sourcePeerId: string;
    sourceSessionId: string;
    targetPeerId: string;
    targetSessionId: string;
    connectionId: string;
    signalKind: "candidate" | "description";
    descriptionType?: "offer" | "answer";
  }): boolean | undefined {
    const sourceKey = viewerConnectionKey(input.roomId, input.sourcePeerId);
    const targetKey = viewerConnectionKey(input.roomId, input.targetPeerId);
    const attempt =
      this.selectedEdgeTurnAttempts.get(sourceKey)?.parentPeerId ===
      input.targetPeerId
        ? this.selectedEdgeTurnAttempts.get(sourceKey)
        : this.selectedEdgeTurnAttempts.get(targetKey)?.parentPeerId ===
            input.sourcePeerId
          ? this.selectedEdgeTurnAttempts.get(targetKey)
          : undefined;
    if (!attempt) {
      const pending = this.pendingRoutePreparations.get(input.roomId);
      const probe = pending?.healthyReselection;
      const parentToRoot = probe?.parentPeerId === input.sourcePeerId &&
        probe.rootPeerId === input.targetPeerId;
      const rootToParent = probe?.rootPeerId === input.sourcePeerId &&
        probe.parentPeerId === input.targetPeerId;
      if (!pending || !probe || (!parentToRoot && !rootToParent)) {
        return undefined;
      }
      if (!this.healthySfuReselectionIsCurrent(input.roomId, pending)) {
        return false;
      }
      const connectionId = this.options.getConnectionId(input.roomId, probe.rootPeerId);
      return parentToRoot && input.descriptionType === "offer"
        ? connectionId === undefined
        : connectionId === input.connectionId &&
            (input.signalKind === "candidate" ||
              (rootToParent && input.descriptionType === "answer"));
    }
    const parentToViewer = input.sourcePeerId === attempt.parentPeerId;
    const currentRoute = this.mediaRouteControllers.get(input.roomId)?.getActiveRoute();
    return Boolean(
      input.connectionId === attempt.newConnectionId &&
      currentRoute?.revision === attempt.revision &&
      this.options.getShareGeneration(input.roomId) ===
        attempt.shareGeneration &&
      ((parentToViewer &&
        input.sourceSessionId === attempt.parentSessionId &&
        input.targetSessionId === attempt.viewerSessionId) ||
        (!parentToViewer &&
          input.sourceSessionId === attempt.viewerSessionId &&
          input.targetSessionId === attempt.parentSessionId)) &&
      (input.signalKind === "candidate" ||
        (!attempt.answered &&
          ((parentToViewer && input.descriptionType === "offer") ||
            (!parentToViewer && input.descriptionType === "answer"))))
    );
  }

  markSelectedEdgeTurnAnswered(
    roomId: string,
    viewerPeerId: string,
    connectionId: string,
  ): void {
    const attempt = this.selectedEdgeTurnAttempts.get(
      viewerConnectionKey(roomId, viewerPeerId),
    );
    if (attempt?.newConnectionId === connectionId) {
      attempt.answered = true;
      clearTimeout(attempt.timer);
    }
  }

  resolveActivePeerEdge(
    roomId: string,
    childPeerId: string,
  ): { revision: number; parentPeerId: string } | undefined {
    const controller = this.mediaRouteControllers.get(roomId);
    if (!controller) {
      return undefined;
    }
    const active = controller.getActiveRoute();
    const assignments = active.assignments;
    const child = assignments.get(childPeerId);
    if (
      child?.upstream.kind !== "peer" ||
      assignments
        .get(child.upstream.peerId)
        ?.childPeerIds.includes(childPeerId) !== true
    ) {
      return undefined;
    }
    return {
      revision: active.revision,
      parentPeerId: child.upstream.peerId,
    };
  }

  getViewerRouteUpstream(
    roomId: string,
    viewerPeerId: string,
  ): MediaRouteUpstream {
    const assignment = this.mediaRouteControllers
      .get(roomId)
      ?.getActiveRoute()
      .assignments.get(viewerPeerId);
    if (!assignment || assignment.upstream.kind === "none") {
      return { kind: "none" };
    }
    if (assignment.upstream.kind === "peer") {
      return { kind: "peer", peerId: assignment.upstream.peerId };
    }
    return { kind: "sfu" };
  }

  viewerSfuMediaStateIsCurrent(
    roomId: string,
    viewerPeerId: string,
    revision: number,
    sfuPublicationGeneration: string,
  ): boolean {
    const active = this.mediaRouteControllers.get(roomId)?.getActiveRoute();
    return Boolean(
      active?.revision === revision &&
        active.assignments.get(viewerPeerId)?.upstream.kind === "sfu" &&
        active.sfu.publicationGeneration === sfuPublicationGeneration,
    );
  }

  handleViewerQualityEvidence(input: ForwardedViewerQualityEvidence): void {
    const { evidence, roomId, viewerSessionId, parentSessionId } = input;
    const { viewerPeerId, parentPeerId } = evidence;
    const viewer = this.options.roomStore.getConnectedViewer(
      roomId,
      viewerPeerId,
    );
    const parent = this.connectedPeer(roomId, parentPeerId);
    const edge = this.resolveActivePeerEdge(roomId, viewerPeerId);
    if (
      viewer?.sessionId !== viewerSessionId ||
      parent?.sessionId !== parentSessionId ||
      edge?.parentPeerId !== parentPeerId ||
      edge.revision !== evidence.guard.routeRevision ||
      this.options.getConnectionId(roomId, viewerPeerId) !==
        evidence.guard.connectionId
    ) {
      return;
    }

    const connectionKey = viewerConnectionKey(roomId, viewerPeerId);
    const existingIntent = this.viewerRouteIntentsByRoom
      .get(roomId)
      ?.get(viewerPeerId);
    if (
      existingIntent?.qualityGuard &&
      !this.qualityIntentIsCurrent(roomId, viewerPeerId, existingIntent)
    ) {
      this.discardQualityIntent(roomId, viewerPeerId, existingIntent);
    }
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isFinite(now)) {
      return;
    }
    const previous = this.viewerQualityEvidenceStates.get(connectionKey);
    const sameIdentity =
      previous?.viewerSessionId === viewerSessionId &&
      previous.parentPeerId === parentPeerId &&
      previous.parentSessionId === parentSessionId &&
      previous.connectionId === evidence.guard.connectionId &&
      previous.routeRevision === evidence.guard.routeRevision;
    const canContinueStreak =
      sameIdentity &&
      previous !== undefined &&
      previous.pendingViewerEvidence === null &&
      previous.lastCorrelatedAtMs !== null &&
      now - previous.lastCorrelatedAtMs <= VIEWER_QUALITY_EVIDENCE_GAP_MS;
    this.viewerQualityEvidenceStates.set(connectionKey, {
      viewerSessionId,
      parentPeerId,
      parentSessionId,
      connectionId: evidence.guard.connectionId,
      routeRevision: evidence.guard.routeRevision,
      lastCorrelatedAtMs: canContinueStreak
        ? previous.lastCorrelatedAtMs
        : null,
      badWindowCount: canContinueStreak ? previous.badWindowCount : 0,
      badWindowKind: canContinueStreak ? previous.badWindowKind : null,
      lastCorrelatedFps: sameIdentity
        ? previous?.lastCorrelatedFps ?? null
        : null,
      pendingViewerEvidence: { acceptedAtMs: now, evidence },
    });
  }

  handleParentEdgeQualityEvidence(
    input: ForwardedParentEdgeQualityEvidence,
  ): void {
    const { evidence, roomId, viewerSessionId, parentSessionId } = input;
    const viewerPeerId = evidence.viewerPeerId;
    const viewer = this.options.roomStore.getConnectedViewer(
      roomId,
      viewerPeerId,
    );
    const edge = this.resolveActivePeerEdge(roomId, viewerPeerId);
    const parent = edge
      ? this.connectedPeer(roomId, edge.parentPeerId)
      : undefined;
    if (
      viewer?.sessionId !== viewerSessionId ||
      parent?.sessionId !== parentSessionId ||
      edge?.revision !== evidence.guard.routeRevision ||
      this.options.getConnectionId(roomId, viewerPeerId) !==
        evidence.guard.connectionId
    ) {
      return;
    }

    const connectionKey = viewerConnectionKey(roomId, viewerPeerId);
    const state = this.viewerQualityEvidenceStates.get(connectionKey);
    const pending = state?.pendingViewerEvidence;
    if (
      !state ||
      !pending ||
      state.viewerSessionId !== viewerSessionId ||
      state.parentPeerId !== edge.parentPeerId ||
      state.parentSessionId !== parentSessionId ||
      state.connectionId !== evidence.guard.connectionId ||
      state.routeRevision !== evidence.guard.routeRevision ||
      pending.evidence.sequence !== evidence.viewerSequence
    ) {
      return;
    }
    state.pendingViewerEvidence = null;

    const now = this.options.now?.() ?? Date.now();
    if (
      !Number.isFinite(now) ||
      now < pending.acceptedAtMs ||
      now - pending.acceptedAtMs > VIEWER_QUALITY_EVIDENCE_GAP_MS
    ) {
      state.badWindowCount = 0;
      state.badWindowKind = null;
      state.lastCorrelatedAtMs = null;
      return;
    }
    state.lastCorrelatedFps = {
      correlatedAtMs: now,
      framesPerSecond: pending.evidence.metrics.framesPerSecond,
    };
    const cooldownUntil = this.roomQualityMigrationCooldownUntilMs.get(roomId);
    if (cooldownUntil !== undefined && now < cooldownUntil) {
      state.badWindowCount = 0;
      state.badWindowKind = null;
      state.lastCorrelatedAtMs = now;
      return;
    }
    if (cooldownUntil !== undefined) {
      this.roomQualityMigrationCooldownUntilMs.delete(roomId);
    }
    const existingIntent = this.viewerRouteIntentsByRoom
      .get(roomId)
      ?.get(viewerPeerId);
    this.pruneHeldQualityParentExclusion(roomId, viewerPeerId, now);
    const failedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    if (existingIntent || failedParents?.has(edge.parentPeerId)) {
      state.badWindowCount = 0;
      state.badWindowKind = null;
      state.lastCorrelatedAtMs = now;
      return;
    }

    const hardParentProof = isHardBadParentEdgeQualityProof(evidence.proof);
    const badWindowKind = !hardParentProof
      ? null
      : isHardBadViewerQualityWindow(pending.evidence)
        ? "severe"
        : this.isHardBadRelativeRelayFpsWindow(
              roomId,
              edge.parentPeerId,
              parentSessionId,
              pending.evidence,
              now,
            )
          ? "relative-fps"
          : null;
    state.badWindowCount = badWindowKind
      ? state.badWindowKind === badWindowKind &&
        state.lastCorrelatedAtMs !== null &&
        now - state.lastCorrelatedAtMs <= VIEWER_QUALITY_EVIDENCE_GAP_MS
        ? state.badWindowCount + 1
        : 1
      : 0;
    state.badWindowKind = badWindowKind;
    state.lastCorrelatedAtMs = now;
    if (state.badWindowCount < VIEWER_QUALITY_BAD_WINDOWS_TO_REASSIGN) {
      return;
    }

    let roomIntents = this.viewerRouteIntentsByRoom.get(roomId);
    if (!roomIntents) {
      roomIntents = new Map();
      this.viewerRouteIntentsByRoom.set(roomId, roomIntents);
    }
    let excludedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    if (!excludedParents) {
      excludedParents = new Set();
      this.failedParentPeerIdsByViewer.set(connectionKey, excludedParents);
    }
    excludedParents.add(edge.parentPeerId);
    roomIntents.set(viewerPeerId, {
      failedParentPeerId: edge.parentPeerId,
      sessionId: viewerSessionId,
      sfuAttempts: 0,
      unavailableReported: false,
      qualityGuard: {
        kind: badWindowKind!,
        viewerSessionId,
        connectionId: evidence.guard.connectionId,
        routeRevision: evidence.guard.routeRevision,
        parentPeerId: edge.parentPeerId,
        parentSessionId,
        exclusionOwnedByQuality: true,
      },
    });
    this.viewerQualityEvidenceStates.delete(connectionKey);
    this.drainViewerRouteIntents(roomId);
  }

  private isHardBadRelativeRelayFpsWindow(
    roomId: string,
    parentPeerId: string,
    parentSessionId: string,
    childEvidence: Extract<
      ServerMessage,
      { type: "viewer-quality-evidence" }
    >,
    now: number,
  ): boolean {
    const parentState = this.viewerQualityEvidenceStates.get(
      viewerConnectionKey(roomId, parentPeerId),
    );
    const correlated = parentState?.lastCorrelatedFps;
    const parentEdge = this.resolveActivePeerEdge(roomId, parentPeerId);
    if (
      this.options.roomStore.getConnectedViewer(roomId, parentPeerId)
        ?.sessionId !== parentSessionId ||
      !parentState ||
      !correlated ||
      parentState.viewerSessionId !== parentSessionId ||
      parentEdge?.parentPeerId !== parentState.parentPeerId ||
      parentEdge.revision !== parentState.routeRevision ||
      this.options.getConnectionId(roomId, parentPeerId) !==
        parentState.connectionId ||
      now < correlated.correlatedAtMs ||
      now - correlated.correlatedAtMs > VIEWER_QUALITY_EVIDENCE_GAP_MS
    ) {
      return false;
    }
    const childFps = childEvidence.metrics.framesPerSecond;
    const parentInboundFps = correlated.framesPerSecond;
    return (
      childFps !== null &&
      parentInboundFps !== null &&
      parentInboundFps > 0 &&
      childFps < parentInboundFps * VIEWER_QUALITY_RELAY_FPS_RATIO
    );
  }

  setViewerRelayCapacity(
    participant: AuthenticatedRouteParticipant,
    downstreamEdges: RelayDownstreamEdges,
  ): void {
    if (participant.role !== "viewer") {
      return;
    }
    let advertised = this.relayCapacitySessionsByRoom.get(participant.roomId);
    if (!advertised) {
      advertised = new Map();
      this.relayCapacitySessionsByRoom.set(participant.roomId, advertised);
    }
    advertised.set(participant.peerId, participant.sessionId);
    const controller = this.mediaRouteControllers.get(participant.roomId);
    const active = controller?.getActiveRoute();
    const routeIntent = this.viewerRouteIntentsByRoom
      .get(participant.roomId)
      ?.get(participant.peerId);
    const allowAdmissionRescue =
      downstreamEdges > 0 &&
      active?.sfu.publicationGeneration === null &&
      active.assignments.get(participant.peerId)?.upstream.kind === "none" &&
      controller?.getPendingRoute() === undefined &&
      !this.pendingRoutePreparations.has(participant.roomId) &&
      (routeIntent === undefined || routeIntent.failedParentPeerId === null) &&
      !this.failedParentPeerIdsByViewer.get(
        viewerConnectionKey(participant.roomId, participant.peerId),
      )?.size;
    const changes = this.peerRelayTopology.setViewerRelayCapacity(
      participant.roomId,
      participant.peerId,
      downstreamEdges,
      this.connectedPeerIds(participant.roomId),
      { rescueUnassignedRelay: allowAdmissionRescue },
    );
    if (changes.length > 0) {
      this.clearChangedConnectionIds(participant.roomId, changes);
      this.reconcileMediaRoute(participant.roomId);
      this.sendMediaAssignmentChanges(participant.roomId, changes);
    }
    const assignment = this.mediaRouteControllers
      .get(participant.roomId)
      ?.getActiveRoute()
      .assignments.get(participant.peerId);
    let roomIntents = this.viewerRouteIntentsByRoom.get(participant.roomId);
    if (assignment?.upstream.kind === "none") {
      if (!roomIntents) {
        roomIntents = new Map();
        this.viewerRouteIntentsByRoom.set(participant.roomId, roomIntents);
      }
      const existing = roomIntents.get(participant.peerId);
      if (
        existing?.sessionId !== participant.sessionId ||
        existing.failedParentPeerId !== null
      ) {
        roomIntents.set(participant.peerId, {
          failedParentPeerId: null,
          sessionId: participant.sessionId,
          sfuAttempts: 0,
          unavailableReported: false,
        });
      }
    } else if (
      roomIntents?.get(participant.peerId)?.failedParentPeerId === null
    ) {
      roomIntents.delete(participant.peerId);
    }
    this.drainViewerRouteIntents(participant.roomId);
  }

  handleHealthySfuReselection(
    participant: AuthenticatedRouteParticipant,
    revision: number,
  ): void {
    const roomId = participant.roomId;
    const controller = this.mediaRouteControllers.get(roomId);
    const active = controller?.getActiveRoute();
    const publicationGeneration = active?.sfu.publicationGeneration;
    const shareGeneration = this.options.getShareGeneration(roomId);
    if (
      participant.role !== "viewer" ||
      !controller ||
      controller.getPendingRoute() ||
      this.roomPeerMigrationAttempt(roomId) !== null ||
      active?.revision !== revision ||
      active.sfu.rootPeerIds.length !== 1 ||
      active.sfu.rootPeerIds[0] !== participant.peerId ||
      !publicationGeneration ||
      !shareGeneration
    ) {
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    if (
      !Number.isFinite(now) ||
      (this.roomQualityMigrationCooldownUntilMs.get(roomId) ?? 0) > now
    ) {
      return;
    }
    this.startRoomQualityMigrationCooldown(roomId);
    const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
    const parentPeerId = this.peerRelayTopology.getAssignment(
      roomId,
      participant.peerId,
    )?.parentPeerId;
    if (!hostPeerId || !parentPeerId) {
      return;
    }
    const host = this.connectedPeer(roomId, hostPeerId);
    const parent = this.connectedPeer(roomId, parentPeerId);
    const activeParent = active.assignments.get(parentPeerId);
    const capacity = Math.min(
      this.peerRelayTopology.getDownstreamCapacity(roomId, parentPeerId),
      parentPeerId === hostPeerId ? 2 : 1,
    );
    if (
      !host ||
      !parent ||
      !activeParent ||
      activeParent.childPeerIds.length +
          (activeParent.sfuPublicationGeneration ? 1 : 0) +
          1 >
        capacity ||
      (parentPeerId !== hostPeerId &&
        this.relayCapacitySessionsByRoom.get(roomId)?.get(parentPeerId) !==
          parent.sessionId)
    ) {
      return;
    }
    const assignments = participantRoutesFromTopology(
      this.peerRelayTopology.getAssignments(roomId),
      hostPeerId,
      null,
      [],
    );
    const rootAssignment = assignments.get(participant.peerId)!;
    const parentAssignment = assignments.get(parentPeerId)!;
    let pendingRevision: number | undefined;
    try {
      pendingRevision = controller.prepare({
        assignments,
        expectedParticipantIds: new Set([participant.peerId]),
      });
    } catch {
      return;
    }
    if (pendingRevision === undefined) {
      return;
    }
    const timer = setTimeout(
      () => this.abortPendingRoute(roomId),
      this.options.sfuFallback?.prepareTimeoutMs ??
        DEFAULT_SFU_PREPARE_TIMEOUT_MS,
    );
    timer.unref();
    this.options.deleteConnectionId(roomId, participant.peerId);
    this.pendingRoutePreparations.set(roomId, {
      revision: pendingRevision,
      intentPeerId: participant.peerId,
      routeIntent: {
        failedParentPeerId: null,
        sessionId: participant.sessionId,
        sfuAttempts: 0,
        unavailableReported: false,
      },
      qualityIntent: null,
      expectedSessionIds: new Map([
        [participant.peerId, participant.sessionId],
        [parentPeerId, parent.sessionId],
        [hostPeerId, host.sessionId],
      ]),
      grantsIssued: true,
      hostSfuIngressTurnAttempted: false,
      healthyReselection: {
        activeRevision: revision,
        shareGeneration,
        publicationGeneration,
        rootPeerId: participant.peerId,
        parentPeerId,
      },
      timer,
    });
    for (const [sessionId, assignment] of [
      [participant.sessionId, rootAssignment],
      [parent.sessionId, parentAssignment],
    ] as const) {
      this.options.sendToSession(sessionId, {
        type: "route-update",
        revision: pendingRevision,
        phase: "prepare",
        assignment,
      });
    }
  }

  handleRouteReady(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-ready" }>,
  ): void {
    const controller = this.mediaRouteControllers.get(participant.roomId);
    if (!controller) {
      return;
    }
    if (message.phase === "active") {
      if (participant.role === "viewer") {
        this.notifyViewerMediaState(participant, message.revision, true);
        return;
      }
      const active = controller.getActiveRoute();
      if (
        active.revision === message.revision &&
        active.assignments.has(participant.peerId)
      ) {
        if (participant.role === "host") {
          this.markSelectedSfuIngressAnswered(
            participant.roomId,
            participant.peerId,
            participant.sessionId,
            message.revision,
          );
        }
        return;
      }
      return;
    }

    const pending = this.pendingRoutePreparations.get(participant.roomId);
    const pendingRoute = controller.getPendingRoute();
    if (
      !pending ||
      !pendingRoute ||
      pending.revision !== message.revision ||
      pendingRoute.route.revision !== message.revision ||
      !pending.grantsIssued
    ) {
      return;
    }
    const healthy = pending.healthyReselection;
    if (healthy) {
      const current = this.healthySfuReselectionIsCurrent(participant.roomId, pending);
      if (
        participant.peerId !== healthy.rootPeerId ||
        !this.options.getConnectionId(participant.roomId, healthy.rootPeerId) ||
        !current
      ) {
        if (!current) {
          this.abortPendingRoute(participant.roomId);
        }
        return;
      }
    }
    const expectedSessionId = pending.expectedSessionIds.get(participant.peerId);
    if (!expectedSessionId) {
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "Participant is not part of this route plan",
      );
      return;
    }
    if (participant.sessionId !== expectedSessionId) {
      return;
    }

    if (participant.role === "host") {
      this.markSelectedSfuIngressAnswered(
        participant.roomId,
        participant.peerId,
        participant.sessionId,
        message.revision,
      );
    }

    controller.ready(participant.peerId, message.revision, "prepare");
    this.commitPendingRoute(participant.roomId, message.revision);
  }

  handleRouteMediaUnavailable(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-media-unavailable" }>,
  ): void {
    this.notifyViewerMediaState(participant, message.revision, false);
  }

  private notifyViewerMediaState(
    participant: AuthenticatedRouteParticipant,
    revision: number,
    ready: boolean,
  ): void {
    if (
      participant.role !== "viewer" ||
      this.connectedPeer(participant.roomId, participant.peerId)?.sessionId !==
        participant.sessionId
    ) {
      return;
    }
    const active = this.mediaRouteControllers
      .get(participant.roomId)
      ?.getActiveRoute();
    const assignment = active?.assignments.get(participant.peerId);
    if (
      !active ||
      active.revision !== revision ||
      assignment?.upstream.kind !== "sfu" ||
      active.sfu.publicationGeneration === null
    ) {
      return;
    }
    this.options.onViewerMediaState?.(
      participant.roomId,
      participant.peerId,
      participant.sessionId,
      revision,
      active.sfu.publicationGeneration,
      ready,
    );
  }

  handleRouteFailed(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-failed" }>,
  ): void {
    const healthyPending = this.pendingRoutePreparations.get(participant.roomId);
    const healthy = healthyPending?.healthyReselection;
    const ownsHealthyActiveSfu = healthyPending
      ? this.ownsActiveSfuForHealthyReselection(participant, healthyPending)
      : false;
    if (
      message.phase === "active" &&
      healthy?.activeRevision === message.revision &&
      ownsHealthyActiveSfu
    ) {
      this.abortPendingRoute(participant.roomId);
      const rollbackRevision = this.mediaRouteControllers
        .get(participant.roomId)
        ?.getActiveRoute().revision;
      if (rollbackRevision === undefined) {
        return;
      }
      message = { ...message, revision: rollbackRevision };
    }
    if (
      message.phase === "prepare" &&
      healthyPending?.revision === message.revision &&
      healthy
    ) {
      if (!ownsHealthyActiveSfu) {
        return;
      }
      const activeIngress = this.activeSelectedSfuIngresses.get(
        participant.roomId,
      );
      const hasCurrentSelectedHostIngress =
        participant.role === "host" &&
        activeIngress?.hostPeerId === participant.peerId &&
        activeIngress.hostSessionId === participant.sessionId &&
        activeIngress.shareGeneration === healthy.shareGeneration &&
        activeIngress.publicationGeneration ===
          healthy.publicationGeneration;
      const activeSfuTransportFailed = hasCurrentSelectedHostIngress
        ? activeIngress.connectionId === message.connectionId
        : message.connectionId === null;
      if (activeSfuTransportFailed) {
        if (participant.role === "host") {
          this.activeSelectedSfuIngresses.delete(participant.roomId);
        }
        this.abortPendingRoute(participant.roomId, undefined, false);
        return;
      }
      if (
        participant.role === "viewer" &&
        participant.peerId === healthy.rootPeerId &&
        message.connectionId ===
          this.options.getConnectionId(participant.roomId, healthy.rootPeerId)
      ) {
        this.abortPendingRoute(participant.roomId);
      }
      return;
    }
    if (message.phase === "prepare") {
      this.handlePrepareRouteFailed(participant, message);
      return;
    }
    const controller = this.mediaRouteControllers.get(participant.roomId);
    const active = controller?.getActiveRoute();
    if (!controller || !active || active.revision !== message.revision) {
      return;
    }
    if (message.connectionId === null) {
      const assignment = active.assignments.get(participant.peerId);
      const hostOwnsGeneration =
        participant.role === "host" &&
        active.sfu.publicationGeneration !== null &&
        assignment?.sfuPublicationGeneration ===
          active.sfu.publicationGeneration;
      const isSfuRoot =
        assignment?.upstream.kind === "sfu" &&
        active.sfu.rootPeerIds.includes(participant.peerId);
      if (!hostOwnsGeneration && !isSfuRoot) {
        this.sendError(
          participant.sessionId,
          "FORBIDDEN",
          "Participant does not own an active SFU route",
        );
        return;
      }
      if (
        hostOwnsGeneration &&
        this.startSelectedSfuIngressTurn(
          participant.roomId,
          participant.peerId,
          participant.sessionId,
          active,
        )
      ) {
        return;
      }
      if (
        isSfuRoot &&
        participant.role === "viewer" &&
        this.startSelectedEdgeTurn(participant.roomId, participant.peerId, true)
      ) {
        return;
      }
      this.failBackToPeerBaseline(participant.roomId);
      return;
    }
    if (this.finishSelectedEdgeTurnFailure(participant, message)) {
      return;
    }
    if (participant.role !== "viewer") {
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "Only an active viewer route may fail",
      );
      return;
    }
    const assignment = active.assignments.get(participant.peerId);
    if (!assignment) {
      return;
    }
    if (assignment.upstream.kind !== "peer") {
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "The active route has no peer edge to recover",
      );
      return;
    }
    const connectionKey = viewerConnectionKey(
      participant.roomId,
      participant.peerId,
    );
    if (
      this.options.getConnectionId(participant.roomId, participant.peerId) !==
      message.connectionId
    ) {
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    this.pruneHeldQualityParentExclusion(
      participant.roomId,
      participant.peerId,
      now,
    );
    const heldQualityParent =
      this.heldQualityParentExclusionsByViewer.get(connectionKey);
    const heldQualityFailure =
      heldQualityParent?.parentPeerId === assignment.upstream.peerId;
    if (heldQualityFailure) {
      this.heldQualityParentExclusionsByViewer.delete(connectionKey);
    } else if (heldQualityParent) {
      this.clearHeldQualityParentExclusion(
        participant.roomId,
        participant.peerId,
      );
    }

    let failedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    if (!failedParents) {
      failedParents = new Set();
      this.failedParentPeerIdsByViewer.set(connectionKey, failedParents);
    }
    if (
      failedParents.has(assignment.upstream.peerId) &&
      !heldQualityFailure
    ) {
      const existingIntent = this.viewerRouteIntentsByRoom
        .get(participant.roomId)
        ?.get(participant.peerId);
      if (
        existingIntent?.qualityGuard?.parentPeerId ===
        assignment.upstream.peerId
      ) {
        const pending = this.pendingRoutePreparations.get(participant.roomId);
        if (
          pending?.intentPeerId === participant.peerId &&
          pending.routeIntent === existingIntent &&
          pending.qualityIntent
        ) {
          pending.qualityIntent.takenOverByRouteFailure = true;
        }
        existingIntent.qualityGuard.exclusionOwnedByQuality = false;
        existingIntent.qualityGuard = undefined;
      }
      return;
    }
    failedParents.add(assignment.upstream.peerId);
    let roomIntents = this.viewerRouteIntentsByRoom.get(participant.roomId);
    if (!roomIntents) {
      roomIntents = new Map();
      this.viewerRouteIntentsByRoom.set(participant.roomId, roomIntents);
    }
    roomIntents.set(participant.peerId, {
      failedParentPeerId: assignment.upstream.peerId,
      failedParentSessionId: this.connectedPeer(
        participant.roomId,
        assignment.upstream.peerId,
      )?.sessionId,
      failedConnectionId: message.connectionId,
      sessionId: participant.sessionId,
      sfuAttempts: 0,
      unavailableReported: false,
    });
    this.drainViewerRouteIntents(participant.roomId);
  }

  refreshSfu(
    participant: AuthenticatedRouteParticipant,
    revision: number,
  ): void {
    void this.sendFreshSfuConfig(
      participant.roomId,
      participant.peerId,
      participant.sessionId,
      revision,
      true,
      true,
    );
  }

  disconnectParticipant(roomId: string, peerId: string): void {
    this.clearSelectedEdgeTurnsForParticipant(roomId, peerId);
    this.clearViewerQualityStateForParticipant(roomId, peerId);
    const pending = this.pendingRoutePreparations.get(roomId);
    if (!pending || this.pendingSessionsAreCurrent(roomId, pending)) {
      return;
    }
    this.abortPendingRouteForTopologyChange(roomId);
  }

  removeViewer(roomId: string, peerId: string): void {
    this.clearSelectedEdgeTurnsForParticipant(roomId, peerId);
    this.clearViewerQualityStateForParticipant(roomId, peerId);
    this.abortPendingRouteForTopologyChange(roomId);
    const changes = this.peerRelayTopology.removeViewer(
      roomId,
      peerId,
      this.connectedPeerIds(roomId),
    );
    this.clearChangedConnectionIds(roomId, changes);
    this.reconcileMediaRoute(roomId);
    this.sendMediaAssignmentChanges(roomId, changes);
    this.failedParentPeerIdsByViewer.delete(viewerConnectionKey(roomId, peerId));
    this.viewerRouteIntentsByRoom.get(roomId)?.delete(peerId);
    this.relayCapacitySessionsByRoom.get(roomId)?.delete(peerId);
    this.clearSfuRefreshesForPeer(roomId, peerId);
    this.drainViewerRouteIntents(roomId);
  }

  stopRoom(roomId: string): void {
    this.clearRoomMediaRouteState(roomId);
  }

  deleteRoom(roomId: string): void {
    this.peerRelayTopology.deleteRoom(roomId);
    this.relayCapacitySessionsByRoom.delete(roomId);
    this.clearRoomMediaRouteState(roomId);
  }

  private handlePrepareRouteFailed(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-failed" }>,
  ): void {
    const controller = this.mediaRouteControllers.get(participant.roomId);
    const pending = this.pendingRoutePreparations.get(participant.roomId);
    const pendingRoute = controller?.getPendingRoute();
    if (
      !controller ||
      !pending ||
      !pendingRoute ||
      pending.revision !== message.revision ||
      pendingRoute.route.revision !== message.revision ||
      !pending.grantsIssued
    ) {
      return;
    }
    const expectedSessionId = pending.expectedSessionIds.get(participant.peerId);
    if (!expectedSessionId) {
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "Participant is not part of this route plan",
      );
      return;
    }
    if (participant.sessionId !== expectedSessionId) {
      return;
    }
    const publicationGeneration = pendingRoute.route.sfu.publicationGeneration;
    const hostOwnsPendingPublication =
      participant.role === "host" &&
      participant.peerId ===
        this.peerRelayTopology.getHostPeerId(participant.roomId) &&
      publicationGeneration !== null &&
      pendingRoute.route.assignments.get(participant.peerId)
        ?.sfuPublicationGeneration === publicationGeneration;
    if (message.connectionId !== null) {
      if (
        hostOwnsPendingPublication &&
        this.finishSelectedEdgeTurnFailure(participant, message)
      ) {
        return;
      }
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "Prepare failure connection is not the selected SFU ingress",
      );
      return;
    }
    if (
      hostOwnsPendingPublication &&
      (pending.hostSfuIngressTurnAttempted ||
        this.startSelectedSfuIngressTurn(
          participant.roomId,
          participant.peerId,
          participant.sessionId,
          pendingRoute.route,
          pending,
        ))
    ) {
      return;
    }
    this.abortPendingRoute(participant.roomId);
  }

  private roomPeerMigrationAttempt(
    roomId: string,
  ): "healthy" | "selected" | null {
    if (this.pendingRoutePreparations.get(roomId)?.healthyReselection) {
      return "healthy";
    }
    return [...this.selectedEdgeTurnAttempts.values()].some(
      (attempt) => attempt.roomId === roomId,
    )
      ? "selected"
      : null;
  }

  private startSelectedEdgeTurn(
    roomId: string,
    viewerPeerId: string,
    requireConsumedSfuRefresh: boolean,
  ): boolean {
    const config = this.options.selectedEdgeTurn;
    const controller = this.mediaRouteControllers.get(roomId);
    const active = controller?.getActiveRoute();
    const intent = this.viewerRouteIntentsByRoom.get(roomId)?.get(viewerPeerId);
    const key = viewerConnectionKey(roomId, viewerPeerId);
    const roomAttempt = this.roomPeerMigrationAttempt(roomId);
    if (roomAttempt === "healthy") {
      // The healthy probe already owns recovery, so suppress active-route failback.
      return true;
    }
    if (this.selectedEdgeTurnAttempts.has(key)) {
      return true;
    }
    if (roomAttempt === "selected") {
      return false;
    }
    if (
      !config ||
      !active ||
      !intent ||
      intent.selectedTurnAttempted ||
      !intent.failedParentPeerId ||
      !intent.failedParentSessionId ||
      !intent.failedConnectionId
    ) {
      return false;
    }
    const viewer = this.options.roomStore.getConnectedViewer(
      roomId,
      viewerPeerId,
    );
    const parent = this.connectedPeer(roomId, intent.failedParentPeerId);
    const shareGeneration = this.options.getShareGeneration(roomId);
    const parentAssignment = active.assignments.get(intent.failedParentPeerId);
    const parentChildLimit = this.peerRelayTopology.getDownstreamCapacity(
      roomId,
      intent.failedParentPeerId,
    );
    if (
      viewer?.sessionId !== intent.sessionId ||
      parent?.sessionId !== intent.failedParentSessionId ||
      !parentAssignment ||
      (parentAssignment.childPeerIds.length +
          (parentAssignment.sfuPublicationGeneration ? 1 : 0) >=
        parentChildLimit &&
        !parentAssignment.childPeerIds.includes(viewerPeerId)) ||
      !shareGeneration
    ) {
      return false;
    }
    if (requireConsumedSfuRefresh) {
      const publicationGeneration = active.sfu.publicationGeneration;
      if (
        !publicationGeneration ||
        !active.sfu.rootPeerIds.includes(viewerPeerId) ||
        !this.consumedSfuRefreshesByRoom
          .get(roomId)
          ?.has(
            sfuRefreshKey(
              publicationGeneration,
              viewerPeerId,
              viewer.sessionId,
            ),
          )
      ) {
        return false;
      }
    }

    intent.selectedTurnAttempted = true;
    const newConnectionId = randomBytes(16).toString("base64url");
    let credential;
    try {
      credential = issueSelectedEdgeTurnCredential(
        config,
        {
          edgeKind: "peer-selected",
          roomId,
          shareGeneration,
          revision: active.revision,
          parentPeerId: parent.peerId,
          parentSessionId: parent.sessionId,
          viewerPeerId,
          viewerSessionId: viewer.sessionId,
          oldConnectionId: intent.failedConnectionId,
          newConnectionId,
        },
        this.options.now?.() ?? Date.now(),
      );
    } catch {
      console.error("Selected-edge TURN credential issuance failed");
      return false;
    }

    const timer = setTimeout(() => {
      const current = this.selectedEdgeTurnAttempts.get(key);
      if (
        !current ||
        current.newConnectionId !== newConnectionId ||
        current.answered
      ) {
        return;
      }
      this.selectedEdgeTurnAttempts.delete(key);
      this.sendError(
        current.viewerSessionId,
        "PEER_NOT_FOUND",
        "Selected relay edge timed out",
      );
    }, SELECTED_EDGE_TURN_ATTEMPT_TIMEOUT_MS);
    timer.unref();
    const attempt: SelectedEdgeTurnAttempt = {
      roomId,
      revision: active.revision,
      shareGeneration,
      parentPeerId: parent.peerId,
      parentSessionId: parent.sessionId,
      viewerPeerId,
      viewerSessionId: viewer.sessionId,
      newConnectionId,
      answered: false,
      timer,
    };
    this.selectedEdgeTurnAttempts.set(key, attempt);
    const message: Extract<ServerMessage, { type: "selected-edge-turn" }> = {
      type: "selected-edge-turn",
      edgeKind: "peer-selected",
      revision: attempt.revision,
      parentPeerId: attempt.parentPeerId,
      viewerPeerId,
      oldConnectionId: intent.failedConnectionId,
      newConnectionId,
      expiresAt: credential.expiresAt,
      iceServer: credential.iceServer,
    };
    // Queue the Viewer grant first. Any parent offer is handled on a later
    // event-loop turn, so the Viewer's socket observes this grant first.
    this.options.sendToSession(viewer.sessionId, message);
    this.options.sendToSession(parent.sessionId, message);
    return true;
  }

  /**
   * Source-side fallback for a configured hybrid room. This is a LiveKit
   * publisher ICE override, not an ordinary peer candidate or a
   * participant-wide TURN grant.
   */
  private startSelectedSfuIngressTurn(
    roomId: string,
    hostPeerId: string,
    hostSessionId: string,
    route: RoomMediaRoute,
    pending?: PendingRoutePreparation,
  ): boolean {
    const config = this.options.selectedEdgeTurn;
    const fallback = this.options.sfuFallback;
    const key = roomId;
    const currentAttempt = this.selectedSfuIngressAttempts.get(key);
    if (currentAttempt) {
      return (
        currentAttempt.revision === route.revision &&
        currentAttempt.hostPeerId === hostPeerId &&
        currentAttempt.hostSessionId === hostSessionId &&
        currentAttempt.publicationGeneration ===
          route.sfu.publicationGeneration &&
        currentAttempt.shareGeneration ===
          this.options.getShareGeneration(roomId)
      );
    }
    if (
      !config ||
      !fallback ||
      (pending !== undefined &&
        (pending.revision !== route.revision ||
          pending.hostSfuIngressTurnAttempted ||
          pending.expectedSessionIds.get(hostPeerId) !== hostSessionId))
    ) {
      return false;
    }
    const revision = route.revision;
    const publicationGeneration = route.sfu.publicationGeneration;
    const assignment = route.assignments.get(hostPeerId);
    const host = this.connectedPeer(roomId, hostPeerId);
    const shareGeneration = this.options.getShareGeneration(roomId);
    if (
      !publicationGeneration ||
      assignment?.sfuPublicationGeneration !== publicationGeneration ||
      !host ||
      host.sessionId !== hostSessionId ||
      !shareGeneration
    ) {
      return false;
    }

    const oldConnectionId = publicationGeneration;
    const newConnectionId = randomBytes(16).toString("base64url");
    let credential;
    try {
      credential = issueSelectedEdgeTurnCredential(
        config,
        {
          edgeKind: "host-sfu-ingress",
          roomId,
          shareGeneration,
          revision,
          hostPeerId,
          hostSessionId,
          publicationGeneration,
          oldConnectionId,
          newConnectionId,
        },
        this.options.now?.() ?? Date.now(),
      );
    } catch {
      console.error("Selected-edge TURN credential issuance failed");
      return false;
    }

    const pendingAttempt = pending;
    const timer = setTimeout(() => {
      const current = this.selectedSfuIngressAttempts.get(key);
      const currentPending =
        pendingAttempt !== undefined &&
        this.pendingRoutePreparations.get(key) === pendingAttempt;
      const currentIngress =
        current?.newConnectionId === newConnectionId && !current.answered;
      if (!currentPending && !currentIngress) {
        return;
      }
      if (currentIngress) {
        this.selectedSfuIngressAttempts.delete(key);
        this.sendError(
          current.hostSessionId,
          "PEER_NOT_FOUND",
          "Selected SFU relay ingress timed out",
        );
      }
      if (currentPending) {
        this.abortPendingRoute(key);
      }
    }, SELECTED_EDGE_TURN_ATTEMPT_TIMEOUT_MS);
    timer.unref();
    const attempt: SelectedSfuIngressAttempt = {
      roomId,
      revision,
      shareGeneration,
      hostPeerId,
      hostSessionId,
      publicationGeneration,
      oldConnectionId,
      newConnectionId,
      answered: false,
      timer,
    };
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = timer;
      pending.hostSfuIngressTurnAttempted = true;
    }
    this.activeSelectedSfuIngresses.delete(roomId);
    this.selectedSfuIngressAttempts.set(key, attempt);
    this.options.sendToSession(hostSessionId, {
      type: "selected-edge-turn",
      edgeKind: "host-sfu-ingress",
      revision,
      hostPeerId,
      publicationGeneration,
      oldConnectionId,
      newConnectionId,
      expiresAt: credential.expiresAt,
      iceServer: credential.iceServer,
    });
    return true;
  }

  private markSelectedSfuIngressAnswered(
    roomId: string,
    hostPeerId: string,
    hostSessionId: string,
    revision: number,
  ): void {
    const attempt = this.selectedSfuIngressAttempts.get(roomId);
    if (
      !attempt ||
      attempt.hostPeerId !== hostPeerId ||
      attempt.hostSessionId !== hostSessionId ||
      attempt.revision !== revision
    ) {
      return;
    }
    attempt.answered = true;
    if (this.pendingRoutePreparations.get(roomId)?.timer !== attempt.timer) {
      clearTimeout(attempt.timer);
    }
    this.selectedSfuIngressAttempts.delete(roomId);
    this.activeSelectedSfuIngresses.set(roomId, {
      shareGeneration: attempt.shareGeneration,
      hostPeerId: attempt.hostPeerId,
      hostSessionId: attempt.hostSessionId,
      publicationGeneration: attempt.publicationGeneration,
      connectionId: attempt.newConnectionId,
    });
  }

  private finishSelectedEdgeTurnFailure(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-failed" }>,
  ): boolean {
    if (participant.role === "host" && message.connectionId !== null) {
      const attempt = this.selectedSfuIngressAttempts.get(participant.roomId);
      if (
        !attempt ||
        attempt.hostPeerId !== participant.peerId ||
        attempt.hostSessionId !== participant.sessionId ||
        attempt.revision !== message.revision ||
        attempt.shareGeneration !==
          this.options.getShareGeneration(participant.roomId) ||
        attempt.newConnectionId !== message.connectionId
      ) {
        return false;
      }
      clearTimeout(attempt.timer);
      this.selectedSfuIngressAttempts.delete(participant.roomId);
      this.sendError(
        participant.sessionId,
        "PEER_NOT_FOUND",
        "Selected SFU relay ingress failed",
      );
      this.failBackToPeerBaseline(participant.roomId);
      return true;
    }
    if (participant.role !== "viewer" || message.connectionId === null) {
      return false;
    }
    const key = viewerConnectionKey(participant.roomId, participant.peerId);
    const attempt = this.selectedEdgeTurnAttempts.get(key);
    if (
      !attempt ||
      attempt.viewerSessionId !== participant.sessionId ||
      attempt.revision !== message.revision ||
      attempt.newConnectionId !== message.connectionId
    ) {
      return false;
    }
    clearTimeout(attempt.timer);
    this.selectedEdgeTurnAttempts.delete(key);
    this.sendError(
      participant.sessionId,
      "PEER_NOT_FOUND",
      "Selected relay edge failed",
    );
    return true;
  }

  private failBackToPeerBaseline(roomId: string): void {
    this.abortPendingRoute(roomId, undefined, false);
    const controller = this.mediaRouteControllers.get(roomId);
    const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
    if (!controller || !hostPeerId) {
      return;
    }
    const before = controller.getActiveRoute();
    const fillChanges = this.peerRelayTopology.setHost(
      roomId,
      hostPeerId,
      this.connectedPeerIds(roomId),
    );
    this.clearChangedConnectionIds(roomId, fillChanges);
    const assignments = participantRoutesFromTopology(
      this.peerRelayTopology.getAssignments(roomId),
      hostPeerId,
      null,
      [],
    );
    const revision = controller.reconcileBaseline({
      assignments,
      sfuPublicationGeneration: null,
      sfuRootPeerIds: [],
    });
    if (revision === undefined) {
      return;
    }
    this.sfuDisabledRoomIds.add(roomId);
    this.clearRoomFailedParents(roomId);
    const active = controller.getActiveRoute();
    this.consumedSfuRefreshesByRoom.delete(roomId);
    this.clearChangedRouteConnectionIds(roomId, before, active);
    this.broadcastActiveRoute(roomId, active);
    this.drainViewerRouteIntents(roomId);
  }

  private retireShrinkingSfuRoute(
    roomId: string,
    survivingRootPeerIds: readonly string[],
  ): void {
    this.abortPendingRoute(roomId, undefined, false);
    const controller = this.mediaRouteControllers.get(roomId);
    const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
    if (!controller || !hostPeerId) {
      return;
    }
    const before = controller.getActiveRoute();
    const assignments = participantRoutesFromTopology(
      this.peerRelayTopology.getAssignments(roomId),
      hostPeerId,
      null,
      [],
    );
    const revision = controller.reconcileBaseline({
      assignments,
      sfuPublicationGeneration: null,
      sfuRootPeerIds: [],
    });
    if (revision === undefined) {
      return;
    }
    this.consumedSfuRefreshesByRoom.delete(roomId);
    const active = controller.getActiveRoute();
    this.clearChangedRouteConnectionIds(roomId, before, active);
    this.broadcastActiveRoute(roomId, active);

    for (const peerId of survivingRootPeerIds) {
      const viewer = this.options.roomStore.getConnectedViewer(roomId, peerId);
      const assignment = active.assignments.get(peerId);
      if (!viewer || !assignment || assignment.upstream.kind === "sfu") {
        continue;
      }
      const failedParentPeerId =
        assignment.upstream.kind === "peer" &&
        this.failedParentPeerIdsByViewer
          .get(viewerConnectionKey(roomId, peerId))
          ?.has(assignment.upstream.peerId)
          ? assignment.upstream.peerId
          : assignment.upstream.kind === "none"
            ? null
            : undefined;
      if (failedParentPeerId === undefined) {
        continue;
      }
      let intents = this.viewerRouteIntentsByRoom.get(roomId);
      if (!intents) {
        intents = new Map();
        this.viewerRouteIntentsByRoom.set(roomId, intents);
      }
      intents.set(peerId, {
        failedParentPeerId,
        sessionId: viewer.sessionId,
        sfuAttempts: 0,
        unavailableReported: false,
      });
    }
    this.drainViewerRouteIntents(roomId);
  }

  private drainViewerRouteIntents(roomId: string): void {
    this.enqueueUnassignedViewerIntents(roomId);
    const pending = this.pendingRoutePreparations.get(roomId);
    if (pending) {
      if (this.abortStalePendingQualityIntent(roomId, pending)) {
        return;
      }
      return;
    }
    if (this.pendingRoutePreparations.has(roomId)) {
      return;
    }
    const intents = this.viewerRouteIntentsByRoom.get(roomId);
    if (!intents) {
      return;
    }

    for (const [viewerPeerId, intent] of [...intents]) {
      if (
        intent.qualityGuard &&
        !this.qualityIntentIsCurrent(roomId, viewerPeerId, intent)
      ) {
        this.discardQualityIntent(roomId, viewerPeerId, intent);
        continue;
      }
      const viewer = this.options.roomStore.getConnectedViewer(
        roomId,
        viewerPeerId,
      );
      this.pruneHeldQualityParentExclusion(
        roomId,
        viewerPeerId,
        this.options.now?.() ?? Date.now(),
      );
      const controller = this.mediaRouteControllers.get(roomId);
      const assignment = controller
        ?.getActiveRoute()
        .assignments.get(viewerPeerId);
      if (viewer?.sessionId !== intent.sessionId || !assignment) {
        if (intent.qualityGuard) {
          this.discardQualityIntent(roomId, viewerPeerId, intent);
        } else {
          intents.delete(viewerPeerId);
        }
        continue;
      }
      if (intent.failedParentPeerId === null) {
        if (assignment.upstream.kind !== "none") {
          intents.delete(viewerPeerId);
          continue;
        }
        const active = controller!.getActiveRoute();
        const excludedParents = new Set<string>();
        const baselineParentPeerId = this.peerRelayTopology.getAssignment(
          roomId,
          viewerPeerId,
        )?.parentPeerId;
        if (baselineParentPeerId) {
          excludedParents.add(baselineParentPeerId);
        }
        const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
        if (
          active.sfu.publicationGeneration &&
          hostPeerId &&
          (active.assignments.get(hostPeerId)?.childPeerIds.length ?? 0) >= 1
        ) {
          excludedParents.add(hostPeerId);
        }
        if (
          intent.qualityGuard &&
          !this.qualityIntentIsCurrent(roomId, viewerPeerId, intent)
        ) {
          this.discardQualityIntent(roomId, viewerPeerId, intent);
          continue;
        }
        const changes = this.peerRelayTopology.reassignViewer(
          roomId,
          viewerPeerId,
          this.connectedPeerIds(roomId),
          excludedParents,
          MAX_PEER_RELAY_DEPTH,
        );
        if (changes) {
          if (intent.qualityGuard) {
            this.startRoomQualityMigrationCooldown(roomId);
            this.releaseQualityOwnedParentExclusion(
              roomId,
              viewerPeerId,
              intent,
              intent.qualityGuard,
            );
          }
          intents.delete(viewerPeerId);
          this.clearChangedConnectionIds(roomId, changes);
          this.reconcileMediaRoute(roomId);
          this.sendMediaAssignmentChanges(roomId, changes);
          continue;
        }
      } else {
        if (assignment.upstream.kind === "sfu") {
          continue;
        }
        if (
          assignment.upstream.kind !== "peer" ||
          assignment.upstream.peerId !== intent.failedParentPeerId
        ) {
          intents.delete(viewerPeerId);
          continue;
        }
        const failedParents = this.failedParentPeerIdsByViewer.get(
          viewerConnectionKey(roomId, viewerPeerId),
        );
        if (!failedParents?.has(intent.failedParentPeerId)) {
          if (intent.qualityGuard) {
            this.discardQualityIntent(roomId, viewerPeerId, intent);
          } else {
            intents.delete(viewerPeerId);
          }
          continue;
        }
        if (
          intent.qualityGuard &&
          !this.qualityIntentIsCurrent(roomId, viewerPeerId, intent)
        ) {
          this.discardQualityIntent(roomId, viewerPeerId, intent);
          continue;
        }
        const changes = this.peerRelayTopology.reassignViewer(
          roomId,
          viewerPeerId,
          this.connectedPeerIds(roomId),
          failedParents,
          MAX_PEER_RELAY_DEPTH,
        );
        if (changes) {
          if (intent.qualityGuard) {
            this.startRoomQualityMigrationCooldown(roomId);
            if (intent.qualityGuard.kind === "relative-fps") {
              this.heldQualityParentExclusionsByViewer.set(
                viewerConnectionKey(roomId, viewerPeerId),
                {
                  parentPeerId: intent.qualityGuard.parentPeerId,
                  parentSessionId: intent.qualityGuard.parentSessionId,
                  expiresAtMs:
                    (this.options.now?.() ?? Date.now()) +
                    VIEWER_QUALITY_REASSIGN_COOLDOWN_MS,
                },
              );
              intent.qualityGuard.exclusionOwnedByQuality = false;
            } else {
              this.releaseQualityOwnedParentExclusion(
                roomId,
                viewerPeerId,
                intent,
                intent.qualityGuard,
              );
            }
          }
          intents.delete(viewerPeerId);
          this.clearChangedConnectionIds(roomId, changes);
          this.reconcileMediaRoute(roomId);
          this.sendMediaAssignmentChanges(roomId, changes);
          continue;
        }
      }

      if (intent.qualityGuard?.kind === "relative-fps") {
        this.discardQualityIntent(roomId, viewerPeerId, intent);
        continue;
      }

      if (
        intent.sfuAttempts === 0 &&
        this.options.sfuFallback &&
        !this.sfuDisabledRoomIds.has(roomId)
      ) {
        if (
          intent.qualityGuard &&
          !this.qualityIntentIsCurrent(roomId, viewerPeerId, intent)
        ) {
          this.discardQualityIntent(roomId, viewerPeerId, intent);
          continue;
        }
        const result = this.prepareSfuFallback(
          roomId,
          viewerPeerId,
          intent.sessionId,
          intent,
        );
        if (result === "started") {
          if (intent.qualityGuard) {
            this.startRoomQualityMigrationCooldown(roomId);
          }
          intent.sfuAttempts += 1;
          return;
        }
        if (result === "busy") {
          return;
        }
        intent.unavailableReported = true;
      }

      if (
        (intent.sfuAttempts > 0 || intent.unavailableReported) &&
        this.startSelectedEdgeTurn(roomId, viewerPeerId, false)
      ) {
        return;
      }

      if (!intent.unavailableReported) {
        this.sendError(
          intent.sessionId,
          "PEER_NOT_FOUND",
          "No media fallback route is available",
        );
        intent.unavailableReported = true;
      }
    }
    if (intents.size === 0) {
      this.viewerRouteIntentsByRoom.delete(roomId);
    }
  }

  private qualityIntentIsCurrent(
    roomId: string,
    viewerPeerId: string,
    intent: ViewerRouteIntent,
  ): boolean {
    const guard = intent.qualityGuard;
    if (!guard) {
      return true;
    }
    const edge = this.resolveActivePeerEdge(roomId, viewerPeerId);
    return (
      this.options.roomStore.getConnectedViewer(roomId, viewerPeerId)
        ?.sessionId === guard.viewerSessionId &&
      this.connectedPeer(roomId, guard.parentPeerId)?.sessionId ===
        guard.parentSessionId &&
      edge?.parentPeerId === guard.parentPeerId &&
      edge.revision === guard.routeRevision &&
      this.options.getConnectionId(roomId, viewerPeerId) === guard.connectionId
    );
  }

  private discardQualityIntent(
    roomId: string,
    viewerPeerId: string,
    intent: ViewerRouteIntent,
  ): void {
    const guard = intent.qualityGuard;
    const intents = this.viewerRouteIntentsByRoom.get(roomId);
    if (!guard || intents?.get(viewerPeerId) !== intent) {
      return;
    }
    intents.delete(viewerPeerId);
    if (intents.size === 0) {
      this.viewerRouteIntentsByRoom.delete(roomId);
    }
    this.releaseQualityOwnedParentExclusion(
      roomId,
      viewerPeerId,
      intent,
      guard,
    );
    this.viewerQualityEvidenceStates.delete(
      viewerConnectionKey(roomId, viewerPeerId),
    );
  }

  private releaseQualityOwnedParentExclusion(
    roomId: string,
    viewerPeerId: string,
    excludedIntent: ViewerRouteIntent,
    guard: QualityRouteIntentGuard,
  ): void {
    if (!guard.exclusionOwnedByQuality) {
      return;
    }
    const currentIntent = this.viewerRouteIntentsByRoom
      .get(roomId)
      ?.get(viewerPeerId);
    if (
      currentIntent !== excludedIntent &&
      currentIntent?.failedParentPeerId === guard.parentPeerId
    ) {
      return;
    }
    const connectionKey = viewerConnectionKey(roomId, viewerPeerId);
    const failedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    failedParents?.delete(guard.parentPeerId);
    if (failedParents?.size === 0) {
      this.failedParentPeerIdsByViewer.delete(connectionKey);
    }
  }

  private pruneHeldQualityParentExclusion(
    roomId: string,
    viewerPeerId: string,
    now: number,
  ): void {
    if (!Number.isFinite(now)) {
      return;
    }
    const connectionKey = viewerConnectionKey(roomId, viewerPeerId);
    const held = this.heldQualityParentExclusionsByViewer.get(connectionKey);
    if (
      !held ||
      (now < held.expiresAtMs &&
        this.connectedPeer(roomId, held.parentPeerId)?.sessionId ===
          held.parentSessionId)
    ) {
      return;
    }
    this.clearHeldQualityParentExclusion(roomId, viewerPeerId);
  }

  private clearHeldQualityParentExclusion(
    roomId: string,
    viewerPeerId: string,
  ): void {
    const connectionKey = viewerConnectionKey(roomId, viewerPeerId);
    const held = this.heldQualityParentExclusionsByViewer.get(connectionKey);
    if (!held) {
      return;
    }
    this.heldQualityParentExclusionsByViewer.delete(connectionKey);
    const failedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    failedParents?.delete(held.parentPeerId);
    if (failedParents?.size === 0) {
      this.failedParentPeerIdsByViewer.delete(connectionKey);
    }
  }

  private prepareSfuFallback(
    roomId: string,
    failedPeerId: string,
    sourceSessionId: string,
    routeIntent: ViewerRouteIntent,
  ): SfuPrepareResult {
    const fallback = this.options.sfuFallback;
    const controller = this.mediaRouteControllers.get(roomId);
    if (!fallback || !controller) {
      return "unavailable";
    }
    if (controller.getPendingRoute()) {
      return "busy";
    }
    if (this.sfuDisabledRoomIds.has(roomId)) {
      this.sendError(
        sourceSessionId,
        "PEER_NOT_FOUND",
        "No media fallback route is available",
      );
      return "unavailable";
    }
    const active = controller.getActiveRoute();
    const requestedAssignment = active.assignments.get(failedPeerId);
    if (
      !requestedAssignment ||
      requestedAssignment.upstream.kind === "sfu" ||
      failedPeerId === this.peerRelayTopology.getHostPeerId(roomId)
    ) {
      this.sendError(
        sourceSessionId,
        "PEER_NOT_FOUND",
        "Viewer has no SFU fallback route",
      );
      return "unavailable";
    }
    const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
    if (!hostPeerId) {
      this.sendError(
        sourceSessionId,
        "SERVER_ERROR",
        "SFU fallback plan is invalid",
      );
      return "unavailable";
    }

    const rootPeerIds = [
      ...new Set([...active.sfu.rootPeerIds, failedPeerId]),
    ];
    const assignments = cloneAssignments(active.assignments);
    if (!promoteSfuRoots(assignments, rootPeerIds)) {
      this.sendError(
        sourceSessionId,
        "SERVER_ERROR",
        "SFU fallback plan is invalid",
      );
      return "unavailable";
    }

    let host = assignments.get(hostPeerId);
    if (!host) {
      this.sendError(sourceSessionId, "SERVER_ERROR", "Media route has no host");
      return "unavailable";
    }

    if (host.childPeerIds.length > 1) {
      const budgetRootPeerId =
        requestedAssignment.upstream.kind === "peer"
          ? findHostBranchRoot(active.assignments, failedPeerId, hostPeerId)
          : host.childPeerIds[0];
      if (
        !budgetRootPeerId ||
        budgetRootPeerId === hostPeerId ||
        (!rootPeerIds.includes(budgetRootPeerId) &&
          rootPeerIds.length >= fallback.maxRoots)
      ) {
        this.sendError(
          sourceSessionId,
          "PEER_NOT_FOUND",
          "SFU fallback root budget is exhausted",
        );
        return "unavailable";
      }
      if (!rootPeerIds.includes(budgetRootPeerId)) {
        rootPeerIds.push(budgetRootPeerId);
      }
      if (!promoteSfuRoots(assignments, [budgetRootPeerId])) {
        this.sendError(
          sourceSessionId,
          "SERVER_ERROR",
          "SFU fallback plan is invalid",
        );
        return "unavailable";
      }
      host = assignments.get(hostPeerId);
    }

    if (
      rootPeerIds.length > fallback.maxRoots ||
      !host ||
      host.childPeerIds.length + 1 > 2
    ) {
      this.sendError(
        sourceSessionId,
        "PEER_NOT_FOUND",
        "SFU fallback root budget is exhausted",
      );
      return "unavailable";
    }

    const generation = randomBytes(16).toString("base64url");
    assignments.set(hostPeerId, {
      ...host,
      sfuPublicationGeneration: generation,
    });

    const expectedSessionIds = new Map<string, string>();
    for (const peerId of [hostPeerId, ...rootPeerIds]) {
      const peer = this.connectedPeer(roomId, peerId);
      if (!peer) {
        this.sendError(
          sourceSessionId,
          "PEER_NOT_FOUND",
          "SFU route participant is offline",
        );
        return "unavailable";
      }
      expectedSessionIds.set(peerId, peer.sessionId);
    }
    let revision: number | undefined;
    try {
      revision = controller.prepare({
        assignments,
        expectedParticipantIds: new Set(expectedSessionIds.keys()),
        sfuPublicationGeneration: generation,
        sfuRootPeerIds: rootPeerIds,
      });
    } catch {
      this.sendError(
        sourceSessionId,
        "SERVER_ERROR",
        "SFU fallback plan is invalid",
      );
      return "unavailable";
    }
    if (revision === undefined) {
      return "unavailable";
    }

    const timer = setTimeout(
      () => this.abortPendingRoute(roomId),
      fallback.prepareTimeoutMs ?? DEFAULT_SFU_PREPARE_TIMEOUT_MS,
    );
    timer.unref();
    this.pendingRoutePreparations.set(roomId, {
      revision,
      intentPeerId: failedPeerId,
      routeIntent,
      qualityIntent: routeIntent.qualityGuard
        ? {
            guard: { ...routeIntent.qualityGuard },
            takenOverByRouteFailure: false,
          }
        : null,
      expectedSessionIds,
      grantsIssued: false,
      hostSfuIngressTurnAttempted: false,
      healthyReselection: null,
      timer,
    });
    void this.issueSfuPrepareGrants(
      roomId,
      controller,
      revision,
      generation,
      rootPeerIds,
      expectedSessionIds,
    );
    return "started";
  }

  private async issueSfuPrepareGrants(
    roomId: string,
    controller: MediaRouteController,
    revision: number,
    generation: string,
    rootPeerIds: readonly string[],
    expectedSessionIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    const fallback = this.options.sfuFallback;
    if (!fallback) {
      return;
    }
    try {
      const grants = await Promise.all(
        [...expectedSessionIds].map(async ([peerId, sessionId]) => ({
          peerId,
          sessionId,
          token: await fallback.tokenIssuer.issueToken({
            roomId,
            role:
              peerId === this.peerRelayTopology.getHostPeerId(roomId)
                ? "host"
                : "viewer",
            peerId,
            publicationGeneration: generation,
            allowlistedRootPeerIds: rootPeerIds,
          }),
        })),
      );
      const pending = this.pendingRoutePreparations.get(roomId);
      const pendingRoute = controller.getPendingRoute();
      if (
        this.mediaRouteControllers.get(roomId) !== controller ||
        pending?.revision !== revision ||
        pendingRoute?.route.revision !== revision
      ) {
        return;
      }
      if (!this.pendingSessionsAreCurrent(roomId, pending)) {
        this.abortPendingRoute(roomId);
        return;
      }
      if (this.abortStalePendingQualityIntent(roomId, pending)) {
        return;
      }
      for (const { peerId, sessionId, token } of grants) {
        const assignment = pendingRoute.route.assignments.get(peerId);
        if (!assignment) {
          this.abortPendingRoute(roomId);
          return;
        }
        this.options.sendToSession(sessionId, {
          type: "route-update",
          revision,
          phase: "prepare",
          assignment,
        });
        this.options.sendToSession(sessionId, {
          type: "sfu-config",
          revision,
          url: fallback.url,
          token,
        });
      }
      pending.grantsIssued = true;
    } catch {
      console.error("SFU route preparation failed");
      const pending = this.pendingRoutePreparations.get(roomId);
      if (
        this.mediaRouteControllers.get(roomId) === controller &&
        pending?.revision === revision
      ) {
        this.abortPendingRoute(roomId);
      }
    }
  }

  private commitPendingRoute(roomId: string, revision: number): void {
    const controller = this.mediaRouteControllers.get(roomId);
    const pending = this.pendingRoutePreparations.get(roomId);
    if (
      !controller ||
      !pending ||
      pending.revision !== revision ||
      !this.pendingSessionsAreCurrent(roomId, pending)
    ) {
      if (pending?.revision === revision) {
        this.abortPendingRoute(roomId);
      }
      return;
    }
    if (this.abortStalePendingQualityIntent(roomId, pending)) {
      return;
    }
    const before = controller.getActiveRoute();
    if (!controller.commit(revision)) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRoutePreparations.delete(roomId);
    const active = controller.getActiveRoute();
    const healthy = pending.healthyReselection;
    if (healthy) {
      this.failedParentPeerIdsByViewer.delete(
        viewerConnectionKey(roomId, healthy.rootPeerId),
      );
      this.viewerRouteIntentsByRoom.get(roomId)?.delete(healthy.rootPeerId);
      this.consumedSfuRefreshesByRoom.delete(roomId);
    } else {
      this.clearChangedRouteConnectionIds(roomId, before, active);
    }
    this.broadcastActiveRoute(roomId, active);
    this.drainViewerRouteIntents(roomId);
  }

  private healthySfuReselectionIsCurrent(
    roomId: string,
    pending: PendingRoutePreparation,
  ): boolean {
    const probe = pending.healthyReselection;
    const controller = this.mediaRouteControllers.get(roomId);
    const active = controller?.getActiveRoute();
    return (
      probe !== null &&
      this.pendingRoutePreparations.get(roomId) === pending &&
      active?.revision === probe.activeRevision &&
      active.sfu.publicationGeneration === probe.publicationGeneration &&
      controller?.getPendingRoute()?.route.revision === pending.revision &&
      this.options.getShareGeneration(roomId) === probe.shareGeneration &&
      this.pendingSessionsAreCurrent(roomId, pending)
    );
  }

  private ownsActiveSfuForHealthyReselection(
    participant: AuthenticatedRouteParticipant,
    pending: PendingRoutePreparation,
  ): boolean {
    const probe = pending.healthyReselection;
    if (
      !probe ||
      pending.expectedSessionIds.get(participant.peerId) !==
        participant.sessionId ||
      !this.healthySfuReselectionIsCurrent(participant.roomId, pending)
    ) {
      return false;
    }
    const active = this.mediaRouteControllers
      .get(participant.roomId)
      ?.getActiveRoute();
    const assignment = active?.assignments.get(participant.peerId);
    if (participant.role === "viewer") {
      return (
        participant.peerId === probe.rootPeerId &&
        assignment?.upstream.kind === "sfu" &&
        active?.sfu.rootPeerIds.includes(participant.peerId) === true
      );
    }
    return (
      participant.peerId ===
        this.peerRelayTopology.getHostPeerId(participant.roomId) &&
      assignment?.sfuPublicationGeneration === probe.publicationGeneration
    );
  }

  private abortPendingRoute(
    roomId: string,
    excludedPeerId?: string,
    drainFailureIntents = true,
  ): void {
    const controller = this.mediaRouteControllers.get(roomId);
    const pending = this.pendingRoutePreparations.get(roomId);
    if (!controller || !pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRoutePreparations.delete(roomId);
    if (pending.healthyReselection) {
      this.options.deleteConnectionId(roomId, pending.healthyReselection.rootPeerId);
    }
    const ingress = this.selectedSfuIngressAttempts.get(roomId);
    if (ingress?.revision === pending.revision) {
      clearTimeout(ingress.timer);
      this.selectedSfuIngressAttempts.delete(roomId);
    }
    if (controller.abort(pending.revision)) {
      this.broadcastActiveRoute(
        roomId,
        controller.getActiveRoute(),
        excludedPeerId,
      );
    }
    if (drainFailureIntents) {
      this.drainViewerRouteIntents(roomId);
    }
  }

  private abortPendingRouteForTopologyChange(
    roomId: string,
    excludedPeerId?: string,
  ): void {
    const pending = this.pendingRoutePreparations.get(roomId);
    const currentIntent = pending
      ? this.viewerRouteIntentsByRoom
          .get(roomId)
          ?.get(pending.intentPeerId)
      : undefined;
    if (pending && currentIntent === pending.routeIntent) {
      pending.routeIntent.sfuAttempts = 0;
      pending.routeIntent.unavailableReported = false;
    }
    this.abortPendingRoute(roomId, excludedPeerId, false);
  }

  private pendingSessionsAreCurrent(
    roomId: string,
    pending: PendingRoutePreparation,
  ): boolean {
    for (const [peerId, sessionId] of pending.expectedSessionIds) {
      if (this.connectedPeer(roomId, peerId)?.sessionId !== sessionId) {
        return false;
      }
    }
    return true;
  }

  private abortStalePendingQualityIntent(
    roomId: string,
    pending: PendingRoutePreparation,
  ): boolean {
    if (this.pendingQualityIntentIsCurrent(roomId, pending)) {
      return false;
    }
    this.abortPendingRoute(roomId, undefined, false);
    const qualityIntent = pending.qualityIntent;
    if (qualityIntent && !qualityIntent.takenOverByRouteFailure) {
      const currentIntent = this.viewerRouteIntentsByRoom
        .get(roomId)
        ?.get(pending.intentPeerId);
      if (
        currentIntent === pending.routeIntent &&
        currentIntent.qualityGuard
      ) {
        this.discardQualityIntent(
          roomId,
          pending.intentPeerId,
          currentIntent,
        );
      } else {
        this.releaseQualityOwnedParentExclusion(
          roomId,
          pending.intentPeerId,
          pending.routeIntent,
          qualityIntent.guard,
        );
      }
    }
    this.drainViewerRouteIntents(roomId);
    return true;
  }

  private pendingQualityIntentIsCurrent(
    roomId: string,
    pending: PendingRoutePreparation,
  ): boolean {
    const qualityIntent = pending.qualityIntent;
    if (!qualityIntent) {
      return true;
    }
    const currentIntent = this.viewerRouteIntentsByRoom
      .get(roomId)
      ?.get(pending.intentPeerId);
    if (currentIntent !== pending.routeIntent) {
      return false;
    }
    if (qualityIntent.takenOverByRouteFailure) {
      return (
        currentIntent.qualityGuard === undefined &&
        currentIntent.failedParentPeerId === qualityIntent.guard.parentPeerId
      );
    }
    const currentGuard = currentIntent.qualityGuard;
    return (
      currentGuard !== undefined &&
      sameQualityRouteIntentGuard(currentGuard, qualityIntent.guard) &&
      this.qualityIntentIsCurrent(roomId, pending.intentPeerId, currentIntent)
    );
  }

  private async sendFreshSfuConfig(
    roomId: string,
    peerId: string,
    sessionId: string,
    revision: number,
    reportError = false,
    consumeRefresh = false,
  ): Promise<void> {
    const fallback = this.options.sfuFallback;
    const controller = this.mediaRouteControllers.get(roomId);
    const active = controller?.getActiveRoute();
    if (
      !fallback ||
      !controller ||
      !active ||
      active.revision !== revision ||
      !active.sfu.publicationGeneration ||
      (peerId !== this.peerRelayTopology.getHostPeerId(roomId) &&
        !active.sfu.rootPeerIds.includes(peerId))
    ) {
      if (reportError) {
        this.sendError(
          sessionId,
          "FORBIDDEN",
          "Participant has no active SFU grant",
        );
      }
      return;
    }
    if (consumeRefresh) {
      let consumed = this.consumedSfuRefreshesByRoom.get(roomId);
      if (!consumed) {
        consumed = new Set();
        this.consumedSfuRefreshesByRoom.set(roomId, consumed);
      }
      const refreshKey = sfuRefreshKey(
        active.sfu.publicationGeneration,
        peerId,
        sessionId,
      );
      if (consumed.has(refreshKey)) {
        this.sendError(
          sessionId,
          "FORBIDDEN",
          "The active SFU grant was already refreshed",
        );
        return;
      }
      consumed.add(refreshKey);
      const activeIngress = this.activeSelectedSfuIngresses.get(roomId);
      if (
        activeIngress?.hostPeerId === peerId &&
        activeIngress.hostSessionId === sessionId &&
        activeIngress.publicationGeneration ===
          active.sfu.publicationGeneration &&
        activeIngress.shareGeneration ===
          this.options.getShareGeneration(roomId)
      ) {
        this.activeSelectedSfuIngresses.delete(roomId);
      }
    }
    try {
      const token = await fallback.tokenIssuer.issueToken({
        roomId,
        role:
          peerId === this.peerRelayTopology.getHostPeerId(roomId)
            ? "host"
            : "viewer",
        peerId,
        publicationGeneration: active.sfu.publicationGeneration,
        allowlistedRootPeerIds: active.sfu.rootPeerIds,
      });
      const current = controller.getActiveRoute();
      if (
        this.mediaRouteControllers.get(roomId) !== controller ||
        this.connectedPeer(roomId, peerId)?.sessionId !== sessionId ||
        current.revision !== revision ||
        current.sfu.publicationGeneration !==
          active.sfu.publicationGeneration
      ) {
        return;
      }
      this.options.sendToSession(sessionId, {
        type: "sfu-config",
        revision,
        url: fallback.url,
        token,
      });
    } catch {
      console.error("SFU token refresh failed");
      const current = controller.getActiveRoute();
      if (
        this.mediaRouteControllers.get(roomId) === controller &&
        this.connectedPeer(roomId, peerId)?.sessionId === sessionId &&
        current.revision === revision &&
        current.sfu.publicationGeneration ===
          active.sfu.publicationGeneration
      ) {
        if (
          active.sfu.rootPeerIds.includes(peerId) &&
          this.startSelectedEdgeTurn(roomId, peerId, true)
        ) {
          return;
        }
        this.failBackToPeerBaseline(roomId);
      }
    }
  }

  private reconcileMediaRoute(
    roomId: string,
    excludedPeerId?: string,
  ): MediaRouteController | undefined {
    const hostPeerId = this.peerRelayTopology.getHostPeerId(roomId);
    if (!hostPeerId) {
      return undefined;
    }

    let controller = this.mediaRouteControllers.get(roomId);
    if (controller?.getPendingRoute()) {
      this.abortPendingRouteForTopologyChange(roomId, excludedPeerId);
      controller = this.mediaRouteControllers.get(roomId);
    }
    let initialRevision = 0;
    if (controller && !controller.getActiveRoute().assignments.has(hostPeerId)) {
      initialRevision = controller.getActiveRoute().revision;
      if (initialRevision >= MAX_MEDIA_ROUTE_REVISION) {
        throw new Error("Media route revision space exhausted");
      }
      initialRevision += 1;
      this.clearRoomMediaRouteState(roomId);
      controller = undefined;
    }
    const previousSfu = controller?.getActiveRoute().sfu;
    let topologyAssignments = this.peerRelayTopology.getAssignments(roomId);
    let rootPeerIds =
      previousSfu?.rootPeerIds.filter((peerId) =>
        topologyAssignments.has(peerId),
      ) ?? [];
    if (
      previousSfu?.publicationGeneration &&
      rootPeerIds.length !== previousSfu.rootPeerIds.length
    ) {
      this.retireShrinkingSfuRoute(roomId, rootPeerIds);
      return controller;
    }
    const assignments = participantRoutesFromTopology(
      topologyAssignments,
      hostPeerId,
      previousSfu?.publicationGeneration ?? null,
      rootPeerIds,
    );
    if (!controller && initialRevision === 0 && assignments.size > 1) {
      initialRevision = 1;
    }

    if (!controller) {
      controller = new MediaRouteController({
        hostPeerId,
        assignments,
        revision: initialRevision,
        sfuPublicationGeneration:
          assignments.get(hostPeerId)?.sfuPublicationGeneration ?? null,
        sfuRootPeerIds: [...assignments]
          .filter(([, assignment]) => assignment.upstream.kind === "sfu")
          .map(([peerId]) => peerId),
      });
      this.mediaRouteControllers.set(roomId, controller);
      this.broadcastActiveRoute(
        roomId,
        controller.getActiveRoute(),
        excludedPeerId,
      );
      return controller;
    }

    const publicationGeneration =
      rootPeerIds.length > 0
        ? (previousSfu?.publicationGeneration ?? null)
        : null;
    const revision = controller.reconcileBaseline({
      assignments,
      sfuPublicationGeneration: publicationGeneration,
      sfuRootPeerIds: rootPeerIds,
    });
    if (revision !== undefined) {
      this.broadcastActiveRoute(
        roomId,
        controller.getActiveRoute(),
        excludedPeerId,
      );
    }
    return controller;
  }

  private broadcastActiveRoute(
    roomId: string,
    route: RoomMediaRoute,
    excludedPeerId?: string,
  ): void {
    for (const [key, attempt] of this.selectedEdgeTurnAttempts) {
      if (attempt.roomId === roomId && attempt.revision !== route.revision) {
        clearTimeout(attempt.timer);
        this.selectedEdgeTurnAttempts.delete(key);
      }
    }
    for (const [key, attempt] of this.selectedSfuIngressAttempts) {
      if (attempt.roomId === roomId && attempt.revision !== route.revision) {
        clearTimeout(attempt.timer);
        this.selectedSfuIngressAttempts.delete(key);
      }
    }
    const activeIngress = this.activeSelectedSfuIngresses.get(roomId);
    if (
      activeIngress &&
      (route.sfu.publicationGeneration !==
        activeIngress.publicationGeneration ||
        route.assignments.get(activeIngress.hostPeerId)
          ?.sfuPublicationGeneration !== activeIngress.publicationGeneration ||
        this.connectedPeer(roomId, activeIngress.hostPeerId)?.sessionId !==
          activeIngress.hostSessionId ||
        this.options.getShareGeneration(roomId) !==
          activeIngress.shareGeneration)
    ) {
      this.activeSelectedSfuIngresses.delete(roomId);
    }
    this.clearRoomViewerQualityEvidenceStates(roomId);
    for (const [peerId, assignment] of route.assignments) {
      if (peerId === excludedPeerId) {
        continue;
      }
      const peer = this.connectedPeer(roomId, peerId);
      if (peer) {
        this.options.sendToSession(peer.sessionId, {
          type: "route-update",
          revision: route.revision,
          phase: "active",
          assignment,
        });
      }
    }
    this.options.onActiveRouteChanged?.(roomId);
  }

  private clearChangedRouteConnectionIds(
    roomId: string,
    before: RoomMediaRoute,
    after: RoomMediaRoute,
  ): void {
    for (const [peerId, assignment] of after.assignments) {
      const previous = before.assignments.get(peerId);
      if (!previous || !sameUpstream(previous, assignment)) {
        this.options.deleteConnectionId(roomId, peerId);
      }
    }
  }

  private clearChangedConnectionIds(
    roomId: string,
    changes: readonly MediaAssignmentChange[],
  ): void {
    for (const change of changes) {
      if (
        change.previousParentPeerId !== undefined &&
        change.previousParentPeerId !== change.mediaAssignment.parentPeerId
      ) {
        this.options.deleteConnectionId(roomId, change.peerId);
      }
    }
  }

  private sendMediaAssignmentChanges(
    roomId: string,
    changes: readonly MediaAssignmentChange[],
    excludedPeerId?: string,
  ): void {
    const active = this.mediaRouteControllers.get(roomId)?.getActiveRoute();
    for (const change of changes) {
      if (change.peerId === excludedPeerId) {
        continue;
      }
      const peer = this.connectedPeer(roomId, change.peerId);
      if (peer) {
        const activeAssignment = active?.assignments.get(change.peerId);
        this.options.sendToSession(peer.sessionId, {
          type: "media-assignment",
          mediaAssignment: activeAssignment
            ? mediaAssignmentFromParticipantRoute(activeAssignment)
            : change.mediaAssignment,
        });
      }
    }
  }

  private sendCurrentParentAssignment(roomId: string, childPeerId: string): void {
    const active = this.mediaRouteControllers.get(roomId)?.getActiveRoute();
    const child = active?.assignments.get(childPeerId);
    const parentPeerId =
      child?.upstream.kind === "peer" ? child.upstream.peerId : undefined;
    if (!parentPeerId) {
      return;
    }
    const parent = this.connectedPeer(roomId, parentPeerId);
    const parentAssignment = active?.assignments.get(parentPeerId);
    if (parent && parentAssignment && active) {
      this.options.sendToSession(parent.sessionId, {
        type: "route-update",
        revision: active.revision,
        phase: "active",
        assignment: parentAssignment,
      });
      this.options.sendToSession(parent.sessionId, {
        type: "media-assignment",
        mediaAssignment: mediaAssignmentFromParticipantRoute(parentAssignment),
      });
    }
  }

  private connectedPeerIds(roomId: string): Set<string> {
    const peerIds = new Set(
      this.options.roomStore
        .getConnectedViewers(roomId)
        .map((viewer) => viewer.peerId),
    );
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (host) {
      peerIds.add(host.peerId);
    }
    return peerIds;
  }

  private connectedPeer(roomId: string, peerId: string) {
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (host?.peerId === peerId) {
      return host;
    }
    return this.options.roomStore.getConnectedViewer(roomId, peerId);
  }

  private sendError(sessionId: string, code: ErrorCode, message: string): void {
    this.options.sendToSession(sessionId, { type: "error", code, message });
  }

  private clearRoomFailedParents(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const key of this.failedParentPeerIdsByViewer.keys()) {
      if (key.startsWith(prefix)) {
        this.failedParentPeerIdsByViewer.delete(key);
      }
    }
    for (const key of this.heldQualityParentExclusionsByViewer.keys()) {
      if (key.startsWith(prefix)) {
        this.heldQualityParentExclusionsByViewer.delete(key);
      }
    }
  }

  private clearRoomMediaRouteState(roomId: string): void {
    const pending = this.pendingRoutePreparations.get(roomId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRoutePreparations.delete(roomId);
    }
    this.mediaRouteControllers.delete(roomId);
    this.clearRoomFailedParents(roomId);
    this.viewerRouteIntentsByRoom.delete(roomId);
    for (const [key, attempt] of this.selectedEdgeTurnAttempts) {
      if (attempt.roomId === roomId) {
        clearTimeout(attempt.timer);
        this.selectedEdgeTurnAttempts.delete(key);
      }
    }
    const ingress = this.selectedSfuIngressAttempts.get(roomId);
    if (ingress) {
      clearTimeout(ingress.timer);
      this.selectedSfuIngressAttempts.delete(roomId);
    }
    this.activeSelectedSfuIngresses.delete(roomId);
    this.consumedSfuRefreshesByRoom.delete(roomId);
    this.sfuDisabledRoomIds.delete(roomId);
    this.clearRoomViewerQualityEvidenceStates(roomId);
    this.roomQualityMigrationCooldownUntilMs.delete(roomId);
  }

  private clearSelectedEdgeTurnsForParticipant(
    roomId: string,
    peerId: string,
  ): void {
    for (const [key, attempt] of this.selectedEdgeTurnAttempts) {
      if (
        attempt.roomId === roomId &&
        (attempt.parentPeerId === peerId || attempt.viewerPeerId === peerId)
      ) {
        clearTimeout(attempt.timer);
        this.selectedEdgeTurnAttempts.delete(key);
      }
    }
    const ingress = this.selectedSfuIngressAttempts.get(roomId);
    if (ingress?.hostPeerId === peerId) {
      clearTimeout(ingress.timer);
      this.selectedSfuIngressAttempts.delete(roomId);
    }
    if (this.activeSelectedSfuIngresses.get(roomId)?.hostPeerId === peerId) {
      this.activeSelectedSfuIngresses.delete(roomId);
    }
  }

  private clearSfuRefreshesForPeer(roomId: string, peerId: string): void {
    const consumed = this.consumedSfuRefreshesByRoom.get(roomId);
    if (!consumed) {
      return;
    }
    const marker = `\u0000${peerId}\u0000`;
    for (const key of consumed) {
      if (key.includes(marker)) {
        consumed.delete(key);
      }
    }
    if (consumed.size === 0) {
      this.consumedSfuRefreshesByRoom.delete(roomId);
    }
  }

  private startRoomQualityMigrationCooldown(roomId: string): void {
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isFinite(now)) {
      return;
    }
    this.roomQualityMigrationCooldownUntilMs.set(
      roomId,
      now + VIEWER_QUALITY_REASSIGN_COOLDOWN_MS,
    );
  }

  private clearViewerQualityStateForParticipant(
    roomId: string,
    peerId: string,
  ): void {
    this.clearHeldQualityParentExclusion(roomId, peerId);
    const intents = this.viewerRouteIntentsByRoom.get(roomId);
    for (const [viewerPeerId, intent] of [...(intents ?? [])]) {
      if (
        intent.qualityGuard &&
        (viewerPeerId === peerId || intent.qualityGuard.parentPeerId === peerId)
      ) {
        this.discardQualityIntent(roomId, viewerPeerId, intent);
      }
    }
    const connectionKey = viewerConnectionKey(roomId, peerId);
    this.viewerQualityEvidenceStates.delete(connectionKey);
    for (const [key, state] of this.viewerQualityEvidenceStates) {
      if (key.startsWith(`${roomId}:`) && state.parentPeerId === peerId) {
        this.viewerQualityEvidenceStates.delete(key);
      }
    }
  }

  private clearRoomViewerQualityEvidenceStates(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const key of this.viewerQualityEvidenceStates.keys()) {
      if (key.startsWith(prefix)) {
        this.viewerQualityEvidenceStates.delete(key);
      }
    }
  }

  private enqueueUnassignedViewerIntents(roomId: string): void {
    const advertised = this.relayCapacitySessionsByRoom.get(roomId);
    const assignments = this.mediaRouteControllers
      .get(roomId)
      ?.getActiveRoute().assignments;
    if (!advertised || !assignments) {
      return;
    }
    let intents = this.viewerRouteIntentsByRoom.get(roomId);
    for (const [peerId, sessionId] of advertised) {
      const viewer = this.options.roomStore.getConnectedViewer(roomId, peerId);
      if (viewer?.sessionId !== sessionId) {
        advertised.delete(peerId);
        intents?.delete(peerId);
        continue;
      }
      if (assignments.get(peerId)?.upstream.kind !== "none") {
        continue;
      }
      if (!intents) {
        intents = new Map();
        this.viewerRouteIntentsByRoom.set(roomId, intents);
      }
      const existing = intents.get(peerId);
      if (
        existing?.sessionId === sessionId &&
        existing.failedParentPeerId === null
      ) {
        continue;
      }
      intents.set(peerId, {
        failedParentPeerId: null,
        sessionId,
        sfuAttempts: 0,
        unavailableReported: false,
      });
    }
  }
}

function viewerConnectionKey(roomId: string, peerId: string): string {
  return `${roomId}:${peerId}`;
}

function sameQualityRouteIntentGuard(
  left: QualityRouteIntentGuard,
  right: QualityRouteIntentGuard,
): boolean {
  return (
    left.kind === right.kind &&
    left.viewerSessionId === right.viewerSessionId &&
    left.connectionId === right.connectionId &&
    left.routeRevision === right.routeRevision &&
    left.parentPeerId === right.parentPeerId &&
    left.parentSessionId === right.parentSessionId &&
    left.exclusionOwnedByQuality === right.exclusionOwnedByQuality
  );
}

function sfuRefreshKey(
  publicationGeneration: string,
  peerId: string,
  sessionId: string,
): string {
  return `${publicationGeneration}\u0000${peerId}\u0000${sessionId}`;
}

function participantRouteFromMediaAssignment(
  assignment: MediaAssignment | undefined,
): ParticipantRouteAssignment | undefined {
  return assignment
    ? {
        upstream: assignment.parentPeerId
          ? { kind: "peer", peerId: assignment.parentPeerId }
          : { kind: "none" },
        childPeerIds: [...assignment.childPeerIds],
        sfuPublicationGeneration: null,
      }
    : undefined;
}

function mediaAssignmentFromParticipantRoute(
  assignment: ParticipantRouteAssignment,
): MediaAssignment {
  return {
    parentPeerId:
      assignment.upstream.kind === "peer"
        ? assignment.upstream.peerId
        : null,
    childPeerIds: [...assignment.childPeerIds],
  };
}

function participantRoutesFromTopology(
  topologyAssignments: ReadonlyMap<string, MediaAssignment>,
  hostPeerId: string,
  publicationGeneration: string | null,
  requestedRootPeerIds: readonly string[],
): Map<string, ParticipantRouteAssignment> {
  // Keep the peer tree intact underneath the active SFU overlay so prepare
  // aborts and one-shot failback never need to reconstruct a lost baseline.
  const assignments = new Map<string, ParticipantRouteAssignment>();
  for (const [peerId, assignment] of topologyAssignments) {
    assignments.set(peerId, {
      upstream:
        peerId === hostPeerId || !assignment.parentPeerId
          ? { kind: "none" }
          : { kind: "peer", peerId: assignment.parentPeerId },
      childPeerIds: [...assignment.childPeerIds],
      sfuPublicationGeneration: null,
    });
  }

  const rootPeerIds = publicationGeneration
    ? requestedRootPeerIds.filter(
        (peerId) => peerId !== hostPeerId && assignments.has(peerId),
      )
    : [];
  for (const rootPeerId of rootPeerIds) {
    const root = assignments.get(rootPeerId)!;
    if (root.upstream.kind === "peer") {
      const parent = assignments.get(root.upstream.peerId);
      if (parent) {
        assignments.set(root.upstream.peerId, {
          ...parent,
          childPeerIds: parent.childPeerIds.filter(
            (childPeerId) => childPeerId !== rootPeerId,
          ),
        });
      }
    }
    assignments.set(rootPeerId, {
      ...root,
      upstream: { kind: "sfu" },
    });
  }
  const host = assignments.get(hostPeerId);
  if (host && rootPeerIds.length > 0) {
    const directChildPeerIds = host.childPeerIds.slice(0, 1);
    for (const suppressedPeerId of host.childPeerIds.slice(1)) {
      const suppressed = assignments.get(suppressedPeerId);
      if (suppressed?.upstream.kind === "peer") {
        assignments.set(suppressedPeerId, {
          ...suppressed,
          upstream: { kind: "none" },
        });
      }
    }
    assignments.set(hostPeerId, {
      ...host,
      childPeerIds: directChildPeerIds,
      sfuPublicationGeneration: publicationGeneration,
    });
  }
  return assignments;
}

function cloneAssignments(
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>,
): Map<string, ParticipantRouteAssignment> {
  return new Map(
    [...assignments].map(([peerId, assignment]) => [
      peerId,
      {
        upstream:
          assignment.upstream.kind === "peer"
            ? { kind: "peer" as const, peerId: assignment.upstream.peerId }
            : { kind: assignment.upstream.kind },
        childPeerIds: [...assignment.childPeerIds],
        sfuPublicationGeneration: assignment.sfuPublicationGeneration,
      },
    ]),
  );
}

function promoteSfuRoots(
  assignments: Map<string, ParticipantRouteAssignment>,
  rootPeerIds: readonly string[],
): boolean {
  for (const rootPeerId of rootPeerIds) {
    const root = assignments.get(rootPeerId);
    if (!root) {
      return false;
    }
    if (root.upstream.kind === "peer") {
      const parent = assignments.get(root.upstream.peerId);
      if (!parent) {
        return false;
      }
      assignments.set(root.upstream.peerId, {
        ...parent,
        childPeerIds: parent.childPeerIds.filter(
          (childPeerId) => childPeerId !== rootPeerId,
        ),
      });
    }
    assignments.set(rootPeerId, {
      ...root,
      upstream: { kind: "sfu" },
    });
  }
  return true;
}

function findHostBranchRoot(
  assignments: ReadonlyMap<string, ParticipantRouteAssignment>,
  peerId: string,
  hostPeerId: string,
): string | undefined {
  const visited = new Set<string>();
  let branchPeerId = peerId;
  while (!visited.has(branchPeerId)) {
    visited.add(branchPeerId);
    const assignment = assignments.get(branchPeerId);
    if (assignment?.upstream.kind !== "peer") {
      return undefined;
    }
    if (assignment.upstream.peerId === hostPeerId) {
      return branchPeerId;
    }
    branchPeerId = assignment.upstream.peerId;
  }
  return undefined;
}

function sameUpstream(
  left: ParticipantRouteAssignment,
  right: ParticipantRouteAssignment,
): boolean {
  return (
    left.upstream.kind === right.upstream.kind &&
    (left.upstream.kind !== "peer" ||
      (right.upstream.kind === "peer" &&
        left.upstream.peerId === right.upstream.peerId))
  );
}

function isHardBadViewerQualityWindow(
  evidence: Extract<ServerMessage, { type: "viewer-quality-evidence" }>,
): boolean {
  const metrics = evidence.metrics;
  const freezeRatio =
    metrics.freezeDurationMsDelta === null
      ? null
      : metrics.freezeDurationMsDelta / evidence.windowMs;
  if (freezeRatio !== null && freezeRatio >= VIEWER_QUALITY_FREEZE_RATIO) {
    return true;
  }
  if (
    metrics.packetsReceivedDelta !== null &&
    metrics.packetsReceivedDelta > 0 &&
    metrics.framesDecodedDelta === 0
  ) {
    return true;
  }
  if (
    metrics.packetsReceivedDelta === null ||
    metrics.packetsLostDelta === null
  ) {
    return false;
  }
  const totalPackets =
    metrics.packetsReceivedDelta + metrics.packetsLostDelta;
  return (
    totalPackets >= VIEWER_QUALITY_MIN_LOSS_PACKETS &&
    metrics.packetsLostDelta / totalPackets >= VIEWER_QUALITY_HIGH_LOSS_RATIO
  );
}

function isHardBadParentEdgeQualityProof(
  proof: ParentEdgeQualityProof,
): boolean {
  if (proof.kind === "sender-limited") {
    return true;
  }
  if (proof.kind !== "remote-loss") {
    return false;
  }
  return (
    proof.packetsSentDelta >= VIEWER_QUALITY_MIN_LOSS_PACKETS &&
    proof.remotePacketsLostDelta / proof.packetsSentDelta >=
      VIEWER_QUALITY_HIGH_LOSS_RATIO
  );
}
