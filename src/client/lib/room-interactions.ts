import { interactionPayloadSchema, type ClientMessage, type ServerMessage, type InteractionPayload } from "../../shared/protocol";
import { INTERACTION_INTERVAL_MS, REACTION_DURATION_MS } from "../../shared/room-interactions";
import { createOpaqueId } from "./opaque-id";
import { identityHash } from "./identity-hash";

export type RoomInteraction = Extract<ServerMessage, { type: "room-interaction" }>;
type Rejection = Extract<ServerMessage, { type: "room-interaction-rejected" }>["reason"];
export type InteractionError = Rejection | "offline" | "unconfirmed";
export const CHAT_OVERLAY_DURATION_MS = 6000;
export const CHAT_HISTORY_LIMIT = 1000;
export const CHAT_OVERLAY_LIMITS = { scale: [.8, 1.3], opacity: [.4, 1] } as const;
type OverlayAppearance = { scale: number; opacity: number };
const CHAT_OVERLAY_LANES = 3;
interface InteractionState {
  ready: boolean;
  peerId: string | null;
  messages: (RoomInteraction & { isSelf: boolean })[];
  reactions: (RoomInteraction & { expiresAt: number })[];
  overlayEnabled: boolean;
  overlayAppearance: OverlayAppearance;
  overlayMessages: (RoomInteraction & { expiresAt: number; lane: number })[];
  pending: { requestId: string; payload: InteractionPayload } | null;
  confirmed: RoomInteraction | null;
  coolingDown: boolean;
  error: InteractionError | null;
}
const initialState = (): InteractionState => ({ ready: false, peerId: null, messages: [], reactions: [],
  overlayEnabled: false, overlayAppearance: { scale: 1, opacity: 1 }, overlayMessages: [],
  pending: null, confirmed: null, coolingDown: false, error: null });

// One owner per signaling client. Authentication admits room data; media
// generations and route changes deliberately do not reset this state.
export class RoomInteractionSession {
  // Component state follows this room session, not reconnecting wire peer IDs.
  readonly key = createOpaqueId();
  private state = initialState();
  private listeners = new Set<() => void>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private effectsTimer: ReturnType<typeof setTimeout> | undefined;
  private overlayVisible = false;
  private closed = false;
  private subscriptionStartedAt: number | null = null;
  private serverOffset = 0;

  constructor(private readonly sendMessage: (message: ClientMessage) => boolean, readonly now = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<InteractionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  authenticated(peerId: string) {
    if (this.closed) return;
    this.disconnected();
    this.update({ peerId, error: this.state.error === "unconfirmed" ? "unconfirmed" : null });
    this.subscriptionStartedAt = this.now();
    this.sendMessage({ type: "subscribe-room-interactions" });
  }

  receive(message: ServerMessage): boolean {
    if (this.closed) return false;
    if (message.type === "room-interactions-ready") {
      if (this.subscriptionStartedAt === null) return true;
      // One connection-scoped midpoint estimate; arrivals never move the clock.
      this.serverOffset = message.serverTime - (this.subscriptionStartedAt + this.now()) / 2;
      this.subscriptionStartedAt = null;
      this.update({ ready: true });
      return true;
    }
    if (message.type === "room-interaction-rejected") {
      if (message.requestId === this.state.pending?.requestId) {
        clearTimeout(this.pendingTimer);
        this.update({ pending: null, error: message.reason });
      }
      return true;
    }
    if (message.type !== "room-interaction") return false;
    if (!this.state.ready) return true;
    const now = this.now();
    // Clock uncertainty may put a fresh event slightly ahead. Never extend its
    // lifetime beyond one full effect, and never replay an expired effect.
    const beganAt = Math.min(now, message.occurredAt - this.serverOffset);
    const own = message.sender.peerId === this.state.peerId;
    const confirmsPending = own && message.requestId === this.state.pending?.requestId;
    const confirmed = confirmsPending ? message : this.state.confirmed;
    const pending = confirmsPending ? null : this.state.pending;
    if (!pending) clearTimeout(this.pendingTimer);
    if (message.payload.kind === "chat") {
      if (this.state.messages.some(item => item.id === message.id)) return true;
      let overlayMessages = this.state.overlayMessages.filter(item => item.expiresAt > now);
      const lane = identityHash(`${message.sender.peerId}:${message.id}`) % CHAT_OVERLAY_LANES;
      const expiresAt = beganAt + CHAT_OVERLAY_DURATION_MS;
      if (this.state.overlayEnabled && this.overlayVisible && expiresAt > now) {
        // Newest on this fixed lane wins; missing messages cannot shift a later
        // event to another lane, and bursts cannot accumulate a playback queue.
        overlayMessages = [...overlayMessages.filter(item => item.lane !== lane), { ...message, lane, expiresAt }];
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
      !interactionPayloadSchema.safeParse(payload).success) return false;
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
    this.update({ pending: { requestId, payload }, coolingDown: true, error: null });
    this.pendingTimer = setTimeout(() => this.update({ pending: null, error: "unconfirmed" }), 5000);
    this.cooldownTimer = setTimeout(() => this.update({ coolingDown: false }), INTERACTION_INTERVAL_MS);
    return true;
  }

  setOverlayEnabled(enabled: boolean) {
    if (this.closed || this.state.overlayEnabled === enabled) return;
    this.update({ overlayEnabled: enabled, overlayMessages: [] });
    this.expireEffects();
  }

  setOverlayVisible(visible: boolean) {
    if (this.closed || this.overlayVisible === visible) return;
    this.overlayVisible = visible;
    if (!visible) this.update({ overlayMessages: [] });
    this.expireEffects();
  }

  setOverlayAppearance(appearance: OverlayAppearance) {
    if (this.closed || !Number.isFinite(appearance.scale) || !Number.isFinite(appearance.opacity)) return;
    this.update({ overlayAppearance: {
      scale: Math.min(CHAT_OVERLAY_LIMITS.scale[1], Math.max(CHAT_OVERLAY_LIMITS.scale[0], appearance.scale)),
      opacity: Math.min(CHAT_OVERLAY_LIMITS.opacity[1], Math.max(CHAT_OVERLAY_LIMITS.opacity[0], appearance.opacity)),
    } });
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
    this.disconnected();
    this.update(initialState());
  }
}
