import {
  decodeServerMessage,
  type ClientMessage,
  type Role,
  type ServerMessage,
} from "../../shared/protocol";
import type { SignalConnectionState } from "../types";

interface SignalingIdentity {
  roomId: string;
  role: Role;
  token: string;
  clientId: string;
}

interface SignalingEvents {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: SignalConnectionState) => void;
  onProtocolError: (message: string) => void;
  onTerminated: (message: string) => void;
}

const FATAL_SIGNAL_ERRORS = new Set([
  "AUTH_REQUIRED",
  "INVALID_TOKEN",
  "ROOM_CLOSED",
  "ROOM_EXPIRED",
  "ROOM_FULL",
  "HOST_ALREADY_CONNECTED",
]);
const SESSION_REPLACED_CLOSE_CODE = 4001;
const TERMINAL_SEND_TIMEOUT_MS = 15_000;

export function shouldReconnectSignaling(code: number): boolean {
  return code !== SESSION_REPLACED_CLOSE_CODE;
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
  private iceRefreshTimer: number | null = null;
  private terminalTimer: number | null = null;
  private terminalMessage: ClientMessage | null = null;

  constructor(
    private readonly identity: SignalingIdentity,
    private readonly events: SignalingEvents,
  ) {}

  start(): void {
    if (this.socket || this.stopped) {
      return;
    }
    this.events.onStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    this.clearTimers();
    this.terminalMessage = null;
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

    const socket = new WebSocket(signalUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      const authenticate: ClientMessage = {
        type: "authenticate",
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
      if (this.socket !== socket || typeof event.data !== "string") {
        return;
      }
      let message: ServerMessage;
      try {
        message = decodeServerMessage(event.data);
      } catch {
        this.events.onProtocolError("信令服务返回了无法识别的消息");
        return;
      }

      if (message.type === "error" && FATAL_SIGNAL_ERRORS.has(message.code)) {
        this.stop();
        this.events.onMessage(message);
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
        this.scheduleIceRefresh(message.iceConfig.expiresAt);
        this.events.onStatus("connected");
      } else if (message.type === "ice-config") {
        this.scheduleIceRefresh(message.iceConfig.expiresAt);
      }
      this.events.onMessage(message);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.authenticated = false;
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

  private scheduleIceRefresh(expiresAt: string | null): void {
    if (this.iceRefreshTimer !== null) {
      window.clearTimeout(this.iceRefreshTimer);
      this.iceRefreshTimer = null;
    }
    if (!expiresAt) {
      return;
    }

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const delay = Math.max(5_000, expiresAtMs - Date.now() - 60_000);
    this.iceRefreshTimer = window.setTimeout(() => {
      this.iceRefreshTimer = null;
      this.send({ type: "refresh-ice" });
    }, delay);
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer !== null) {
      window.clearTimeout(this.authenticationTimer);
      this.authenticationTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearAuthenticationTimer();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.iceRefreshTimer !== null) {
      window.clearTimeout(this.iceRefreshTimer);
      this.iceRefreshTimer = null;
    }
    if (this.terminalTimer !== null) {
      window.clearTimeout(this.terminalTimer);
      this.terminalTimer = null;
    }
  }
}
