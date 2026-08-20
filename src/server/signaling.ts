import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  DEFAULT_HOST_DISPLAY_NAME_PREFIX,
  DEFAULT_VIEWER_DISPLAY_NAME,
  DEFAULT_QUALITY_SETTINGS,
  MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES,
  MAX_SIGNAL_BYTES,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  SIGNALING_PROTOCOL,
  VIEWER_QUALITY_EVIDENCE_INTERVAL_MS,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
  decodeClientMessage,
  type ClientMessage,
  type QualitySettings,
  type Role,
  type ServerMessage,
  type ParticipantPresenceEntry,
} from "../shared/protocol.js";
import {
  RoomStore,
  RoomStoreError,
  type ConnectedPeer,
} from "./room-store.js";
import type { SelectedEdgeTurnConfig } from "./config.js";
import {
  HybridMediaRouter,
  type SfuFallbackOptions,
} from "./hybrid-media-router.js";
import { createIceConfig, type IceConfigOptions } from "./ice.js";

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

const MAX_BUFFERED_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_SIGNAL_CONNECTIONS = 2_048;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS = 256;

interface AuthenticatedSession {
  roomId: string;
  role: Role;
  peerId: string;
  roomExpiresAtMs: number | null;
  shareGeneration: string | null;
  displayName: string | null;
  viewerPresence: boolean;
  viewerPasswordSettings: boolean;
}

interface SocketState {
  sessionId: string;
  alive: boolean;
  authenticationTimer: NodeJS.Timeout;
  hostAdmissionAuthenticated: boolean;
  revoked?: boolean;
  authenticating?: boolean;
  viewerPasswordUpdatePending?: boolean;
  authenticated?: AuthenticatedSession;
}

interface ViewerQualityEvidenceGate {
  viewerSessionId: string;
  parentSessionId: string;
  parentPeerId: string;
  connectionId: string;
  routeRevision: number;
  sequence: number;
  acceptedAtMs: number;
  parentEvidenceAccepted: boolean;
}

export interface SignalingOptions {
  server: HttpServer;
  roomStore: RoomStore;
  peerAssistedMedia: boolean;
  peerAssistedRoomIds?: ReadonlySet<string>;
  sfuFallback?: SfuFallbackOptions;
  selectedEdgeTurn?: SelectedEdgeTurnConfig;
  ice: IceConfigOptions;
  allowedOrigins: ReadonlySet<string>;
  hostAdmissionAtUpgrade: (request: IncomingMessage) => boolean;
  publicBaseUrl: URL;
  now?: () => number;
  authenticationTimeoutMs?: number;
  viewerDisconnectGraceMs?: number;
  heartbeatIntervalMs?: number;
  cleanupIntervalMs?: number;
  passThroughUnknownUpgrades?: boolean;
  maxConnections?: number;
  maxUnauthenticatedConnections?: number;
}

