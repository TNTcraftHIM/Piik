import {
  decodeServerMessage,
  SIGNALING_PROTOCOL,
  type ClientMessage,
  type DisplayName,
  type ServerMessage,
} from "../../shared/protocol";
import type { SignalConnectionState } from "../types";

type WithoutProtocolEnvelope<T> = T extends {
  type: string;
  protocol: string;
}
  ? Omit<T, "type" | "protocol">
  : never;
type SignalingIdentity = WithoutProtocolEnvelope<
  Extract<ClientMessage, { type: "authenticate" }>
>;

interface SignalingEvents {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: SignalConnectionState) => void;
  onTerminated: (message: string) => void;
  onAccessRequired: () => void;
}

const FATAL_SIGNAL_ERRORS = new Set([
  "AUTH_REQUIRED",
  "INVALID_TOKEN",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "HOST_ALREADY_CONNECTED",
]);
const SESSION_REPLACED_CLOSE_CODE = 4001;
const CLIENT_RECONNECT_CLOSE_CODE = 4002;
const INVALID_MESSAGE_CLOSE_CODE = 1008;
const VIEWER_ACCESS_REVOKED_CLOSE_CODE = 4004;
const PROTOCOL_REFRESH_MESSAGE = "页面版本已更新，请刷新后重试";
const TERMINAL_SEND_TIMEOUT_MS = 15_000;
const SIGNALING_CHALLENGE_INTERVAL_MS = 5_000;
const SIGNALING_CHALLENGE_TIMEOUT_MS = 2_000;
const SIGNALING_TIMER_LAG_TOLERANCE_MS = 1_000;

interface PendingSignalingChallenge {
  generation: number;
  sequence: number;
  confirm: boolean;
}

export function shouldReconnectSignaling(code: number): boolean {
  return (
    code !== SESSION_REPLACED_CLOSE_CODE &&
    code !== INVALID_MESSAGE_CLOSE_CODE &&
    code !== VIEWER_ACCESS_REVOKED_CLOSE_CODE
  );
}

