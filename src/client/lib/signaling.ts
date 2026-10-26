import {
  decodeServerMessage,
  SIGNAL_CLOSE_CODES,
  SIGNALING_PROTOCOL,
  type ClientMessage,
  type DisplayName,
  type QualitySettings,
  type RoutePolicy,
  type ViewerRoutePreference,
  type ServerMessage,
  type IceConfig,
  type CoPlayGrant,
} from "../../shared/protocol";
import type { SignalConnectionState } from "../types";
import { qualitySettingsEqual } from "../media/quality";
import { debugEvent } from "./debug";
import { RoomInteractionSession } from "./room-interactions";
import { RoomVoiceSession } from "../room-voice/session";
import { RoomControlSession, readMemberCredential, saveMemberCredential } from "./room-control";
import { handOffRoom, disposePreparedPresentation, type PreparedPresentation } from "./room-handoff";
import { createOpaqueId } from "./opaque-id";
import { DEFAULT_ROUTE_POLICY } from "../../shared/protocol";
import { getSiteAccess } from "./api";

type WithoutProtocolEnvelope<T> = T extends {
  type: string;
  protocol: string;
}
  ? Omit<T, "type" | "protocol">
  : never;
type AdmissionIdentity = WithoutProtocolEnvelope<
  Extract<ClientMessage, { type: "authenticate" }>
>;

type SignalingIdentity = Exclude<AdmissionIdentity, { role: "host" }> | (Omit<Extract<AdmissionIdentity, { role: "host" }>, "token"> & { token: string | null });

