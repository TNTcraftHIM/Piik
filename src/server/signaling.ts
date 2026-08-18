import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  MAX_SIGNAL_BYTES,
  decodeClientMessage,
  type ClientMessage,
  type Role,
  type ServerMessage,
} from "../shared/protocol.js";
import { RoomStore, RoomStoreError } from "./room-store.js";
import { createIceConfig, type IceConfigOptions } from "./turn.js";

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

const MAX_BUFFERED_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_SIGNAL_CONNECTIONS = 2_048;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS = 256;

interface AuthenticatedSession {
  roomId: string;
  role: Role;
  peerId: string;
  roomExpiresAtMs: number | null;
}

interface SocketState {
  sessionId: string;
  alive: boolean;
  authenticationTimer: NodeJS.Timeout;
  authenticated?: AuthenticatedSession;
}

export interface SignalingOptions {
  server: HttpServer;
  roomStore: RoomStore;
  ice: IceConfigOptions;
  allowedOrigins: ReadonlySet<string>;
  authorizeUpgrade: (request: IncomingMessage) => boolean;
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
      if (!options.authorizeUpgrade(request)) {
        rejectUpgrade(socket, 401, "Unauthorized");
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
    this.webSocketServer.on("connection", (socket) => this.accept(socket));

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
    this.options.server.off("upgrade", this.upgradeHandler);

    for (const socket of this.webSocketServer.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.webSocketServer.close(() => resolve());
    });
  }

  private accept(socket: WebSocket): void {
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
    let message: ClientMessage;
    try {
      message = decodeClientMessage(encoded);
    } catch {
      this.rejectInvalidMessage(socket);
      return;
    }

    const state = this.socketStates.get(socket);
    if (!state) {
      return;
    }
    if (!state.authenticated) {
      if (message.type !== "authenticate") {
        this.sendError(socket, "AUTH_REQUIRED", "Authenticate before sending messages");
        socket.close(4001, "Authentication required");
        return;
      }
      this.authenticate(socket, state, message);
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

  private authenticate(
    socket: WebSocket,
    state: SocketState,
    message: Extract<ClientMessage, { type: "authenticate" }>,
  ): void {
    let participant;
    try {
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
              clientId: message.clientId,
              sessionId: state.sessionId,
            },
      );
    } catch (error) {
      if (!(error instanceof RoomStoreError)) {
        console.error("Signaling authentication failed unexpectedly", error);
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
    state.authenticated = {
      roomId: participant.roomId,
      role: participant.role,
      peerId: participant.peerId,
      roomExpiresAtMs:
        participant.expiresAt === null
          ? null
          : Date.parse(participant.expiresAt),
    };
    this.clearViewerGrace(participant.roomId, participant.peerId);
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

    this.send(socket, {
      type: "authenticated",
      role: participant.role,
      peerId: participant.peerId,
      roomExpiresAt: participant.expiresAt,
      maxViewers: this.options.roomStore.maxViewersPerRoom,
      hostOnline: participant.hostOnline,
      connectionId,
      viewerPeerIds: [...participant.viewerPeerIds],
      iceConfig: this.iceConfig(
        participant.roomId,
        participant.peerId,
        participant.expiresAt === null
          ? null
          : Date.parse(participant.expiresAt),
      ),
    });

    if (participant.replacedSessionId) {
      const replaced = this.socketsBySessionId.get(participant.replacedSessionId);
      if (replaced && replaced !== socket) {
        replaced.close(4001, "Session replaced");
      }
    }

    if (participant.role === "host") {
      for (const viewer of connectedViewers) {
        this.sendToSession(viewer.sessionId, { type: "host-status", online: true });
        this.send(socket, { type: "peer-joined", peerId: viewer.peerId });
      }
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
        this.routeToHost(socket, authenticated, {
          type: "restart-request",
          fromPeerId: authenticated.peerId,
          connectionId: message.connectionId,
          rebuild: message.rebuild,
        });
        return;
      case "refresh-ice":
        this.send(socket, {
          type: "ice-config",
          iceConfig: this.iceConfig(
            authenticated.roomId,
            authenticated.peerId,
            authenticated.roomExpiresAtMs,
          ),
        });
        return;
      case "stop-sharing":
      case "close-room":
        if (authenticated.role !== "host") {
          this.sendError(socket, "FORBIDDEN", "Only the host may stop sharing");
          return;
        }
        const state = this.socketStates.get(socket);
        if (state?.authenticated === authenticated) {
          this.options.roomStore.disconnectParticipant(
            authenticated.roomId,
            authenticated.peerId,
            state.sessionId,
          );
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

  private routeSignal(
    sourceSocket: WebSocket,
    source: AuthenticatedSession,
    message: Extract<ClientMessage, { type: "signal" }>,
  ): void {
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
        this.connectionIdsByViewer.set(
          viewerConnectionKey(source.roomId, viewer.peerId),
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
    if (disconnected.role === "host") {
      for (const viewer of this.options.roomStore.getConnectedViewers(
        disconnected.roomId,
      )) {
        this.sendToSession(viewer.sessionId, { type: "host-status", online: false });
      }
      return;
    }

    const key = viewerGraceKey(disconnected.roomId, disconnected.peerId);
    const timer = setTimeout(() => {
      this.viewerGraceTimers.delete(key);
      if (
        this.options.roomStore.removeDisconnectedViewer(
          disconnected.roomId,
          disconnected.peerId,
        )
      ) {
        this.connectionIdsByViewer.delete(
          viewerConnectionKey(disconnected.roomId, disconnected.peerId),
        );
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

  private hasConnectionCapacity(): boolean {
    return (
      !this.closing &&
      this.socketStates.size < this.maxConnections &&
      this.unauthenticatedConnections < this.maxUnauthenticatedConnections
    );
  }

  private iceConfig(
    roomId: string,
    peerId: string,
    roomExpiresAtMs: number | null,
  ) {
    return createIceConfig(
      this.options.ice,
      `${roomId}:${peerId}`,
      this.now(),
      roomExpiresAtMs ?? undefined,
    );
  }

  private sendToSession(sessionId: string, message: ServerMessage): void {
    const socket = this.socketsBySessionId.get(sessionId);
    if (socket) {
      this.send(socket, message);
    }
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