function signalUrl(): string {
  const url = new URL("/signal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class SignalingClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private authenticationTimer: number | null = null;
  private terminalTimer: number | null = null;
  private terminalMessage: ClientMessage | null = null;
  private socketGeneration = 0;
  private hostOnline = false;
  private authoritativeRoute = false;
  private challengeSequence = 0;
  private watchdogTimer: number | null = null;
  private watchdogDeadlineMs = 0;
  private pendingChallenge: PendingSignalingChallenge | null = null;
  private visibilityListenerAttached = false;

  constructor(
    private readonly identity: SignalingIdentity,
    private readonly events: SignalingEvents,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.socket || this.stopped) {
      return;
    }
    this.attachVisibilityListener();
    this.events.onStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    this.clearTimers();
    this.detachVisibilityListener();
    this.terminalMessage = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client closed");
    }
    this.events.onStatus("offline");
  }

  reconnect(): boolean {
    const socket = this.socket;
    if (
      this.stopped ||
      !this.authenticated ||
      !socket ||
      socket.readyState >= WebSocket.CLOSING
    ) {
      return false;
    }
    this.clearSignalingWatchdog();
    socket.close(CLIENT_RECONNECT_CLOSE_CODE, "client reconnect");
    return true;
  }

  send(message: ClientMessage): boolean {
    if (
      !this.authenticated ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  setDisplayName(displayName: DisplayName): boolean {
    if (
      this.identity.role === "host" &&
      this.identity.viewerPresence !== true
    ) {
      return false;
    }
    this.identity.displayName = displayName;
    return this.send({ type: "set-display-name", displayName });
  }

  setViewerDisplayName(displayName: DisplayName): boolean {
    return this.setDisplayName(displayName);
  }

  setSharingPaused(paused: boolean): boolean {
    if (this.identity.role !== "host") {
      return false;
    }
    this.identity.sharingPaused = paused;
    if (!this.identity.shareGeneration) {
      return false;
    }
    return this.send({
      type: "set-sharing-paused",
      shareGeneration: this.identity.shareGeneration,
      paused,
    });
  }

  sendThenStop(message: ClientMessage): void {
    if (this.stopped) {
      return;
    }
    if (this.send(message)) {
      this.stop();
      return;
    }

    this.terminalMessage = message;
    if (this.terminalTimer === null) {
      this.terminalTimer = window.setTimeout(() => {
        this.terminalTimer = null;
        this.stop();
      }, TERMINAL_SEND_TIMEOUT_MS);
    }
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    const generation = ++this.socketGeneration;
    const socket = new WebSocket(signalUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (
        this.socket !== socket ||
        generation !== this.socketGeneration ||
        this.stopped
      ) {
        return;
      }
      const authenticate: ClientMessage = {
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        ...this.identity,
      };
      socket.send(JSON.stringify(authenticate));
      this.authenticationTimer = window.setTimeout(() => {
        if (!this.authenticated && this.socket === socket) {
          socket.close(4000, "authentication timeout");
        }
      }, 8_000);
    });

    socket.addEventListener("message", (event) => {
      if (
        this.socket !== socket ||
        generation !== this.socketGeneration ||
        typeof event.data !== "string"
      ) {
        return;
      }
      let message: ServerMessage;
      try {
        message = decodeServerMessage(event.data);
      } catch {
        this.terminateForProtocolMismatch();
        return;
      }

      if (message.type === "signaling-challenge-response") {
        this.acceptSignalingChallengeResponse(message.sequence, generation);
        return;
      }

      if (
        message.type === "error" &&
        message.code === "INVALID_MESSAGE" &&
        !this.authenticated
      ) {
        this.terminateForProtocolMismatch();
        return;
      }

      if (message.type === "error" && FATAL_SIGNAL_ERRORS.has(message.code)) {
        this.stop();
        this.events.onMessage(message);
        if (message.code === "AUTH_REQUIRED" && this.identity.role === "host") {
          this.events.onAccessRequired();
        }
        return;
      }

      if (message.type === "authenticated") {
        this.authenticated = true;
        this.reconnectAttempt = 0;
        this.clearAuthenticationTimer();
        if (this.terminalMessage) {
          const terminalMessage = this.terminalMessage;
          this.terminalMessage = null;
          if (this.send(terminalMessage)) {
            this.stop();
            return;
          }
        }
        this.events.onStatus("connected");
      }
      this.updateAuthoritativeActivity(message);
      this.events.onMessage(message);
    });

    socket.addEventListener("close", (event) => {
      if (
        this.socket !== socket ||
        generation !== this.socketGeneration
      ) {
        return;
      }
      this.socket = null;
      this.authenticated = false;
      this.hostOnline = false;
      this.authoritativeRoute = false;
      this.clearSignalingWatchdog();
      this.clearAuthenticationTimer();
      if (!this.stopped && shouldReconnectSignaling(event.code)) {
        this.scheduleReconnect();
      } else if (!this.stopped) {
        this.stopped = true;
        this.clearTimers();
        this.events.onStatus("offline");
        this.events.onTerminated(
          event.reason === "Session replaced"
            ? "此页面的会话已被另一个标签页接管"
            : event.code === INVALID_MESSAGE_CLOSE_CODE
              ? PROTOCOL_REFRESH_MESSAGE
              : "信令会话已终止，请刷新后重试",
        );
      }
    });

    socket.addEventListener("error", () => {
      // The close event owns reconnect scheduling and user-visible state.
    });
  }

  private scheduleReconnect(): void {
    this.events.onStatus("reconnecting");
    const exponent = Math.min(this.reconnectAttempt, 4);
    const delay = Math.min(8_000, 500 * 2 ** exponent) + Math.random() * 250;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private terminateForProtocolMismatch(): void {
    this.stop();
    this.events.onTerminated(PROTOCOL_REFRESH_MESSAGE);
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer !== null) {
      window.clearTimeout(this.authenticationTimer);
      this.authenticationTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearAuthenticationTimer();
    this.clearSignalingWatchdog();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.terminalTimer !== null) {
      window.clearTimeout(this.terminalTimer);
      this.terminalTimer = null;
    }
  }

  private updateAuthoritativeActivity(message: ServerMessage): void {
    if (message.type === "authenticated") {
      this.hostOnline = message.hostOnline;
      this.authoritativeRoute =
        this.identity.role === "host" ||
        !("mediaMode" in message) ||
        message.routeAssignment.upstream.kind !== "none";
    } else if (message.type === "host-status") {
      this.hostOnline = message.online;
    } else if (
      message.type === "route-update" &&
      message.phase === "active" &&
      this.identity.role === "viewer"
    ) {
      this.authoritativeRoute = message.assignment.upstream.kind !== "none";
    } else if (
      message.type === "sharing-stopped" ||
      message.type === "room-closed"
    ) {
      this.hostOnline = false;
      this.authoritativeRoute = false;
    } else {
      return;
    }
    this.refreshSignalingWatchdog();
  }

  private refreshSignalingWatchdog(): void {
    if (!this.isWatchdogEligible()) {
      this.clearSignalingWatchdog();
      return;
    }
    if (this.watchdogTimer === null && this.pendingChallenge === null) {
      this.armSignalingWatchdog(SIGNALING_CHALLENGE_INTERVAL_MS);
    }
  }

  private armSignalingWatchdog(delayMs: number): void {
    const generation = this.socketGeneration;
    this.watchdogDeadlineMs = this.now() + delayMs;
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      this.handleSignalingWatchdogTick(generation);
    }, delayMs);
  }

  private handleSignalingWatchdogTick(generation: number): void {
    if (generation !== this.socketGeneration) {
      return;
    }
    if (
      !this.isWatchdogEligible() ||
      Math.abs(this.now() - this.watchdogDeadlineMs) >
        SIGNALING_TIMER_LAG_TOLERANCE_MS
    ) {
      this.rebaselineSignalingWatchdog();
      return;
    }
    const pending = this.pendingChallenge;
    if (!pending) {
      this.sendSignalingChallenge(false, generation);
    } else if (pending.confirm) {
      this.replaceUnresponsiveSocket(generation);
    } else {
      this.sendSignalingChallenge(true, generation);
    }
  }

  private sendSignalingChallenge(confirm: boolean, generation: number): void {
    const socket = this.socket;
    if (!socket || generation !== this.socketGeneration) {
      return;
    }
    this.challengeSequence =
      this.challengeSequence === Number.MAX_SAFE_INTEGER
        ? 0
        : this.challengeSequence + 1;
    const sequence = this.challengeSequence;
    socket.send(JSON.stringify({ type: "signaling-challenge", sequence }));
    this.pendingChallenge = { generation, sequence, confirm };
    this.armSignalingWatchdog(SIGNALING_CHALLENGE_TIMEOUT_MS);
  }

  private acceptSignalingChallengeResponse(
    sequence: number,
    generation: number,
  ): void {
    const pending = this.pendingChallenge;
    if (
      !pending ||
      pending.generation !== generation ||
      pending.sequence !== sequence ||
      generation !== this.socketGeneration
    ) {
      return;
    }
    this.clearSignalingWatchdog();
    this.refreshSignalingWatchdog();
  }

  private replaceUnresponsiveSocket(generation: number): void {
    const socket = this.socket;
    if (!socket || generation !== this.socketGeneration || this.stopped) {
      return;
    }
    this.socket = null;
    this.authenticated = false;
    this.hostOnline = false;
    this.authoritativeRoute = false;
    this.clearAuthenticationTimer();
    this.clearSignalingWatchdog();
    this.events.onStatus("reconnecting");
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close(CLIENT_RECONNECT_CLOSE_CODE, "signaling timeout");
    }
    this.connect();
  }

  private rebaselineSignalingWatchdog(): void {
    this.clearSignalingWatchdog();
    this.refreshSignalingWatchdog();
  }

  private clearSignalingWatchdog(): void {
    this.pendingChallenge = null;
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private readonly onVisibilityChange = (): void => {
    this.rebaselineSignalingWatchdog();
  };

  private attachVisibilityListener(): void {
    if (typeof document === "undefined" || this.visibilityListenerAttached) {
      return;
    }
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityListenerAttached = true;
  }

  private detachVisibilityListener(): void {
    if (typeof document === "undefined" || !this.visibilityListenerAttached) {
      return;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityListenerAttached = false;
  }

  private isDocumentVisible(): boolean {
    return (
      typeof document === "undefined" || document.visibilityState === "visible"
    );
  }

  private isWatchdogEligible(): boolean {
    return (
      this.authenticated &&
      this.hostOnline &&
      this.authoritativeRoute &&
      this.isDocumentVisible() &&
      this.socket?.readyState === WebSocket.OPEN
    );
  }
}