export interface SignalingEvents {
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
  "INVALID_TOKEN",
  "ROOM_NOT_FOUND",
  "ROOM_ACCESS_DENIED",
  "ROOM_FULL",
  "HOST_ALREADY_CONNECTED",
]);
const INVALID_MESSAGE_CLOSE_CODE = 1008;
const TERMINAL_SEND_TIMEOUT_MS = 15_000;
const SIGNALING_CHALLENGE_INTERVAL_MS = 5_000;
const SIGNALING_CHALLENGE_TIMEOUT_MS = 2_000;
const SIGNALING_TIMER_LAG_TOLERANCE_MS = 1_000;
const AUTHENTICATION_TIMEOUT_MS = 8_000;

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
  runtimeCapabilities: import("../../shared/protocol").RuntimeCapabilities | null = null;
  roomControl: RoomControlSession | null = null;
  private memberToken: string | null = null;
  private recoveryOwnerToken: string | null = null;
  private recoveringOwner = false;
  private baselineIdentity: SignalingIdentity;
  private handoffPending = false;
  private unclaimedPresentation: PreparedPresentation | null = null;
  private mediaMessages: ServerMessage[] = [];
  private preparedPresentation: { value: PreparedPresentation; requestId: string; timer: number } | null = null;
  get roomId() { return this.identity.roomId; }
  get clientId() { return this.identity.clientId; }
  get displayName() { return this.identity.displayName; }
  get mediaRole() { return this.identity.role; }
  get ownerToken() { return this.roomControl ? this.roomControl.ownerToken : (this.identity.role === "host" ? this.identity.token : this.recoveryOwnerToken); }
  get switchingMedia() { return this.handoffPending; }
  attach(events: SignalingEvents): SignalingClient { this.events = events; return this; }
  releaseMedia(): void { if (!this.handoffPending) this.stop(); }
  enableRoomControl(): RoomControlSession | null {
    if (this.stopped) return null;
    if (!this.roomControl) {
      this.roomControl = new RoomControlSession(this.roomId, message => this.send(message), this.ownerToken);
      if (this.authenticatedPeerId) this.roomControl.authenticated(this.authenticatedPeerId);
    }
    return this.roomControl;
  }
  claimPresentation(prepared: PreparedPresentation, qualitySettings: QualitySettings, routePolicy: RoutePolicy): boolean {
    if (this.preparedPresentation || !this.roomControl?.getSnapshot().connected) return false;
    const requestId = createOpaqueId(), shareGeneration = createOpaqueId();
    this.preparedPresentation = { value: prepared, requestId, timer: window.setTimeout(() => { this.retirePreparedPresentation(); this.roomControl?.reportChanged(); }, 15_000) };
    if (!this.send({ type: "claim-presentation", requestId, shareGeneration, previousGeneration: this.roomControl.getSnapshot().state?.shareGeneration ?? null, qualitySettings, routePolicy })) { this.retirePreparedPresentation(); return false; }
    return true;
  }
  private retirePreparedPresentation() {
    const prepared = this.preparedPresentation;
    this.preparedPresentation = null;
    if (!prepared) return;
    window.clearTimeout(prepared.timer);
    disposePreparedPresentation(prepared.value);
  }
  private changeMediaRole(state: Extract<ServerMessage, { type: "authenticated" }>) {
    const prepared = this.preparedPresentation;
    if (prepared) window.clearTimeout(prepared.timer);
    this.preparedPresentation = null;
    if (state.role === "host" && state.shareGeneration && !prepared) {
      this.send({ type: "stop-sharing", shareGeneration: state.shareGeneration });
      state = { ...state, shareGeneration: null, routeAssignment: { upstream: { kind: "none" }, childPeerIds: [], sfuPublicationGeneration: null } };
    }
    const previous = this.identity;
    const common = { roomId: previous.roomId, clientId: previous.clientId, displayName: previous.displayName, viewerPresence: true as const };
    this.identity = state.role === "host" ? { ...common, role: "host", token: this.ownerToken, roomSession: true, roomOnly: state.shareGeneration === null ? true : undefined,
      shareGeneration: state.shareGeneration ?? undefined, sharingPaused: false, qualitySettings: state.qualitySettings, routePolicy: state.routePolicy }
      : { ...common, role: "viewer" };
    this.hostQualityIntent = null;
    this.pendingShareGeneration = null;
    this.relayVolunteerIntent = null;
    this.handoffPending = true;
    this.unclaimedPresentation = prepared?.value ?? null;
    this.mediaMessages = [state];
    handOffRoom(this, state, prepared?.value ?? null);
  }
  private remoteInputEnabled = false;
  private audioPresenceEnabled = false;
  private hostAudioAvailable: boolean | null = null;
  private coPlayPresenceEnabled = false;
  private coPlayGrants: CoPlayGrant[] = [];
  interactions: RoomInteractionSession | null = null;
  roomVoice: RoomVoiceSession | null = null;
  private voiceIceConfig: IceConfig = { iceServers: [] };
  private socket: WebSocket | null = null;
  private stopped = false;
  private authenticatedPeerId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private authenticationTimer: number | null = null;
  private accessCheck: AbortController | null = null;
  private terminalTimer: number | null = null;
  private terminalMessage: ClientMessage | null = null;
  private socketGeneration = 0;
  private challengeSequence = 0;
  private watchdogTimer: number | null = null;
  private watchdogDeadlineMs = 0;
  private pendingChallenge: PendingSignalingChallenge | null = null;
  private previousChallenge: PendingSignalingChallenge | null = null;
  private visibilityListenerAttached = false;
  private hostQualityIntent: HostQualityIntent | null = null;
  private pendingShareGeneration: string | null = null;
  private relayVolunteerIntent: { enabled: boolean; capacity: number } | null = null;

  constructor(
    private identity: SignalingIdentity,
    private events: SignalingEvents,
    private readonly now: () => number = Date.now,
    capabilities: { roomInteractions?: boolean; roomReactionIds?: readonly string[] } = {},
  ) {
    this.baselineIdentity = { ...identity };
    const saved = readMemberCredential(identity.roomId);
    if (saved) { this.memberToken = saved.token; this.recoveryOwnerToken = saved.ownerToken ?? null; this.identity.clientId = saved.clientId; }
    if (capabilities.roomInteractions) this.enableRoomInteractions(capabilities.roomReactionIds);
  }

  // Capability discovery may finish after media authentication. Enabling room
  // data must not replace the signaling connection or its healthy media.
  enableRoomInteractions(reactionIds?: readonly string[]): RoomInteractionSession | null {
    if (this.stopped) return null;
    if (!this.interactions) {
      this.interactions = new RoomInteractionSession(message => this.send(message), this.now, reactionIds);
      if (this.authenticatedPeerId) this.interactions.authenticated(this.authenticatedPeerId);
    } else {
      this.interactions.setSupportedReactions(reactionIds);
    }
    return this.interactions;
  }

  enableRemoteInput(): void {
    if (this.stopped || this.identity.role !== "host") return;
    this.remoteInputEnabled = true;
    if (this.authenticatedPeerId) this.send({ type: "subscribe-remote-input" });
  }

  enableCoPlayPresence(): void {
    if (this.stopped || this.coPlayPresenceEnabled) return;
    this.coPlayPresenceEnabled = true;
    this.flushCoPlayPresence();
  }

  setCoPlayGrants(grants: CoPlayGrant[]): void {
    if (this.identity.role !== "host") return;
    this.coPlayGrants = grants;
    this.flushCoPlayPresence();
  }

  private flushCoPlayPresence(): void {
    if (!this.coPlayPresenceEnabled || !this.authenticatedPeerId) return;
    if (this.identity.role === "viewer") this.send({ type: "subscribe-co-play-presence" });
    else if (this.identity.shareGeneration && this.pendingShareGeneration === null) {
      this.send({ type: "set-co-play-presence", shareGeneration: this.identity.shareGeneration, grants: this.coPlayGrants });
    }
  }

  enableRoomVoice({ listeningPresence = false, bitrate = false }: { listeningPresence?: boolean; bitrate?: boolean } = {}): RoomVoiceSession | null {
    if (this.stopped) return null;
    if (!this.roomVoice) {
      this.roomVoice = new RoomVoiceSession(message => this.send(message), this.voiceIceConfig, listeningPresence, bitrate);
      if (this.authenticatedPeerId) {
        this.roomVoice.authenticated(this.authenticatedPeerId, this.identity.role);
        this.roomVoice.subscribeRoom();
      }
    }
    return this.roomVoice;
  }

  enableAudioPresence(): void {
    if (this.stopped) return;
    this.audioPresenceEnabled = true;
    this.flushAudioPresence();
  }

  setAudioAvailable(available: boolean): void {
    if (this.identity.role !== "host") return;
    this.hostAudioAvailable = available;
    this.flushAudioPresence();
  }

  private flushAudioPresence(): void {
    if (!this.audioPresenceEnabled || !this.authenticatedPeerId) return;
    if (this.identity.role === "viewer") this.send({ type: "subscribe-audio-presence" });
    else if (this.identity.shareGeneration && this.pendingShareGeneration === null && this.hostAudioAvailable !== null) {
      this.send({ type: "set-audio-presence", shareGeneration: this.identity.shareGeneration, available: this.hostAudioAvailable });
    }
  }

  enableViewerRouteSelection(preference: ViewerRoutePreference = "auto"): void {
    if (this.stopped || this.identity.role !== "viewer") return;
    this.identity.routePreference ??= preference;
    if (this.authenticatedPeerId) this.setViewerRoutePreference(this.identity.routePreference);
  }

  setViewerRoutePreference(preference: ViewerRoutePreference): boolean {
    if (this.identity.role !== "viewer" || this.identity.routePreference === undefined ||
      !this.send({ type: "set-viewer-route-preference", preference })) return false;
    // Replies describe applied policy; reconnect retains the personal request,
    // including when its acknowledgement is lost or an older reply arrives late.
    this.identity.routePreference = preference;
    return true;
  }

  get relayVolunteerRequest(): Readonly<{ enabled: boolean; capacity: number }> | null {
    return this.relayVolunteerIntent;
  }

  setRelayVolunteer(enabled: boolean, capacity: number): boolean {
    if (this.stopped || this.identity.role !== "viewer") return false;
    this.relayVolunteerIntent = { enabled, capacity };
    return this.authenticatedPeerId === null || this.flushRelayVolunteerIntent();
  }

  private flushRelayVolunteerIntent(): boolean {
    return this.relayVolunteerIntent !== null && this.send({ type: "set-relay-volunteer", ...this.relayVolunteerIntent });
  }

  start(): void {
    if (this.handoffPending) {
      this.handoffPending = false;
      this.unclaimedPresentation = null;
      this.events.onStatus(this.authenticatedPeerId ? "connected" : "reconnecting");
      const queued = this.mediaMessages; this.mediaMessages = [];
      queued.forEach(message => this.events.onMessage(message));
      this.flushAudioPresence(); this.flushCoPlayPresence();
      return;
    }
    if (this.socket || this.stopped) {
      return;
    }
    this.attachVisibilityListener();
    debugEvent("signal", "start", { role: this.identity.role });
    this.events.onStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.connect();
  }

  stop(): void {
    this.retirePreparedPresentation();
    if (this.unclaimedPresentation) disposePreparedPresentation(this.unclaimedPresentation);
    this.unclaimedPresentation = null;
    this.roomControl?.close();
    this.interactions?.close();
    this.roomVoice?.close();
    this.stopped = true;
    this.authenticatedPeerId = null;
    this.clearTimers();
    this.detachVisibilityListener();
    this.terminalMessage = null;
    this.hostQualityIntent = null;
    this.pendingShareGeneration = null;
    this.relayVolunteerIntent = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client closed");
    }
    this.events.onStatus("offline");
    debugEvent("signal", "stop", { role: this.identity.role });
  }

  send(message: ClientMessage): boolean {
    if (
      !this.authenticatedPeerId ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    if (message.type === "send-room-interaction" &&
      this.socket.bufferedAmount > 16 * 1024) return false;
    this.socket.send(JSON.stringify(message));
    debugEvent("signal", "sent", { generation: this.socketGeneration, message });
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

  ownsHostRoom(roomId: string, hostToken: string | null): boolean {
    return !this.stopped && this.identity.role === "host" && this.identity.roomId === roomId && this.identity.token === hostToken;
  }

  wantsHostPublication(shareGeneration: string): boolean {
    return this.identity.role === "host" && this.identity.roomOnly !== true &&
      this.identity.shareGeneration === shareGeneration;
  }

  /** Keep the authenticated room session and claim a fresh media generation. */
  startSharing(
    shareGeneration: string,
    qualitySettings: QualitySettings,
    routePolicy: RoutePolicy,
    sharingPaused = false,
  ): boolean {
    if (this.identity.role !== "host" || this.stopped || !shareGeneration) {
      return false;
    }
    this.identity.roomOnly = undefined;
    if (this.identity.shareGeneration !== shareGeneration) this.coPlayGrants = [];
    this.identity.shareGeneration = shareGeneration;
    this.identity.sharingPaused = sharingPaused;
    this.identity.qualitySettings = { ...qualitySettings };
    this.identity.routePolicy = { ...routePolicy };
    this.pendingShareGeneration = shareGeneration;
    const sent = this.flushHostShareIntent();
    return sent || this.authenticatedPeerId === null;
  }

  /** Stop only the media publication; the room and interaction session stay alive. */
  stopSharing(shareGeneration: string): boolean {
    if (this.identity.role !== "host" || this.stopped || !shareGeneration ||
      this.identity.shareGeneration !== shareGeneration) {
      return false;
    }
    const sent = this.send({ type: "stop-sharing", shareGeneration });
    this.identity.shareGeneration = undefined;
    this.identity.sharingPaused = false;
    this.identity.roomOnly = true;
    this.pendingShareGeneration = null;
    this.hostQualityIntent = null;
    this.hostAudioAvailable = null;
    this.coPlayGrants = [];
    return sent;
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
    // An explicit start may supersede a pending reconnect for the same room.
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.accessCheck?.abort();
    this.accessCheck = null;

    const generation = ++this.socketGeneration;
    debugEvent("signal", "connecting", { role: this.identity.role, generation });
    const socket = new WebSocket(signalUrl());
    this.socket = socket;
    let routeSelectionRequestedAtAuth = false;
    let membershipExpired = false;

    socket.addEventListener("open", () => {
      if (
        this.socket !== socket ||
        generation !== this.socketGeneration ||
        this.stopped
      ) {
        return;
      }
      const identity = this.identity;
      const authenticate: ClientMessage = this.memberToken ? {
        type: "authenticate-member", protocol: SIGNALING_PROTOCOL, roomId: identity.roomId, token: this.memberToken,
        clientId: identity.clientId, displayName: identity.displayName ?? "Member",
        routePolicy: identity.role === "host" ? identity.routePolicy : DEFAULT_ROUTE_POLICY,
        ...(identity.role === "host" ? { shareGeneration: identity.shareGeneration, sharingPaused: identity.sharingPaused, qualitySettings: identity.qualitySettings }
          : { routePreference: identity.routePreference }),
      } : { type: "authenticate", protocol: SIGNALING_PROTOCOL, ...identity } as ClientMessage;
      routeSelectionRequestedAtAuth = "routePreference" in authenticate && authenticate.routePreference !== undefined;
      socket.send(JSON.stringify(authenticate));
      this.authenticationTimer = window.setTimeout(() => {
        if (!this.authenticatedPeerId && this.socket === socket) {
          socket.close(4000, "authentication timeout");
        }
      }, AUTHENTICATION_TIMEOUT_MS);
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
        debugEvent("signal", "invalid-message", { role: this.identity.role });
        this.terminateForProtocolMismatch();
        return;
      }

      if (message.type === "signaling-challenge-response") {
        this.acceptSignalingChallengeResponse(message.sequence, generation);
        return;
      }
      debugEvent("signal", "received", { generation, message });

      if (message.type === "error") {
        debugEvent("signal", "server-error", { role: this.identity.role, code: message.code });
      } else if (message.type === "route-update" || message.type === "route-status") {
        debugEvent("signal", "route", { role: this.identity.role, type: message.type, revision: message.revision });
      }

      if (
        message.type === "error" &&
        message.code === "INVALID_MESSAGE" &&
        !this.authenticatedPeerId
      ) {
        this.terminateForProtocolMismatch();
        return;
      }

      if (message.type === "error" && message.code === "AUTH_REQUIRED") {
        void this.recoverAuthentication(generation);
        return;
      }

      if (message.type === "error" && message.code === "INVALID_TOKEN" && this.memberToken && !this.authenticatedPeerId) {
        this.memberToken = null;
        membershipExpired = true;
        const ownerToken = this.ownerToken;
        this.recoveringOwner = ownerToken !== null;
        this.identity = ownerToken ? { roomId: this.roomId, clientId: this.clientId, displayName: this.identity.displayName, viewerPresence: true,
          role: "host", token: ownerToken, roomSession: true, roomOnly: true, routePolicy: DEFAULT_ROUTE_POLICY } : { ...this.baselineIdentity };
        socket.close(4000, "membership expired");
        return;
      }
      if (message.type === "error" && message.code === "INVALID_TOKEN" && this.recoveringOwner && this.baselineIdentity.role === "viewer" && !this.authenticatedPeerId) {
        // An ownership offer may have been saved just before the server exited,
        // without committing. Re-enter through the original invitation once.
        this.recoveringOwner = false;
        this.recoveryOwnerToken = null;
        if (this.roomControl) this.roomControl.ownerToken = null;
        this.identity = { ...this.baselineIdentity };
        membershipExpired = true;
        socket.close(4000, "ownership expired");
        return;
      }
      if (message.type === "room-control-ready") {
        this.memberToken = message.token;
        try { saveMemberCredential(this.roomId, { clientId: this.clientId, token: message.token, ...(this.ownerToken ? { ownerToken: this.ownerToken } : {}) }); } catch { /* The live connection remains usable without reload recovery. */ }
        if (this.roomControl) this.roomControl.canonicalUrl = message.canonicalUrl;
        return;
      }
      if (message.type === "room-role-changed") { this.changeMediaRole(message.state); return; }
      if (message.type === "room-control-error" && message.requestId === this.preparedPresentation?.requestId) this.retirePreparedPresentation();
      if (this.roomControl?.receive(message)) {
        if (message.type === "room-control-state" && this.identity.role === "host") this.identity.token = this.roomControl.ownerToken;
        return;
      }
      if (message.type === "error" && FATAL_SIGNAL_ERRORS.has(message.code)) {
        this.stop();
        this.events.onMessage(message);
        return;
      }

      if (message.type === "authenticated") {
        this.recoveringOwner = false;
        this.authenticatedPeerId = message.peerId;
        this.reconnectAttempt = 0;
        this.clearAuthenticationTimer();
        if (this.terminalMessage) {
          const terminalMessage = this.terminalMessage;
          if (this.send(terminalMessage)) {
            this.terminalMessage = null;
            this.stop();
            return;
          }
        }
        this.events.onStatus("connected");
        debugEvent("signal", "authenticated", { role: this.identity.role, generation });
        this.refreshSignalingWatchdog();
        this.interactions?.authenticated(message.peerId);
        this.roomControl?.authenticated(message.peerId);
        this.voiceIceConfig = message.iceConfig;
        if (this.roomVoice) {
          this.roomVoice.updateIceConfig(message.iceConfig);
          this.roomVoice.authenticated(message.peerId, this.identity.role);
          this.roomVoice.subscribeRoom();
        }
        if (this.remoteInputEnabled) this.send({ type: "subscribe-remote-input" });
        // Discovery can complete after the authentication request was sent.
        if (!routeSelectionRequestedAtAuth && this.identity.role === "viewer" && this.identity.routePreference !== undefined) {
          this.setViewerRoutePreference(this.identity.routePreference);
        }
        this.reconcileHostShareState(message);
        this.flushAudioPresence();
        this.flushCoPlayPresence();
      }
      if ((message.type === "sharing-started" || message.type === "sharing-start-failed") &&
        this.pendingShareGeneration === message.shareGeneration) {
        this.pendingShareGeneration = null;
        if (message.type === "sharing-started") {
          this.flushAudioPresence();
          this.flushCoPlayPresence();
        }
      }
      if (message.type === "sharing-start-failed" && this.identity.role === "host" &&
        this.identity.shareGeneration === message.shareGeneration) {
        this.identity.shareGeneration = undefined;
        this.identity.sharingPaused = false;
        this.identity.roomOnly = true;
        this.hostQualityIntent = null;
      }
      if (this.interactions?.receive(message)) return;
      if (this.roomVoice?.receive(message)) return;
      if (
        message.type === "host-status" &&
        this.identity.role === "host" &&
        message.online &&
        !message.paused
      ) {
        this.identity.sharingPaused = false;
      }
      if (message.type === "authenticated" && message.role !== this.identity.role) { this.changeMediaRole(message); return; }
      if (this.handoffPending) {
        // Only the media endpoint is changing; chat and voice keep consuming live messages above.
        if (this.mediaMessages.length >= 256) { this.stop(); return; }
        this.mediaMessages.push(message);
      } else this.events.onMessage(message);
      if (message.type === "authenticated") {
        // The page first sends its ordinary relay report. Restore only this
        // page's explicit intent after that legacy report, in wire order.
        this.flushRelayVolunteerIntent();
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
      this.authenticatedPeerId = null;
      this.interactions?.disconnected();
      this.roomControl?.disconnected();
      this.roomVoice?.disconnected();
      debugEvent("signal", "closed", { role: this.identity.role, code: event.code,
        reconnecting: !this.stopped && shouldReconnectSignaling(event.code) });
      this.clearSignalingWatchdog();
      this.clearAuthenticationTimer();
      if (!this.stopped && (membershipExpired || shouldReconnectSignaling(event.code))) {
        this.scheduleReconnect();
      } else if (!this.stopped) {
        this.stop();
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

  private async recoverAuthentication(generation: number): Promise<void> {
    this.retireSocketForRecovery();
    // AUTH_REQUIRED also means the room handshake timed out or was incomplete.
    // Only the site-access owner can require a Host to enter a site password.
    if (this.identity.role === "host") {
      this.events.onStatus("reconnecting");
      if (this.stopped || generation !== this.socketGeneration) return;
      const controller = new AbortController();
      this.accessCheck = controller;
      const timer = window.setTimeout(() => controller.abort(), AUTHENTICATION_TIMEOUT_MS);
      try {
        const access = await getSiteAccess(controller.signal);
        if (this.stopped || generation !== this.socketGeneration) return;
        if (access.required && !access.authenticated) {
          this.stop();
          this.events.onAccessRequired();
          return;
        }
      } catch {
        // An unavailable check is a connection failure, not evidence of denial.
      } finally {
        window.clearTimeout(timer);
        if (this.accessCheck === controller) this.accessCheck = null;
      }
    }
    if (!this.stopped && generation === this.socketGeneration) this.scheduleReconnect();
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

  private flushHostShareIntent(): boolean {
    const shareGeneration = this.pendingShareGeneration;
    if (
      !shareGeneration ||
      this.identity.role !== "host" ||
      this.identity.shareGeneration !== shareGeneration
    ) {
      return false;
    }
    try {
      if (!this.send({
        type: "start-sharing",
        shareGeneration,
        sharingPaused: this.identity.sharingPaused,
        qualitySettings: this.identity.qualitySettings,
        routePolicy: this.identity.routePolicy,
      })) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private reconcileHostShareState(
    message: Extract<ServerMessage, { type: "authenticated" }>,
  ): void {
    if (this.identity.role !== "host" || this.identity.roomSession !== true) {
      return;
    }
    const desiredGeneration = this.identity.shareGeneration;
    if (this.identity.roomOnly === true) {
      this.pendingShareGeneration = null;
      if (message.shareGeneration !== null) {
        // stopSharing may have been requested while authentication was still
        // in flight. The authenticated reply is the first point where the
        // server can accept the idempotent stop for that session.
        this.send({
          type: "stop-sharing",
          shareGeneration: message.shareGeneration,
        });
      }
      return;
    }
    if (!desiredGeneration) {
      this.pendingShareGeneration = null;
      return;
    }
    if (message.shareGeneration === desiredGeneration) {
      // Authentication already claimed this generation; sending a second
      // start-sharing would be rejected as a duplicate publication.
      this.pendingShareGeneration = null;
      return;
    }
    if (message.shareGeneration === null) {
      this.flushHostShareIntent();
      return;
    }
    if (this.pendingShareGeneration === desiredGeneration) {
      // A stop/start can cross the authentication response: the socket was
      // authenticated with the old generation, while the UI already owns a
      // fresh one. WebSocket ordering makes this pair one serialized server
      // transition; keep the new intent and retire the stale publication.
      if (this.send({
        type: "stop-sharing",
        shareGeneration: message.shareGeneration,
      })) {
        this.flushHostShareIntent();
      }
      return;
    }
    // Without a pending local intent, the server's active generation is
    // authoritative. Do not retry an intent that no longer describes this
    // authenticated session.
    this.pendingShareGeneration = null;
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
    this.accessCheck?.abort();
    this.accessCheck = null;
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
    if (!this.socket || generation !== this.socketGeneration || this.stopped) {
      return;
    }
    this.retireSocketForRecovery();
    this.events.onStatus("reconnecting");
    this.connect();
  }

  private retireSocketForRecovery(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticatedPeerId = null;
    this.interactions?.disconnected();
      this.roomControl?.disconnected();
    this.roomVoice?.disconnected();
    this.clearAuthenticationTimer();
    this.clearSignalingWatchdog();
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(SIGNAL_CLOSE_CODES.clientReconnect, "signaling recovery");
    }
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
      this.authenticatedPeerId !== null &&
      this.isDocumentVisible() &&
      this.socket?.readyState === WebSocket.OPEN
    );
  }
}
