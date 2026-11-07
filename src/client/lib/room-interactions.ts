import { interactionPayloadSchema, type InteractionPayload } from "../../shared/protocol";
import { INTERACTION_INTERVAL_MS, REACTION_DURATION_MS, REACTION_IDS, type ReactionId } from "../../shared/room-interactions";
import { createOpaqueId } from "./opaque-id";
import { identityHash } from "./identity-hash";
import { CHAT_OVERLAY_DEFAULTS, CHAT_OVERLAY_LIMITS, readRoomPreferences, saveRoomPreferences, type RoomPreferences } from "./room-preferences";

export interface RoomInteraction {
  type: "room-interaction";
  id: string;
  requestId: string;
  occurredAt: number;
  sender: { peerId: string; role: "host" | "viewer"; displayName: string };
  payload: InteractionPayload;
}
type Rejection = "rate-limited" | "target-unavailable" | "not-subscribed" | "busy";
type InteractionCommand =
  | { type: "subscribe-room-interactions" }
  | { type: "send-room-interaction"; requestId: string; payload: InteractionPayload };
type InteractionEvent =
  | { type: "room-interactions-ready"; serverTime: number }
  | { type: "room-interaction-rejected"; requestId: string; reason: Rejection }
  | (Omit<RoomInteraction, "payload"> & { payload: unknown });
export type InteractionError = Rejection | "offline" | "unconfirmed";
export const CHAT_OVERLAY_DURATION_MS = 6000;
export const CHAT_HISTORY_LIMIT = 1000;
type OverlayAppearance = RoomPreferences["overlayAppearance"];
const CHAT_OVERLAY_LANES = 3;
interface InteractionState {
  reactionIds: readonly ReactionId[];
  ready: boolean;
  peerId: string | null;
  messages: (RoomInteraction & { isSelf: boolean })[];
  reactions: (RoomInteraction & { expiresAt: number })[];
  overlayEnabled: boolean;
  overlayAppearance: OverlayAppearance;
  overlayMessages: (RoomInteraction & { expiresAt: number; durationMs: number; lane: number })[];
  pending: { requestId: string; payload: InteractionPayload } | null;
  confirmed: RoomInteraction | null;
  coolingDown: boolean;
  error: InteractionError | null;
}
const initialState = (): InteractionState => ({ reactionIds: REACTION_IDS, ready: false, peerId: null, messages: [], reactions: [],
  overlayEnabled: false, overlayAppearance: CHAT_OVERLAY_DEFAULTS, overlayMessages: [],
  pending: null, confirmed: null, coolingDown: false, error: null });

// One state per joined room. Media generations and route changes do not reset it.
export class RoomInteractionSession {
  // Component state follows this room session, not reconnecting wire peer IDs.
  readonly key = createOpaqueId();
  private state = initialState();
  private listeners = new Set<() => void>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private effectsTimer: ReturnType<typeof setTimeout> | undefined;
  private visibleOverlays = new Set<object>();
  private requestId: string | null = null;
  private closed = false;
  private subscriptionStartedAt: number | null = null;
  private serverOffset = 0;

  constructor(private readonly sendMessage: (message: InteractionCommand) => boolean, readonly now = Date.now, reactionIds?: readonly string[]) {
    const { overlayEnabled, overlayAppearance } = readRoomPreferences();
    this.state = { ...this.state, overlayEnabled, overlayAppearance };
    this.setSupportedReactions(reactionIds);
  }