export class SignalingServer {
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNAL_BYTES,
    perMessageDeflate: false,
  });
  private readonly socketStates = new Map<WebSocket, SocketState>();
  private readonly socketsBySessionId = new Map<string, WebSocket>();
  private readonly viewerGraceTimers = new Map<string, NodeJS.Timeout>();
  private readonly connectionIdsByViewer = new Map<string, string>();
  private readonly viewerQualityEvidenceGates = new Map<
    string,
    ViewerQualityEvidenceGate
  >();
  private readonly qualitySettingsByRoom = new Map<string, QualitySettings>();
  private readonly shareGenerationsByRoom = new Map<string, string>();
  private readonly deferredViewerPresenceRooms = new Set<string>();
  private readonly hybridMediaRouter?: HybridMediaRouter;
  private readonly now: () => number;
  private readonly authenticationTimeoutMs: number;
  private readonly viewerDisconnectGraceMs: number;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly upgradeHandler: Parameters<HttpServer["on"]>[1];
  private readonly maxConnections: number;
  private readonly maxUnauthenticatedConnections: number;
  private unauthenticatedConnections = 0;
  private closing = false;

  constructor(private readonly options: SignalingOptions) {
    this.now = options.now ?? Date.now;
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
    this.viewerDisconnectGraceMs = options.viewerDisconnectGraceMs ?? 5_000;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_SIGNAL_CONNECTIONS;
    this.maxUnauthenticatedConnections =
      options.maxUnauthenticatedConnections ??
      DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS;
    if (
      !Number.isSafeInteger(this.maxConnections) ||
      this.maxConnections <= 0 ||
      !Number.isSafeInteger(this.maxUnauthenticatedConnections) ||
      this.maxUnauthenticatedConnections <= 0 ||
      this.maxUnauthenticatedConnections > this.maxConnections
    ) {
      throw new Error("WebSocket connection limits are invalid");
    }
    if (options.sfuFallback && !options.peerAssistedMedia) {
      throw new Error("SFU fallback requires peer-assisted media");
    }
    if (options.peerAssistedRoomIds && !options.peerAssistedMedia) {
      throw new Error("Peer-assisted room IDs require peer-assisted media");
    }
    if (
      options.peerAssistedMedia &&
      (!options.peerAssistedRoomIds || options.peerAssistedRoomIds.size === 0)
    ) {
      throw new Error("Peer-assisted media requires exact room IDs");
    }
    if (options.peerAssistedMedia) {
      this.hybridMediaRouter = new HybridMediaRouter({
        roomStore: options.roomStore,
        sfuFallback: options.sfuFallback,
        selectedEdgeTurn: options.selectedEdgeTurn,
        sendToSession: (sessionId, message) =>
          this.sendToSession(sessionId, message),
        getConnectionId: (roomId, viewerPeerId) =>
          this.connectionIdsByViewer.get(
            viewerConnectionKey(roomId, viewerPeerId),
          ),
        deleteConnectionId: (roomId, viewerPeerId) =>
          this.deleteViewerConnectionId(roomId, viewerPeerId),
        getShareGeneration: (roomId) => this.shareGenerationsByRoom.get(roomId),
        onActiveRouteChanged: (roomId) => this.sendViewerPresence(roomId),
        now: this.now,
      });
    }

    this.upgradeHandler = (request, socket, head) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? "/", "http://localhost");
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (requestUrl.pathname !== "/signal" || requestUrl.search !== "") {
        if (!options.passThroughUnknownUpgrades) {
          rejectUpgrade(socket, 404, "Not Found");
        }
        return;
      }
      if (!this.isAllowedOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      if (!this.hasConnectionCapacity()) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      // No asynchronous verifyClient hook is installed: handleUpgrade emits
      // connection synchronously, so accept() counts this slot before another
      // upgrade event can observe the limit.
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    };
    options.server.on("upgrade", this.upgradeHandler);
    this.webSocketServer.on("connection", (socket, request) =>
      this.accept(socket, options.hostAdmissionAtUpgrade(request)),
    );

    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      options.heartbeatIntervalMs ?? 30_000,
    );
    this.cleanupTimer = setInterval(
      () => this.expireRooms(),
      options.cleanupIntervalMs ?? 30_000,
    );
    this.heartbeatTimer.unref();
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.cleanupTimer);
    for (const timer of this.viewerGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.viewerGraceTimers.clear();
    this.hybridMediaRouter?.close();
    this.viewerQualityEvidenceGates.clear();
    this.shareGenerationsByRoom.clear();
    this.options.server.off("upgrade", this.upgradeHandler);

    for (const socket of this.webSocketServer.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
  }

  private accept(socket: WebSocket, hostAdmissionAuthenticated: boolean): void {
    if (!this.hasConnectionCapacity()) {
      socket.terminate();
      return;
    }

    const sessionId = randomBytes(16).toString("base64url");
    const authenticationTimer = setTimeout(() => {
      this.sendError(socket, "AUTH_REQUIRED", "Authentication timed out");
      socket.close(4001, "Authentication required");
    }, this.authenticationTimeoutMs);
    authenticationTimer.unref();

    const state: SocketState = {
      sessionId,
      alive: true,
      authenticationTimer,
      hostAdmissionAuthenticated,
    };
    this.socketStates.set(socket, state);
    this.socketsBySessionId.set(sessionId, socket);
    this.unauthenticatedConnections += 1;

    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.rejectInvalidMessage(socket);
        return;
      }
      this.handleMessage(socket, data.toString());
    });
    socket.on("close", () => this.handleDisconnect(socket));
    socket.on("error", () => {
      // The close handler owns cleanup. Never log signaling payloads or tokens.
    });
  }

  private handleMessage(socket: WebSocket, encoded: string): void {
    const state = this.socketStates.get(socket);
    if (!state) {
      return;
    }
    if (state.revoked) {
      return;
    }

    let message: ClientMessage;
    try {
      message = decodeClientMessage(encoded);
    } catch {
      if (!state.authenticated) {
        this.sendError(
          socket,
          "AUTH_REQUIRED",
          "页面版本已更新，请刷新后重试",
        );
        socket.close(4001, "Protocol mismatch");
      } else {
        this.rejectInvalidMessage(socket);
      }
      return;
    }
    if (
      ((message.type === "viewer-quality-evidence" &&
        Buffer.byteLength(encoded, "utf8") >
          MAX_VIEWER_QUALITY_EVIDENCE_BYTES) ||
        (message.type === "parent-edge-quality-evidence" &&
          Buffer.byteLength(encoded, "utf8") >
            MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES))
    ) {
      this.rejectInvalidMessage(socket);
      return;
    }

    if (!state.authenticated) {
      if (message.type !== "authenticate") {
        this.sendError(socket, "AUTH_REQUIRED", "Authenticate before sending messages");
        socket.close(4001, "Authentication required");
        return;
      }
      if (state.authenticating) {
        this.rejectInvalidMessage(socket);
        return;
      }
      state.authenticating = true;
      void this.authenticate(socket, state, message).finally(() => {
        if (this.socketStates.get(socket) === state) {
          state.authenticating = false;
        }
      });
      return;
    }
    if (message.type === "authenticate") {
      this.sendError(socket, "FORBIDDEN", "Session is already authenticated");
      return;
    }

    if (
      state.authenticated.roomExpiresAtMs !== null &&
      this.now() >= state.authenticated.roomExpiresAtMs
    ) {
      this.expireRooms();
      return;
    }
    if (!this.isCurrentSession(state)) {
      socket.close(4001, "Session replaced");
      return;
    }

    this.handleAuthenticatedMessage(socket, state.authenticated, message);
  }

  private async authenticate(
    socket: WebSocket,
    state: SocketState,
    message: Extract<ClientMessage, { type: "authenticate" }>,
  ): Promise<void> {
    if (message.role === "host" && !state.hostAdmissionAuthenticated) {
      this.sendError(socket, "AUTH_REQUIRED", "Host admission is required");
      socket.close(4003, "Authentication failed");
      return;
    }

    let participant;
    try {
      if (
        message.role === "viewer" &&
        !message.viewerGrant &&
        message.viewerPassword !== undefined
      ) {
        participant = await this.options.roomStore.connectViewerWithPassword(
          {
            roomId: message.roomId,
            password: message.viewerPassword,
            clientId: message.clientId,
            sessionId: state.sessionId,
          },
          () =>
            this.socketStates.get(socket) === state &&
            !state.revoked &&
            !state.authenticated &&
            socket.readyState === WebSocket.OPEN,
        );
      } else {
        participant = this.options.roomStore.connectParticipant(
          message.role === "host"
            ? {
                roomId: message.roomId,
                role: "host",
                token: message.token,
                clientId: message.clientId,
                sessionId: state.sessionId,
              }
            : {
                roomId: message.roomId,
                role: "viewer",
                ...(message.viewerGrant
                  ? { viewerGrant: message.viewerGrant }
                  : {}),
                clientId: message.clientId,
                sessionId: state.sessionId,
              },
        );
      }
    } catch (error) {
      if (this.socketStates.get(socket) !== state || state.revoked) {
        return;
      }
      if (!(error instanceof RoomStoreError)) {
        console.error("Signaling authentication failed unexpectedly");
      }
      const code =
        error instanceof RoomStoreError && error.code !== "ROOM_LIMIT"
          ? error.code
          : "SERVER_ERROR";
      this.sendError(socket, code, authenticationErrorMessage(code));
      socket.close(4003, "Authentication failed");
      return;
    }

    clearTimeout(state.authenticationTimer);
    this.unauthenticatedConnections -= 1;
    let shareGeneration: string | null = null;
    if (participant.role === "host" && message.role === "host") {
      const currentGeneration = this.shareGenerationsByRoom.get(
        participant.roomId,
      );
      shareGeneration =
        message.shareGeneration ?? currentGeneration ?? state.sessionId;
      if (
        currentGeneration !== undefined &&
        currentGeneration !== shareGeneration
      ) {
        this.stopSharing(participant.roomId);
      }
      this.shareGenerationsByRoom.set(participant.roomId, shareGeneration);
    }
    state.authenticated = {
      roomId: participant.roomId,
      role: participant.role,
      peerId: participant.peerId,
      roomExpiresAtMs:
        participant.expiresAt === null
          ? null
          : Date.parse(participant.expiresAt),
      shareGeneration,
      displayName:
        message.role === "host"
          ? message.viewerPresence === true
            ? (message.displayName ?? DEFAULT_HOST_DISPLAY_NAME_PREFIX)
            : null
          : (message.displayName ?? DEFAULT_VIEWER_DISPLAY_NAME),
      viewerPresence: message.viewerPresence === true,
      viewerPasswordSettings: false,
    };
    if (participant.role === "viewer") {
      this.viewerQualityEvidenceGates.delete(
        viewerConnectionKey(participant.roomId, participant.peerId),
      );
    }
    this.clearViewerGrace(participant.roomId, participant.peerId);
    const routeParticipant = {
      roomId: participant.roomId,
      role: participant.role,
      peerId: participant.peerId,
      sessionId: state.sessionId,
    };
    let hybridState;
    try {
      hybridState = this.isPeerAssistedRoom(participant.roomId)
        ? this.hybridMediaRouter!.connectParticipant(routeParticipant)
        : undefined;
    } catch {
      console.error("Peer relay topology did not assign an authenticated participant");
      this.sendError(socket, "SERVER_ERROR", "Media assignment failed");
      socket.close(1011, "Media assignment failed");
      return;
    }
    const connectionId =
      participant.role === "viewer"
        ? (this.connectionIdsByViewer.get(
            viewerConnectionKey(participant.roomId, participant.peerId),
          ) ?? null)
        : null;
    const connectedViewers =
      participant.role === "host"
        ? this.options.roomStore.getConnectedViewers(participant.roomId)
        : [];

    const authenticatedMessage = {
      type: "authenticated" as const,
      protocol: SIGNALING_PROTOCOL,
      role: participant.role,
      peerId: participant.peerId,
      roomExpiresAt: participant.expiresAt,
      maxViewers: this.options.roomStore.maxViewersPerRoom,
      hostOnline: participant.hostOnline,
      connectionId,
      viewerPeerIds: [...participant.viewerPeerIds],
      iceConfig: this.iceConfig(),
      viewerPolicy: participant.viewerPolicy,
      viewerAuthorizationGeneration:
        participant.viewerAuthorizationGeneration,
    } satisfies Extract<ServerMessage, { type: "authenticated" }>;
    if (hybridState) {
      this.send(socket, {
        ...authenticatedMessage,
        mediaMode: "peer-assisted",
        mediaAssignment: hybridState.mediaAssignment,
        routeRevision: hybridState.routeRevision,
        routeAssignment: hybridState.routeAssignment,
        qualitySettings:
          this.qualitySettingsByRoom.get(participant.roomId) ??
          DEFAULT_QUALITY_SETTINGS,
        ...(this.options.sfuFallback
          ? { sfuStandbyUrl: this.options.sfuFallback.url }
          : {}),
      });
    } else {
      this.send(socket, authenticatedMessage);
    }
    state.authenticated.viewerPasswordSettings =
      message.role === "host" && message.viewerPasswordSettings === true;
    if (state.authenticated.viewerPasswordSettings) {
      this.send(socket, {
        type: "viewer-password-updated",
        enabled: participant.viewerPasswordEnabled,
      });
    }

    if (participant.replacedSessionId) {
      const replaced = this.socketsBySessionId.get(participant.replacedSessionId);
      if (replaced && replaced !== socket) {
        replaced.close(4001, "Session replaced");
      }
    }

    if (hybridState) {
      this.hybridMediaRouter!.completeAuthentication(
        routeParticipant,
        hybridState,
      );
    }

    this.sendViewerPresence(participant.roomId);

    if (participant.role === "host") {
      for (const viewer of connectedViewers) {
        this.sendToSession(viewer.sessionId, { type: "host-status", online: true });
        if (!this.isPeerAssistedRoom(participant.roomId)) {
          this.send(socket, { type: "peer-joined", peerId: viewer.peerId });
        }
      }
      return;
    }

    if (this.isPeerAssistedRoom(participant.roomId)) {
      return;
    }

    const host = this.options.roomStore.getConnectedHost(participant.roomId);
    if (!host) {
      return;
    }
    // Re-authentication is also a presence assertion. The host treats this
    // event idempotently, which closes races where its local peer was rebuilt
    // while the viewer retained the same server-side connection ID.
    this.sendToSession(host.sessionId, {
      type: "peer-joined",
      peerId: participant.peerId,
    });
  }

  private handleAuthenticatedMessage(
    socket: WebSocket,
    authenticated: AuthenticatedSession,
    message: Exclude<ClientMessage, { type: "authenticate" }>,
  ): void {
    switch (message.type) {
      case "signal":
        this.routeSignal(socket, authenticated, message);
        return;
      case "restart-request":
        if (authenticated.role !== "viewer") {
          this.sendError(socket, "FORBIDDEN", "Only viewers may request an ICE restart");
          return;
        }
        if (this.isPeerAssistedRoom(authenticated.roomId)) {
          this.routePeerAssistedRestart(socket, authenticated, message);
          return;
        }
        if (message.targetPeerId) {
          this.sendError(socket, "FORBIDDEN", "P2P restart requests target the host implicitly");
          return;
        }
        this.routeToHost(socket, authenticated, {
          type: "restart-request",
          fromPeerId: authenticated.peerId,
          connectionId: message.connectionId,
          rebuild: message.rebuild,
        });
        return;
      case "set-quality-settings":
        if (
          !this.isPeerAssistedRoom(authenticated.roomId) ||
          authenticated.role !== "host"
        ) {
          this.sendError(
            socket,
            "FORBIDDEN",
            "Only a peer-assisted host may set quality settings",
          );
          return;
        }
        this.qualitySettingsByRoom.set(
          authenticated.roomId,
          { ...message.qualitySettings },
        );
        for (const viewer of this.options.roomStore.getConnectedViewers(
          authenticated.roomId,
        )) {
          this.sendToSession(viewer.sessionId, {
            type: "quality-settings",
            qualitySettings: message.qualitySettings,
          });
        }
        return;
      case "relay-capacity":
        if (
          !this.isPeerAssistedRoom(authenticated.roomId) ||
          authenticated.role !== "viewer"
        ) {
          this.sendError(
            socket,
            "FORBIDDEN",
            "Only a peer-assisted viewer may advertise relay capacity",
          );
          return;
        }
        this.hybridMediaRouter!.setViewerRelayCapacity(
          {
            ...authenticated,
            sessionId: this.socketStates.get(socket)!.sessionId,
          },
          message.downstreamEdges,
        );
        return;
      case "route-ready":
        if (!this.isPeerAssistedRoom(authenticated.roomId)) {
          this.sendError(socket, "FORBIDDEN", "Media routes are not enabled");
          return;
        }
        this.hybridMediaRouter!.handleRouteReady(
          {
            ...authenticated,
            sessionId: this.socketStates.get(socket)!.sessionId,
          },
          message,
        );
        return;
      case "route-failed":
        if (!this.isPeerAssistedRoom(authenticated.roomId)) {
          this.sendError(socket, "FORBIDDEN", "Media routes are not enabled");
          return;
        }
        this.hybridMediaRouter!.handleRouteFailed(
          {
            ...authenticated,
            sessionId: this.socketStates.get(socket)!.sessionId,
          },
          message,
        );
        return;
      case "refresh-sfu":
        if (
          !this.options.sfuFallback ||
          !this.isPeerAssistedRoom(authenticated.roomId)
        ) {
          this.sendError(socket, "FORBIDDEN", "SFU fallback is not enabled");
          return;
        }
        this.hybridMediaRouter!.refreshSfu(
          {
            ...authenticated,
            sessionId: this.socketStates.get(socket)!.sessionId,
          },
          message.revision,
        );
        return;
      case "viewer-quality-evidence":
        this.handleViewerQualityEvidence(socket, authenticated, message);
        return;
      case "parent-edge-quality-evidence":
        this.handleParentEdgeQualityEvidence(socket, authenticated, message);
        return;
      case "set-display-name":
        if (
          authenticated.role === "host" &&
          !authenticated.viewerPresence
        ) {
          this.sendError(
            socket,
            "FORBIDDEN",
            "Display names require the Web presence capability",
          );
          return;
        }
        authenticated.displayName = message.displayName;
        this.sendViewerPresence(authenticated.roomId);
        return;
      case "set-viewer-access":
        if (authenticated.role !== "host") {
          this.sendError(
            socket,
            "FORBIDDEN",
            "Only the host may change Viewer access",
          );
          return;
        }
        this.updateViewerAccess(socket, authenticated, message.action);
        return;
      case "set-viewer-password": {
        if (
          authenticated.role !== "host" ||
          !authenticated.viewerPasswordSettings
        ) {
          this.sendError(
            socket,
            "FORBIDDEN",
            "Viewer password settings are unavailable",
          );
          return;
        }
        const socketState = this.socketStates.get(socket);
        if (!socketState || socketState.viewerPasswordUpdatePending) {
          this.sendError(socket, "FORBIDDEN", "Viewer password update is busy");
          return;
        }
        socketState.viewerPasswordUpdatePending = true;
        void this.updateViewerPassword(
          socket,
          authenticated,
          socketState,
          message.password,
        ).finally(() => {
          if (this.socketStates.get(socket) === socketState) {
            socketState.viewerPasswordUpdatePending = false;
          }
        });
        return;
      }
      case "stop-sharing":
        if (authenticated.role !== "host") {
          this.sendError(socket, "FORBIDDEN", "Only the host may stop sharing");
          return;
        }
        if (
          authenticated.shareGeneration === null ||
          this.shareGenerationsByRoom.get(authenticated.roomId) !==
            authenticated.shareGeneration ||
          (message.shareGeneration !== undefined &&
            message.shareGeneration !== authenticated.shareGeneration)
        ) {
          socket.close(4001, "Sharing generation replaced");
          return;
        }
        const state = this.socketStates.get(socket);
        if (state?.authenticated === authenticated) {
          this.options.roomStore.disconnectParticipant(
            authenticated.roomId,
            authenticated.peerId,
            state.sessionId,
          );
          this.sendViewerPresence(authenticated.roomId);
        }
        this.stopSharing(authenticated.roomId);
        socket.close(1000, "Sharing stopped");
        return;
      case "abandon-room":
        if (authenticated.role !== "host") {
          this.sendError(socket, "FORBIDDEN", "Only the host may abandon the room");
          return;
        }
        try {
          this.abandonRoom(authenticated.roomId);
        } catch (error) {
          console.error("Room abandonment failed", error);
          this.sendError(socket, "SERVER_ERROR", "Room could not be abandoned");
        }
        return;
    }
  }

  private updateViewerAccess(
    hostSocket: WebSocket,
    authenticated: AuthenticatedSession,
    action: "public-watch" | "rotate" | "revoke",
  ): void {
    let update;
    try {
      update = this.options.roomStore.setViewerAccess(
        authenticated.roomId,
        action,
      );
    } catch (error) {
      console.error("Viewer access update failed", error);
      this.sendError(hostSocket, "SERVER_ERROR", "Viewer access could not be updated");
      return;
    }

    if (update.revokedViewers.length > 0) {
      this.clearRoomGraceTimers(authenticated.roomId);
      this.clearRoomConnectionIds(authenticated.roomId);

      this.deferredViewerPresenceRooms.add(authenticated.roomId);
      try {
        for (const viewer of update.revokedViewers) {
          if (!viewer.sessionId) {
            continue;
          }
          this.sendToSession(viewer.sessionId, {
            type: "viewer-access-revoked",
            viewerAuthorizationGeneration:
              update.previousViewerAuthorizationGeneration,
          });
        }

        if (this.isPeerAssistedRoom(authenticated.roomId)) {
          for (const viewer of update.revokedViewers) {
            this.hybridMediaRouter!.removeViewer(
              authenticated.roomId,
              viewer.peerId,
            );
          }
        } else {
          const host = this.options.roomStore.getConnectedHost(authenticated.roomId);
          if (host) {
            for (const viewer of update.revokedViewers) {
              this.sendToSession(host.sessionId, {
                type: "peer-left",
                peerId: viewer.peerId,
              });
            }
          }
        }

        for (const viewer of update.revokedViewers) {
          if (!viewer.sessionId) {
            continue;
          }
          this.closeRevokedViewerSession(viewer.sessionId);
        }
      } finally {
        this.deferredViewerPresenceRooms.delete(authenticated.roomId);
      }
      this.sendViewerPresence(authenticated.roomId);
    }

    const inviteUrl =
      action === "revoke"
        ? null
        : this.viewerInviteUrl(authenticated.roomId, update.viewerGrant);
    this.send(hostSocket, {
      type: "viewer-access-updated",
      viewerPolicy: update.viewerPolicy,
      viewerAuthorizationGeneration: update.viewerAuthorizationGeneration,
      inviteUrl,
      viewerGrantExpiresAt: update.viewerGrantExpiresAt,
    });
  }

  private async updateViewerPassword(
    hostSocket: WebSocket,
    authenticated: AuthenticatedSession,
    state: SocketState,
    password: string | null,
  ): Promise<void> {
    try {
      const enabled = await this.options.roomStore.setViewerPassword(
        authenticated.roomId,
        password,
        state.sessionId,
      );
      if (
        this.socketStates.get(hostSocket) !== state ||
        state.authenticated !== authenticated ||
        state.revoked
      ) {
        return;
      }
      this.send(hostSocket, { type: "viewer-password-updated", enabled });
    } catch {
      if (
        this.socketStates.get(hostSocket) === state &&
        state.authenticated === authenticated &&
        !state.revoked
      ) {
        console.error("Viewer password update failed");
        this.sendError(
          hostSocket,
          "SERVER_ERROR",
          "Viewer password could not be updated",
        );
      }
    }
  }

  private handleViewerQualityEvidence(
    socket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<ClientMessage, { type: "viewer-quality-evidence" }>,
  ): void {
    if (source.role !== "viewer") {
      return;
    }
    const viewerState = this.socketStates.get(socket);
    if (!viewerState || viewerState.authenticated !== source) {
      return;
    }

    const connectionId = this.connectionIdsByViewer.get(
      viewerConnectionKey(source.roomId, source.peerId),
    );
    if (!connectionId || message.guard.connectionId !== connectionId) {
      return;
    }

    let routeRevision = 0;
    let parent: ConnectedPeer | undefined;
    if (this.isPeerAssistedRoom(source.roomId)) {
      const edge = this.hybridMediaRouter?.resolveActivePeerEdge(
        source.roomId,
        source.peerId,
      );
      if (!edge) {
        return;
      }
      routeRevision = edge.revision;
      parent = this.connectedPeer(source.roomId, edge.parentPeerId);
    } else {
      parent = this.options.roomStore.getConnectedHost(source.roomId);
    }
    if (
      !parent ||
      message.guard.routeRevision !== routeRevision ||
      parent.peerId === source.peerId
    ) {
      return;
    }

    const gateKey = viewerConnectionKey(source.roomId, source.peerId);
    const previous = this.viewerQualityEvidenceGates.get(gateKey);
    const sameGeneration =
      previous?.viewerSessionId === viewerState.sessionId &&
      previous.parentSessionId === parent.sessionId &&
      previous.parentPeerId === parent.peerId &&
      previous.connectionId === connectionId &&
      previous.routeRevision === routeRevision;
    const now = this.now();
    if (
      sameGeneration &&
      previous &&
      (message.sequence <= previous.sequence ||
        now - previous.acceptedAtMs < VIEWER_QUALITY_EVIDENCE_INTERVAL_MS)
    ) {
      return;
    }

    const forwarded = {
      type: "viewer-quality-evidence" as const,
      viewerPeerId: source.peerId,
      parentPeerId: parent.peerId,
      guard: {
        connectionId,
        routeRevision,
      },
      sequence: message.sequence,
      windowMs: message.windowMs,
      metrics: message.metrics,
    };
    const encoded = JSON.stringify(forwarded);
    if (
      Buffer.byteLength(encoded, "utf8") >
      MAX_VIEWER_QUALITY_EVIDENCE_BYTES ||
      !this.sendEncodedToSession(parent.sessionId, encoded)
    ) {
      return;
    }
    this.viewerQualityEvidenceGates.set(gateKey, {
      viewerSessionId: viewerState.sessionId,
      parentSessionId: parent.sessionId,
      parentPeerId: parent.peerId,
      connectionId,
      routeRevision,
      sequence: message.sequence,
      acceptedAtMs: now,
      parentEvidenceAccepted: false,
    });
    if (this.isPeerAssistedRoom(source.roomId)) {
      this.hybridMediaRouter!.handleViewerQualityEvidence({
        roomId: source.roomId,
        viewerSessionId: viewerState.sessionId,
        parentSessionId: parent.sessionId,
        evidence: forwarded,
      });
    }
  }

  private handleParentEdgeQualityEvidence(
    socket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<
      ClientMessage,
      { type: "parent-edge-quality-evidence" }
    >,
  ): void {
    if (!this.isPeerAssistedRoom(source.roomId)) {
      return;
    }
    const sourceState = this.socketStates.get(socket);
    if (!sourceState || sourceState.authenticated !== source) {
      return;
    }
    const viewer = this.options.roomStore.getConnectedViewer(
      source.roomId,
      message.viewerPeerId,
    );
    const gate = this.viewerQualityEvidenceGates.get(
      viewerConnectionKey(source.roomId, message.viewerPeerId),
    );
    const edge = this.hybridMediaRouter?.resolveActivePeerEdge(
      source.roomId,
      message.viewerPeerId,
    );
    const connectionId = this.connectionIdsByViewer.get(
      viewerConnectionKey(source.roomId, message.viewerPeerId),
    );
    const now = this.now();
    if (
      !viewer ||
      !gate ||
      gate.parentEvidenceAccepted ||
      source.peerId !== gate.parentPeerId ||
      sourceState.sessionId !== gate.parentSessionId ||
      viewer.sessionId !== gate.viewerSessionId ||
      connectionId !== gate.connectionId ||
      edge?.parentPeerId !== source.peerId ||
      edge.revision !== gate.routeRevision ||
      message.guard.connectionId !== gate.connectionId ||
      message.guard.routeRevision !== gate.routeRevision ||
      message.viewerSequence !== gate.sequence ||
      now < gate.acceptedAtMs ||
      now - gate.acceptedAtMs > VIEWER_QUALITY_EVIDENCE_EXPIRY_MS
    ) {
      return;
    }

    gate.parentEvidenceAccepted = true;
    this.hybridMediaRouter!.handleParentEdgeQualityEvidence({
      roomId: source.roomId,
      viewerSessionId: viewer.sessionId,
      parentSessionId: sourceState.sessionId,
      evidence: message,
    });
  }

  private routeSignal(
    sourceSocket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<ClientMessage, { type: "signal" }>,
  ): void {
    if (this.isPeerAssistedRoom(source.roomId)) {
      this.routePeerAssistedSignal(sourceSocket, source, message);
      return;
    }

    const description =
      message.payload.kind === "description" ? message.payload.description : undefined;

    if (source.role === "host") {
      if (!message.targetPeerId || description?.type === "answer") {
        this.sendError(sourceSocket, "FORBIDDEN", "Host signals must target one viewer");
        return;
      }
      const viewer = this.options.roomStore.getConnectedViewer(
        source.roomId,
        message.targetPeerId,
      );
      if (!viewer) {
        this.sendError(sourceSocket, "PEER_NOT_FOUND", "Viewer is not connected");
        return;
      }
      if (description?.type === "offer") {
        this.setViewerConnectionId(
          source.roomId,
          viewer.peerId,
          message.payload.connectionId,
        );
      }
      this.sendToSession(viewer.sessionId, {
        type: "signal",
        fromPeerId: source.peerId,
        payload: message.payload,
      });
      return;
    }

    if (message.targetPeerId || description?.type === "offer") {
      this.sendError(sourceSocket, "FORBIDDEN", "Viewer signals may only reply to the host");
      return;
    }
    this.routeToHost(sourceSocket, source, {
      type: "signal",
      fromPeerId: source.peerId,
      payload: message.payload,
    });
  }

  private routePeerAssistedSignal(
    sourceSocket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<ClientMessage, { type: "signal" }>,
  ): void {
    const targetPeerId = message.targetPeerId;
    if (!targetPeerId) {
      this.sendError(
        sourceSocket,
        "FORBIDDEN",
        "Peer-assisted signals must target an assigned peer",
      );
      return;
    }
    const target = this.connectedPeer(source.roomId, targetPeerId);
    if (!target) {
      this.sendError(sourceSocket, "PEER_NOT_FOUND", "Target peer is not connected");
      return;
    }

    const parentToChild = this.hybridMediaRouter!.isActivePeerParentOf(
      source.roomId,
      source.peerId,
      targetPeerId,
    );
    const childToParent = this.hybridMediaRouter!.isActivePeerParentOf(
      source.roomId,
      targetPeerId,
      source.peerId,
    );
    const description =
      message.payload.kind === "description"
        ? message.payload.description
        : undefined;
    const selectedEdgeAuthorized =
      this.hybridMediaRouter!.selectedEdgeTurnSignalAuthorization({
        roomId: source.roomId,
        sourcePeerId: source.peerId,
        sourceSessionId: this.socketStates.get(sourceSocket)?.sessionId ?? "",
        targetPeerId: target.peerId,
        targetSessionId: target.sessionId,
        connectionId: message.payload.connectionId,
        signalKind: message.payload.kind,
        ...(description ? { descriptionType: description.type } : {}),
      });
    const assignedEdgeAuthorized = description
      ? description.type === "offer"
        ? parentToChild
        : childToParent
      : parentToChild || childToParent;
    const authorized = selectedEdgeAuthorized ?? assignedEdgeAuthorized;
    if (!authorized) {
      this.sendError(
        sourceSocket,
        "FORBIDDEN",
        "Signal target is not authorized by the media assignment",
      );
      return;
    }

    if (description?.type === "offer") {
      this.setViewerConnectionId(
        source.roomId,
        targetPeerId,
        message.payload.connectionId,
      );
    }
    this.sendToSession(target.sessionId, {
      type: "signal",
      fromPeerId: source.peerId,
      payload: message.payload,
    });
    if (selectedEdgeAuthorized && description?.type === "answer") {
      this.hybridMediaRouter!.markSelectedEdgeTurnAnswered(
        source.roomId,
        source.peerId,
        message.payload.connectionId,
      );
    }
  }

  private routePeerAssistedRestart(
    sourceSocket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<ClientMessage, { type: "restart-request" }>,
  ): void {
    const targetPeerId = message.targetPeerId;
    if (
      !targetPeerId ||
      !this.hybridMediaRouter!.isActivePeerParentOf(
        source.roomId,
        targetPeerId,
        source.peerId,
      )
    ) {
      this.sendError(
        sourceSocket,
        "FORBIDDEN",
        "Restart target is not the assigned media parent",
      );
      return;
    }
    const parent = this.connectedPeer(source.roomId, targetPeerId);
    if (!parent) {
      this.sendError(sourceSocket, "PEER_NOT_FOUND", "Media parent is not connected");
      return;
    }
    this.sendToSession(parent.sessionId, {
      type: "restart-request",
      fromPeerId: source.peerId,
      connectionId: message.connectionId,
      rebuild: message.rebuild,
    });
  }

  private routeToHost(
    sourceSocket: WebSocket,
    source: AuthenticatedSession,
    message: ServerMessage,
  ): void {
    const host = this.options.roomStore.getConnectedHost(source.roomId);
    if (!host) {
      this.sendError(sourceSocket, "PEER_NOT_FOUND", "Host is not connected");
      return;
    }
    this.sendToSession(host.sessionId, message);
  }

  private handleDisconnect(socket: WebSocket): void {
    const state = this.socketStates.get(socket);
    if (!state) {
      return;
    }
    clearTimeout(state.authenticationTimer);
    this.socketStates.delete(socket);
    if (this.socketsBySessionId.get(state.sessionId) === socket) {
      this.socketsBySessionId.delete(state.sessionId);
    }
    if (state.revoked) {
      return;
    }
    if (!state.authenticated) {
      this.unauthenticatedConnections -= 1;
      return;
    }
    if (this.closing) {
      return;
    }

    const disconnected = this.options.roomStore.disconnectParticipant(
      state.authenticated.roomId,
      state.authenticated.peerId,
      state.sessionId,
    );
    if (!disconnected) {
      return;
    }
    if (this.isPeerAssistedRoom(disconnected.roomId)) {
      this.hybridMediaRouter!.disconnectParticipant(
        disconnected.roomId,
        disconnected.peerId,
      );
    }
    if (disconnected.role === "host") {
      for (const viewer of this.options.roomStore.getConnectedViewers(
        disconnected.roomId,
      )) {
        this.sendToSession(viewer.sessionId, { type: "host-status", online: false });
      }
      this.sendViewerPresence(disconnected.roomId);
      return;
    }

    this.sendViewerPresence(disconnected.roomId);

    const key = viewerGraceKey(disconnected.roomId, disconnected.peerId);
    const timer = setTimeout(() => {
      this.viewerGraceTimers.delete(key);
      if (
        this.options.roomStore.removeDisconnectedViewer(
          disconnected.roomId,
          disconnected.peerId,
        )
      ) {
        this.deleteViewerConnectionId(
          disconnected.roomId,
          disconnected.peerId,
        );
        if (this.isPeerAssistedRoom(disconnected.roomId)) {
          this.hybridMediaRouter!.removeViewer(
            disconnected.roomId,
            disconnected.peerId,
          );
          return;
        }
        const host = this.options.roomStore.getConnectedHost(disconnected.roomId);
        if (host) {
          this.sendToSession(host.sessionId, {
            type: "peer-left",
            peerId: disconnected.peerId,
          });
        }
      }
    }, this.viewerDisconnectGraceMs);
    timer.unref();
    this.viewerGraceTimers.set(key, timer);
  }

  private stopSharing(roomId: string): void {
    this.clearRoomConnectionIds(roomId);
    if (this.isPeerAssistedRoom(roomId)) {
      this.hybridMediaRouter!.stopRoom(roomId);
    }
    for (const viewer of this.options.roomStore.getConnectedViewers(roomId)) {
      this.sendToSession(viewer.sessionId, { type: "sharing-stopped" });
      this.sendToSession(viewer.sessionId, { type: "host-status", online: false });
    }
  }

  private abandonRoom(roomId: string): void {
    const abandoned = this.options.roomStore.abandonRoom(roomId);
    if (!abandoned) {
      return;
    }
    this.clearRoomGraceTimers(roomId);
    this.clearRoomConnectionIds(roomId);
    if (this.isPeerAssistedRoom(roomId)) {
      this.hybridMediaRouter!.deleteRoom(roomId);
    }
    this.qualitySettingsByRoom.delete(roomId);
    this.shareGenerationsByRoom.delete(roomId);
    for (const sessionId of abandoned.sessionIds) {
      const socket = this.socketsBySessionId.get(sessionId);
      if (!socket) {
        continue;
      }
      this.send(socket, { type: "room-closed", reason: "host-ended" });
      socket.close(1000, "Room abandoned");
    }
  }

  private expireRooms(): void {
    for (const expired of this.options.roomStore.expireRooms(this.now())) {
      this.clearRoomGraceTimers(expired.roomId);
      this.clearRoomConnectionIds(expired.roomId);
      if (this.isPeerAssistedRoom(expired.roomId)) {
        this.hybridMediaRouter!.deleteRoom(expired.roomId);
      }
      this.qualitySettingsByRoom.delete(expired.roomId);
      this.shareGenerationsByRoom.delete(expired.roomId);
      for (const sessionId of expired.sessionIds) {
        const socket = this.socketsBySessionId.get(sessionId);
        if (!socket) {
          continue;
        }
        this.send(socket, { type: "room-closed", reason: "expired" });
        socket.close(1000, "Room expired");
      }
    }
  }

  private heartbeat(): void {
    for (const [socket, state] of this.socketStates) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }

  private isCurrentSession(state: SocketState): boolean {
    const authenticated = state.authenticated;
    if (!authenticated) {
      return false;
    }
    const current =
      authenticated.role === "host"
        ? this.options.roomStore.getConnectedHost(authenticated.roomId)
        : this.options.roomStore.getConnectedViewer(
            authenticated.roomId,
            authenticated.peerId,
          );
    return current?.sessionId === state.sessionId;
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
      return false;
    }
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin && this.options.allowedOrigins.has(origin);
    } catch {
      return false;
    }
  }

  private isPeerAssistedRoom(roomId: string): boolean {
    if (!this.hybridMediaRouter) {
      return false;
    }
    return this.options.peerAssistedRoomIds?.has(roomId) ?? false;
  }

  private hasConnectionCapacity(): boolean {
    return (
      !this.closing &&
      this.socketStates.size < this.maxConnections &&
      this.unauthenticatedConnections < this.maxUnauthenticatedConnections
    );
  }

  private iceConfig() {
    return createIceConfig(this.options.ice);
  }

  private viewerInviteUrl(roomId: string, viewerGrant: string | null): string {
    const inviteUrl = new URL(`/r/${roomId}`, this.options.publicBaseUrl);
    if (viewerGrant) {
      inviteUrl.hash = `v=${viewerGrant}`;
    }
    return inviteUrl.toString();
  }

  private connectedPeer(roomId: string, peerId: string) {
    const host = this.options.roomStore.getConnectedHost(roomId);
    if (host?.peerId === peerId) {
      return host;
    }
    return this.options.roomStore.getConnectedViewer(roomId, peerId);
  }

  private sendViewerPresence(roomId: string): void {
    if (this.deferredViewerPresenceRooms.has(roomId)) {
      return;
    }

    const viewers: ParticipantPresenceEntry[] = [];
    const host = this.options.roomStore.getConnectedHost(roomId);
    const hostSocket = host
      ? this.socketsBySessionId.get(host.sessionId)
      : undefined;
    const hostState = hostSocket
      ? this.socketStates.get(hostSocket)?.authenticated
      : undefined;
    if (
      host &&
      hostSocket &&
      hostState?.role === "host" &&
      hostState.roomId === roomId &&
      hostState.peerId === host.peerId &&
      hostState.displayName !== null
    ) {
      viewers.push({
        role: "host",
        peerId: host.peerId,
        displayName: hostState.displayName,
        mediaTopology: "host",
      });
    }

    for (const viewer of this.options.roomStore.getConnectedViewers(roomId)) {
      const viewerSocket = this.socketsBySessionId.get(viewer.sessionId);
      const viewerState = viewerSocket
        ? this.socketStates.get(viewerSocket)?.authenticated
        : undefined;
      if (
        viewerState?.role !== "viewer" ||
        viewerState.roomId !== roomId ||
        viewerState.peerId !== viewer.peerId ||
        viewerState.displayName === null
      ) {
        continue;
      }
      viewers.push({
        role: "viewer",
        peerId: viewer.peerId,
        displayName: viewerState.displayName,
        mediaTopology: this.isPeerAssistedRoom(roomId)
          ? this.hybridMediaRouter!.getViewerMediaTopology(
              roomId,
              viewer.peerId,
            )
        : "host-direct",
      });
    }

    const message = { type: "viewer-presence" as const, viewers };
    const recipients = new Set<WebSocket>();
    if (hostSocket && hostState?.viewerPresence) {
      recipients.add(hostSocket);
    }
    for (const viewer of this.options.roomStore.getConnectedViewers(roomId)) {
      const viewerSocket = this.socketsBySessionId.get(viewer.sessionId);
      const viewerState = viewerSocket
        ? this.socketStates.get(viewerSocket)?.authenticated
        : undefined;
      if (
        viewerSocket &&
        viewerState?.role === "viewer" &&
        viewerState.roomId === roomId &&
        viewerState.peerId === viewer.peerId &&
        viewerState.viewerPresence
      ) {
        recipients.add(viewerSocket);
      }
    }
    recipients.forEach((socket) => this.send(socket, message));
  }

  private sendToSession(sessionId: string, message: ServerMessage): void {
    const socket = this.socketsBySessionId.get(sessionId);
    if (socket) {
      this.send(socket, message);
    }
  }

  private closeRevokedViewerSession(sessionId: string): void {
    const socket = this.socketsBySessionId.get(sessionId);
    if (!socket) {
      return;
    }
    const state = this.socketStates.get(socket);
    if (state?.sessionId === sessionId) {
      clearTimeout(state.authenticationTimer);
      state.revoked = true;
    }
    if (this.socketsBySessionId.get(sessionId) === socket) {
      this.socketsBySessionId.delete(sessionId);
    }
    // Deauthorize before close so queued callbacks from the old generation
    // cannot route signaling after the persistent authorization commit.
    socket.close(4004, "Viewer access revoked");
  }

  private sendEncodedToSession(sessionId: string, encoded: string): boolean {
    const socket = this.socketsBySessionId.get(sessionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_SIGNAL_BYTES) {
      socket.terminate();
      return false;
    }
    socket.send(encoded);
    return true;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_SIGNAL_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message));
  }

  private sendError(socket: WebSocket, code: ErrorCode, message: string): void {
    this.send(socket, { type: "error", code, message });
  }

  private rejectInvalidMessage(socket: WebSocket): void {
    this.sendError(socket, "INVALID_MESSAGE", "Message is invalid");
    socket.close(1008, "Invalid message");
  }

  private clearViewerGrace(roomId: string, peerId: string): void {
    const key = viewerGraceKey(roomId, peerId);
    const timer = this.viewerGraceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.viewerGraceTimers.delete(key);
    }
  }

  private clearRoomGraceTimers(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const [key, timer] of this.viewerGraceTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.viewerGraceTimers.delete(key);
      }
    }
  }

  private clearRoomConnectionIds(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const key of this.connectionIdsByViewer.keys()) {
      if (key.startsWith(prefix)) {
        this.connectionIdsByViewer.delete(key);
      }
    }
    for (const key of this.viewerQualityEvidenceGates.keys()) {
      if (key.startsWith(prefix)) {
        this.viewerQualityEvidenceGates.delete(key);
      }
    }
  }

  private setViewerConnectionId(
    roomId: string,
    viewerPeerId: string,
    connectionId: string,
  ): void {
    const key = viewerConnectionKey(roomId, viewerPeerId);
    if (this.connectionIdsByViewer.get(key) !== connectionId) {
      this.viewerQualityEvidenceGates.delete(key);
    }
    this.connectionIdsByViewer.set(key, connectionId);
  }

  private deleteViewerConnectionId(
    roomId: string,
    viewerPeerId: string,
  ): void {
    const key = viewerConnectionKey(roomId, viewerPeerId);
    this.connectionIdsByViewer.delete(key);
    this.viewerQualityEvidenceGates.delete(key);
  }
}

function viewerGraceKey(roomId: string, peerId: string): string {
  return `${roomId}:${peerId}`;
}

function viewerConnectionKey(roomId: string, peerId: string): string {
  return `${roomId}:${peerId}`;
}

function authenticationErrorMessage(code: ErrorCode): string {
  switch (code) {
    case "ROOM_EXPIRED":
      return "Room has expired";
    case "ROOM_FULL":
      return "Room is full";
    case "HOST_ALREADY_CONNECTED":
      return "A host is already connected";
    case "INVALID_TOKEN":
      return "Room is invalid or expired";
    default:
      return "Authentication failed";
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
