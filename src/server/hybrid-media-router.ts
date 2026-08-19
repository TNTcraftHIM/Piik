import { randomBytes } from "node:crypto";

import {
  MAX_MEDIA_ROUTE_REVISION,
  type ClientMessage,
  type MediaAssignment,
  type ParticipantRouteAssignment,
  type RelayDownstreamEdges,
  type Role,
  type ServerMessage,
} from "../shared/protocol.js";
import type { SfuTokenIssuer } from "./livekit-token.js";
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

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

const DEFAULT_SFU_PREPARE_TIMEOUT_MS = 5_000;
interface PendingRoutePreparation {
  revision: number;
  intentPeerId: string;
  expectedSessionIds: ReadonlyMap<string, string>;
  grantsIssued: boolean;
  timer: NodeJS.Timeout;
}

interface ViewerRouteIntent {
  failedParentPeerId: string | null;
  sessionId: string;
  sfuAttempts: number;
  unavailableReported: boolean;
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
  sendToSession: (sessionId: string, message: ServerMessage) => void;
  getConnectionId: (roomId: string, viewerPeerId: string) => string | undefined;
  deleteConnectionId: (roomId: string, viewerPeerId: string) => void;
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
  private readonly relayCapacitySessionsByRoom = new Map<
    string,
    Map<string, string>
  >();
  private readonly sfuDisabledRoomIds = new Set<string>();

  constructor(private readonly options: HybridMediaRouterOptions) {
    const fallback = options.sfuFallback;
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
    this.mediaRouteControllers.clear();
    this.failedParentPeerIdsByViewer.clear();
    this.viewerRouteIntentsByRoom.clear();
    this.consumedSfuRefreshesByRoom.clear();
    this.relayCapacitySessionsByRoom.clear();
    this.sfuDisabledRoomIds.clear();
  }

  connectParticipant(input: AuthenticatedRouteParticipant): HybridAuthenticationState {
    this.clearSfuRefreshesForPeer(input.roomId, input.peerId);
    if (input.role === "viewer") {
      this.failedParentPeerIdsByViewer.delete(
        viewerConnectionKey(input.roomId, input.peerId),
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
    const controller = this.mediaRouteControllers.get(roomId);
    if (!controller) {
      return false;
    }
    const assignments = controller.getActiveRoute().assignments;
    const child = assignments.get(childPeerId);
    return (
      child?.upstream.kind === "peer" &&
      child.upstream.peerId === parentPeerId &&
      assignments.get(parentPeerId)?.childPeerIds.includes(childPeerId) === true
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
    const changes = this.peerRelayTopology.setViewerRelayCapacity(
      participant.roomId,
      participant.peerId,
      downstreamEdges,
      this.connectedPeerIds(participant.roomId),
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

  handleRouteReady(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-ready" }>,
  ): void {
    const controller = this.mediaRouteControllers.get(participant.roomId);
    if (!controller) {
      return;
    }
    if (message.phase === "active") {
      const active = controller.getActiveRoute();
      if (
        active.revision === message.revision &&
        active.assignments.has(participant.peerId)
      ) {
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

    controller.ready(participant.peerId, message.revision, "prepare");
    this.commitPendingRoute(participant.roomId, message.revision);
  }

  handleRouteFailed(
    participant: AuthenticatedRouteParticipant,
    message: Extract<ClientMessage, { type: "route-failed" }>,
  ): void {
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
      this.failBackToPeerBaseline(participant.roomId);
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

    let failedParents = this.failedParentPeerIdsByViewer.get(connectionKey);
    if (!failedParents) {
      failedParents = new Set();
      this.failedParentPeerIdsByViewer.set(connectionKey, failedParents);
    }
    if (failedParents.has(assignment.upstream.peerId)) {
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

  disconnectParticipant(roomId: string): void {
    const pending = this.pendingRoutePreparations.get(roomId);
    if (!pending || this.pendingSessionsAreCurrent(roomId, pending)) {
      return;
    }
    this.abortPendingRouteForTopologyChange(roomId);
  }

  removeViewer(roomId: string, peerId: string): void {
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
    if (message.connectionId !== null) {
      this.sendError(
        participant.sessionId,
        "FORBIDDEN",
        "Prepare failures do not identify a peer connection",
      );
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
    this.abortPendingRoute(participant.roomId);
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
    if (this.pendingRoutePreparations.has(roomId)) {
      return;
    }
    const intents = this.viewerRouteIntentsByRoom.get(roomId);
    if (!intents) {
      return;
    }

    for (const [viewerPeerId, intent] of [...intents]) {
      const viewer = this.options.roomStore.getConnectedViewer(
        roomId,
        viewerPeerId,
      );
      const controller = this.mediaRouteControllers.get(roomId);
      const assignment = controller
        ?.getActiveRoute()
        .assignments.get(viewerPeerId);
      if (viewer?.sessionId !== intent.sessionId || !assignment) {
        intents.delete(viewerPeerId);
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
        const changes = this.peerRelayTopology.reassignViewer(
          roomId,
          viewerPeerId,
          this.connectedPeerIds(roomId),
          excludedParents,
          MAX_PEER_RELAY_DEPTH,
        );
        if (changes) {
          intents.delete(viewerPeerId);
          this.clearChangedConnectionIds(roomId, changes);
          this.reconcileMediaRoute(roomId);
          this.sendMediaAssignmentChanges(roomId, changes);
          continue;
        }
      } else {
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
          intents.delete(viewerPeerId);
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
          intents.delete(viewerPeerId);
          this.clearChangedConnectionIds(roomId, changes);
          this.reconcileMediaRoute(roomId);
          this.sendMediaAssignmentChanges(roomId, changes);
          continue;
        }
      }

      if (
        intent.sfuAttempts === 0 &&
        this.options.sfuFallback &&
        !this.sfuDisabledRoomIds.has(roomId)
      ) {
        const result = this.prepareSfuFallback(
          roomId,
          viewerPeerId,
          intent.sessionId,
        );
        if (result === "started") {
          intent.sfuAttempts += 1;
          return;
        }
        if (result === "busy") {
          return;
        }
        intent.unavailableReported = true;
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

  private prepareSfuFallback(
    roomId: string,
    failedPeerId: string,
    sourceSessionId: string,
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
      expectedSessionIds,
      grantsIssued: false,
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
    const before = controller.getActiveRoute();
    if (!controller.commit(revision)) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRoutePreparations.delete(roomId);
    const active = controller.getActiveRoute();
    this.clearChangedRouteConnectionIds(roomId, before, active);
    this.broadcastActiveRoute(roomId, active);
    this.drainViewerRouteIntents(roomId);
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
    const intent = pending
      ? this.viewerRouteIntentsByRoom
          .get(roomId)
          ?.get(pending.intentPeerId)
      : undefined;
    if (intent) {
      intent.sfuAttempts = 0;
      intent.unavailableReported = false;
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
    this.consumedSfuRefreshesByRoom.delete(roomId);
    this.sfuDisabledRoomIds.delete(roomId);
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
