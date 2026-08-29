import {
  decodeServerMessage,
  SIGNAL_CLOSE_CODES,
  SIGNALING_PROTOCOL,
  type ClientMessage,
  type DisplayName,
  type QualitySettings,
  type ServerMessage,
} from "../../shared/protocol";
import type { SignalConnectionState } from "../types";
import { qualitySettingsEqual } from "../media/quality";

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
  onTerminated: (reason: SignalingTerminationReason) => void;
  onAccessRequired: () => void;
}

export type SignalingTerminationReason =
  | "STALE_CLIENT"
  | "SESSION_REPLACED"
  | "SIGNAL_TERMINATED";

const FATAL_SIGNAL_ERRORS = new Set([
  "AUTH_REQUIRED",
  "INVALID_TOKEN",
  "ROOM_NOT_FOUND",
  "ROOM_ACCESS_DENIED",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "HOST_ALREADY_CONNECTED",
]);
const INVALID_MESSAGE_CLOSE_CODE = 1008;
const TERMINAL_SEND_TIMEOUT_MS = 15_000;
const SIGNALING_CHALLENGE_INTERVAL_MS = 5_000;
const SIGNALING_CHALLENGE_TIMEOUT_MS = 2_000;
const SIGNALING_TIMER_LAG_TOLERANCE_MS = 1_000;

interface PendingSignalingChallenge {
  generation: number;
  sequence: number;
  confirm: boolean;
}

interface HostQualityIntent {
  shareGeneration: string;
  qualitySettings: QualitySettings;
}

export function shouldReconnectSignaling(code: number): boolean {
  return (
    code !== SIGNAL_CLOSE_CODES.sessionReplaced &&
    code !== SIGNAL_CLOSE_CODES.authenticationFailed &&
    code !== INVALID_MESSAGE_CLOSE_CODE &&
    code !== SIGNAL_CLOSE_CODES.viewerAccessRevoked
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
  private previousChallenge: PendingSignalingChallenge | null = null;
  private visibilityListenerAttached = false;
  private hostQualityIntent: HostQualityIntent | null = null;

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
    this.hostQualityIntent = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client closed");
    }
    this.events.onStatus("offline");
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
    try {
      return this.send({
        type: "set-sharing-paused",
        shareGeneration: this.identity.shareGeneration,
        paused,
      });
    } catch {
      return false;
    }
  }

  confirmSharingPaused(): void {
    if (this.identity.role === "host") {
      this.identity.sharingPaused = true;
    }
  }

  setHostQualitySettings(qualitySettings: QualitySettings): boolean {
    if (this.identity.role !== "host" || !this.identity.shareGeneration) {
      return false;
    }
    const intent: HostQualityIntent = {
      shareGeneration: this.identity.shareGeneration,
      qualitySettings: { ...qualitySettings },
    };
    this.identity.qualitySettings = { ...qualitySettings };
    this.hostQualityIntent = intent;
    return this.flushHostQualityIntent();
  }

  pendingHostQualitySettings(
    shareGeneration: string,
  ): QualitySettings | null {
    const intent = this.hostQualityIntent;
    return intent?.shareGeneration === shareGeneration
      ? { ...intent.qualitySettings }
      : null;
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
      if (message.type === "authenticated") {
        this.reconcileHostQualityIntent(message);
      }
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
          event.code === SIGNAL_CLOSE_CODES.sessionReplaced
            ? "SESSION_REPLACED"
            : event.code === INVALID_MESSAGE_CLOSE_CODE
              ? "STALE_CLIENT"
              : "SIGNAL_TERMINATED",
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
    this.events.onTerminated("STALE_CLIENT");
  }

  private flushHostQualityIntent(): boolean {
    const intent = this.hostQualityIntent;
    if (
      !intent ||
      this.identity.role !== "host" ||
      this.identity.shareGeneration !== intent.shareGeneration
    ) {
      return false;
    }
    try {
      if (
        !this.send({
          type: "set-quality-settings",
          qualitySettings: intent.qualitySettings,
        })
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private reconcileHostQualityIntent(
    message: Extract<ServerMessage, { type: "authenticated" }>,
  ): void {
    const intent = this.hostQualityIntent;
    if (
      !intent ||
      this.identity.role !== "host" ||
      this.identity.shareGeneration !== intent.shareGeneration
    ) {
      return;
    }
    if (
      "qualitySettings" in message &&
      qualitySettingsEqual(message.qualitySettings, intent.qualitySettings)
    ) {
      if (this.hostQualityIntent === intent) {
        this.hostQualityIntent = null;
      }
      return;
    }
    this.flushHostQualityIntent();
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
      if (
        this.identity.role === "host" &&
        message.online &&
        !message.paused
      ) {
        this.identity.sharingPaused = false;
      }
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
    this.previousChallenge = this.pendingChallenge?.generation === generation
      ? this.pendingChallenge
      : null;
    this.pendingChallenge = { generation, sequence, confirm };
    this.armSignalingWatchdog(SIGNALING_CHALLENGE_TIMEOUT_MS);
  }

  private acceptSignalingChallengeResponse(
    sequence: number,
    generation: number,
  ): void {
    const pending = this.pendingChallenge;
    const previous = this.previousChallenge;
    if (
      ![pending, previous].some(
        (challenge) =>
          challenge !== null &&
          challenge.generation === generation &&
          challenge.sequence === sequence,
      ) ||
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
      socket.close(SIGNAL_CLOSE_CODES.clientReconnect, "signaling timeout");
    }
    this.connect();
  }

  private rebaselineSignalingWatchdog(): void {
    this.clearSignalingWatchdog();
    this.refreshSignalingWatchdog();
  }

  private clearSignalingWatchdog(): void {
    this.pendingChallenge = null;
    this.previousChallenge = null;
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