  setSupportedReactions(reactionIds: readonly string[] = REACTION_IDS): void {
    if (this.closed) return;
    this.update({ reactionIds: REACTION_IDS.filter(id => reactionIds.includes(id)) });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<InteractionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private startCooldown() {
    clearTimeout(this.cooldownTimer);
    this.update({ coolingDown: true });
    this.cooldownTimer = setTimeout(() => this.update({ coolingDown: false }), INTERACTION_INTERVAL_MS);
  }

  authenticated(peerId: string) {
    if (this.closed) return;
    this.disconnected();
    this.update({ peerId, error: this.state.error === "unconfirmed" ? "unconfirmed" : null });
    this.subscriptionStartedAt = this.now();
    this.sendMessage({ type: "subscribe-room-interactions" });
  }

  receive(event: InteractionEvent): boolean {
    if (this.closed) return false;
    if (event.type === "room-interactions-ready") {
      if (this.subscriptionStartedAt === null) return true;
      // One connection-scoped midpoint estimate; arrivals never move the clock.
      this.serverOffset = event.serverTime - (this.subscriptionStartedAt + this.now()) / 2;
      this.subscriptionStartedAt = null;
      this.update({ ready: true });
      return true;
    }
    if (event.type === "room-interaction-rejected") {
      if (event.requestId === this.requestId) {
        this.requestId = null;
        clearTimeout(this.pendingTimer);
        this.update({ pending: null, error: event.reason });
      }
      return true;
    }
    if (event.type !== "room-interaction") return false;
    if (!this.state.ready) return true;
    const payload = interactionPayloadSchema.safeParse(event.payload);
    // Unsupported decoration is not a signaling failure or a send confirmation.
    if (!payload.success) return true;
    const message: RoomInteraction = { ...event, payload: payload.data };
    const now = this.now();
    // Clock uncertainty may put a fresh event slightly ahead. Never extend its
    // lifetime beyond one full effect, and never replay an expired effect.
    const beganAt = Math.min(now, message.occurredAt - this.serverOffset);
    const own = message.sender.peerId === this.state.peerId;
    const confirmsPending = own && message.requestId === this.requestId;
    if (confirmsPending) {
      this.requestId = null;
      // The Host's interval starts at acceptance, after outbound queueing.
      this.startCooldown();
    }
    const confirmed = confirmsPending ? message : this.state.confirmed;
    const pending = confirmsPending ? null : this.state.pending;
    if (!pending) clearTimeout(this.pendingTimer);
    if (message.payload.kind === "chat") {
      if (this.state.messages.some(item => item.id === message.id)) return true;
      let overlayMessages = this.state.overlayMessages.filter(item => item.expiresAt > now);
      const lane = identityHash(`${message.sender.peerId}:${message.id}`) % CHAT_OVERLAY_LANES;
      const durationMs = CHAT_OVERLAY_DURATION_MS / this.state.overlayAppearance.speed;
      const expiresAt = beganAt + durationMs;
      if (this.state.overlayEnabled && this.visibleOverlays.size > 0 && expiresAt > now) {
        // Newest on this fixed lane wins; missing messages cannot shift a later
        // event to another lane, and bursts cannot accumulate a playback queue.
        overlayMessages = [...overlayMessages.filter(item => item.lane !== lane), { ...message, lane, expiresAt, durationMs }];
      }
      this.update({ messages: [...this.state.messages.slice(1 - CHAT_HISTORY_LIMIT), { ...message, isSelf: own }],
        overlayMessages, pending, confirmed, error: confirmsPending ? null : this.state.error });
    } else {
      if (this.state.reactions.some(item => item.id === message.id)) return true;
      const expiresAt = beganAt + REACTION_DURATION_MS;
      const reactions = this.state.reactions.filter(item => item.expiresAt > now);
      this.update({ reactions: expiresAt > now ? [...reactions.slice(-7), { ...message, expiresAt }] : reactions,
        pending, confirmed, error: confirmsPending ? null : this.state.error });
    }
    this.expireEffects();
    return true;
  }

  send(payload: InteractionPayload): boolean {
    if (this.closed || !this.state.ready || this.state.pending || this.state.coolingDown ||
      !interactionPayloadSchema.safeParse(payload).success ||
      payload.kind === "reaction" && !this.state.reactionIds.includes(payload.reaction)) return false;
    const requestId = createOpaqueId();
    try {
      if (!this.sendMessage({ type: "send-room-interaction", requestId, payload })) {
        this.update({ error: "offline" });
        return false;
      }
    } catch {
      this.update({ error: "offline" });
      return false;
    }
    // The timeout releases the send control, not this request's identity.
    // A late result may settle it until another submission or connection replaces it.
    this.requestId = requestId;
    this.update({ pending: { requestId, payload }, error: null });
    this.pendingTimer = setTimeout(() => this.update({ pending: null, error: "unconfirmed" }), 5000);
    this.startCooldown();
    return true;
  }

  setOverlayEnabled(enabled: boolean) {
    if (this.closed || this.state.overlayEnabled === enabled) return;
    this.update({ overlayEnabled: enabled, overlayMessages: [] });
    saveRoomPreferences({ overlayEnabled: enabled });
    this.expireEffects();
  }

  /** Each visible picture releases only its own interest in live chat flights. */
  showOverlay(): () => void {
    if (this.closed) return () => {};
    const owner = {};
    this.visibleOverlays.add(owner);
    return () => {
      if (!this.visibleOverlays.delete(owner) || this.visibleOverlays.size > 0) return;
      this.update({ overlayMessages: [] });
      this.expireEffects();
    };
  }

  setOverlayAppearance(patch: Partial<OverlayAppearance>) {
    const appearance = { ...this.state.overlayAppearance, ...patch };
    if (this.closed || !Number.isFinite(appearance.scale) || !Number.isFinite(appearance.opacity) || !Number.isFinite(appearance.speed)) return;
    this.update({ overlayAppearance: {
      scale: Math.min(CHAT_OVERLAY_LIMITS.scale[1], Math.max(CHAT_OVERLAY_LIMITS.scale[0], appearance.scale)),
      opacity: Math.min(CHAT_OVERLAY_LIMITS.opacity[1], Math.max(CHAT_OVERLAY_LIMITS.opacity[0], appearance.opacity)),
      speed: Math.min(CHAT_OVERLAY_LIMITS.speed[1], Math.max(CHAT_OVERLAY_LIMITS.speed[0], appearance.speed)),
      colorBySender: appearance.colorBySender,
    } });
    saveRoomPreferences({ overlayAppearance: this.state.overlayAppearance });
  }

  private expireEffects() {
    clearTimeout(this.effectsTimer);
    const next = Math.min(...[...this.state.reactions, ...this.state.overlayMessages].map(item => item.expiresAt));
    if (!Number.isFinite(next)) return;
    this.effectsTimer = setTimeout(() => {
      this.update({ reactions: this.state.reactions.filter(item => item.expiresAt > this.now()),
        overlayMessages: this.state.overlayMessages.filter(item => item.expiresAt > this.now()) });
      this.expireEffects();
    }, Math.max(1, next - this.now()));
  }

  disconnected() {
    this.requestId = null;
    this.subscriptionStartedAt = null;
    this.serverOffset = 0;
    clearTimeout(this.pendingTimer);
    clearTimeout(this.cooldownTimer);
    clearTimeout(this.effectsTimer);
    this.update({ ready: false, reactions: [], overlayMessages: [], coolingDown: false, pending: null, confirmed: null,
      error: this.state.pending ? "unconfirmed" : this.state.error });
  }
  close() {
    this.closed = true;
    this.visibleOverlays.clear();
    this.disconnected();
    this.update(initialState());
  }
}
