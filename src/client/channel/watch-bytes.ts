import { loadRoomHosting } from "./hosting";
import type { WatchDelivery } from "../../../prototype/channel-browser/pkg/piik_channel_browser";
import type { WatchBytePlan, WatchByteSource, ChannelPair } from "./protocol";
import type { WatchByteResult } from "./watch-resource";

interface Key { roomId: string; activityId: string; resourceId: string }
interface Result { mimeType: string; totalSize: number | null; bytes: number[]; eof: boolean }
type Effect =
  | { type: "send_control"; peer: string; control: { type: string; key: Key; requestId: string } }
  | { type: "send_chunk"; peer: string; key: Key; requestId: string; frame: number[] }
  | { type: "received"; requestId: string; result: Result }
  | { type: "failed"; requestId: string; code: string }
  | { type: "read" | "cancel_read"; requestId: string };
interface Pending {
  key: Key; source: WatchByteSource; offset: number; length: number; started: boolean;
  resolve(value: WatchByteResult): void; reject(error: Error): void; cleanup(): void;
}
interface Runtime { delivery: WatchDelivery; module: Awaited<ReturnType<typeof loadRoomHosting>>; lifetime: AbortController }
export const sameWatchByteSource = (a: WatchByteSource, b: WatchByteSource | null | undefined) => a.sessionId === b?.sessionId && a.resourceId === b.resourceId && a.format === b.format;

/** Browser I/O for the shared Core range protocol on the existing room channels. */
export class WatchBytes {
  private sessionId: string | null = null;
  private runtime: Promise<Runtime> | null = null;
  private plans: WatchBytePlan[] = [];
  private roomPeers: [string, string[]][] = [];
  private lifetime = new AbortController();
  private pending = new Map<string, Pending>();
  constructor(private send: (peer: string, kind: "control" | "chunk", data: string | Uint8Array, allowed: () => boolean) => Promise<void>) {}
  private ensure(): Promise<Runtime> {
    if (!this.sessionId) return Promise.reject(new Error("disconnected"));
    if (this.runtime) return this.runtime;
    const sessionId = this.sessionId, lifetime = this.lifetime;
    const runtime = loadRoomHosting().then(async module => {
      await module.initializeRuntime();
      lifetime.signal.throwIfAborted();
      const runtime = { module, delivery: new module.WatchDelivery(sessionId), lifetime };
      try {
        this.effects(runtime, runtime.delivery.update(JSON.stringify(this.plans), JSON.stringify(this.roomPeers)));
      } catch (error) {
        runtime.delivery.free();
        throw error;
      }
      return runtime;
    });
    // A failed load is not a runtime; the next demand loads again.
    runtime.catch(() => { if (this.runtime === runtime) this.runtime = null; });
    return this.runtime = runtime;
  }
  private current(runtime: Runtime): boolean { return runtime.lifetime === this.lifetime && !runtime.lifetime.signal.aborted; }
  update(sessionId: string, plans: WatchBytePlan[], pairs: Pick<ChannelPair, "peerId" | "rooms">[]): void {
    if (this.sessionId !== sessionId) this.reset();
    this.sessionId = sessionId;
    this.plans = plans;
    this.roomPeers = pairs.map(pair => [pair.peerId, pair.rooms]);
    if (plans.length || this.runtime) void this.ensure().then(runtime => {
      if (!this.current(runtime)) return;
      this.effects(runtime, runtime.delivery.update(JSON.stringify(this.plans), JSON.stringify(this.roomPeers)));
      for (const [id, pending] of this.pending) if (!pending.started) this.start(runtime, id, pending);
    }).catch(() => {});
  }
  private start(runtime: Runtime, id: string, pending: Pending): void {
    const plan = this.plans.find(value => value.roomId === pending.key.roomId && value.activityId === pending.key.activityId);
    if (plan && !sameWatchByteSource(plan.source, pending.source)) { this.finish(id, new Error("watch_source_changed")); return; }
    if (!plan?.receiving) return;
    if (plan.source.sessionId !== this.sessionId && plan.upstream === null) return;
    pending.started = true;
    this.effects(runtime, runtime.delivery.read(JSON.stringify(pending.key), id, BigInt(pending.offset), pending.length));
  }
  async read(roomId: string, activityId: string, source: WatchByteSource, resourceId: string, offset: number, length: number, signal: AbortSignal): Promise<WatchByteResult> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > 65536) throw new Error("invalid_watch_range");
    if (this.pending.size >= 32) throw new Error("watch_read_busy");
    const runtime = await this.ensure();
    signal.throwIfAborted();
    if (this.pending.size >= 32) throw new Error("watch_read_busy");
    if (!this.current(runtime)) throw new Error("disconnected");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (this.current(runtime)) this.effects(runtime, runtime.delivery.cancel(id));
        this.finish(id, new DOMException("Cancelled", "AbortError"));
      };
      const pending: Pending = { key: { roomId, activityId, resourceId }, source, offset, length, started: false, resolve, reject,
        cleanup: () => signal.removeEventListener("abort", cancel) };
      this.pending.set(id, pending);
      signal.addEventListener("abort", cancel, { once: true });
      this.start(runtime, id, pending);
    });
  }
  private finish(id: string, value: WatchByteResult | Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); pending.cleanup();
    value instanceof Error ? pending.reject(value) : pending.resolve(value);
  }
  data(peer: string, kind: "control" | "chunk", data: string | Uint8Array): void {
    void this.ensure().then(runtime => {
      if (!this.current(runtime)) return;
      this.effects(runtime, kind === "control" ? runtime.delivery.control(peer, data as string) : runtime.delivery.chunk(peer, data as Uint8Array));
    }).catch(() => {});
  }
  peerClosed(peer: string): void {
    if (this.runtime) void this.runtime.then(runtime => {
      if (this.current(runtime)) this.effects(runtime, runtime.delivery.peer_closed(peer));
    }).catch(() => {});
  }
  private effects(runtime: Runtime, raw: string): void {
    if (!this.current(runtime)) return;
    const failedResponses = new Set<string>();
    for (const effect of JSON.parse(raw) as Effect[]) {
      if (effect.type === "received") this.finish(effect.requestId, { ...effect.result, bytes: Uint8Array.from(effect.result.bytes) });
      else if (effect.type === "failed") {
        this.finish(effect.requestId, new Error(effect.code));
      } else if (effect.type === "read") this.effects(runtime, runtime.delivery.read_failed(effect.requestId, "watch_source_unavailable"));
      else if (effect.type === "send_control" || effect.type === "send_chunk") {
        const key = effect.type === "send_control" ? effect.control.key : effect.key;
        const source = this.plans.find(plan => plan.activityId === key.activityId && plan.roomId === key.roomId)?.source;
        const terminal = effect.type === "send_control" && ["cancel", "error"].includes(effect.control.type);
        const requestId = effect.type === "send_control" ? effect.control.requestId : effect.requestId;
        const pending = effect.type === "send_control" && effect.control.type === "pull" ? this.pending.get(requestId) : undefined;
        const current = () => this.current(runtime) && !failedResponses.has(requestId) && (!pending || this.pending.get(requestId) === pending);
        // A terminal frame can retire an old plan while the pair still serves this room.
        const roomGranted = () => this.roomPeers.some(([peer, rooms]) => peer === effect.peer && rooms.includes(key.roomId));
        const terminalAllowed = () => this.current(runtime) && roomGranted();
        const allowed = () => current() && roomGranted() && this.plans.some(plan => plan.activityId === key.activityId && plan.roomId === key.roomId
          && sameWatchByteSource(plan.source, source) && (plan.upstream === effect.peer || plan.downstream.includes(effect.peer)));
        const data = effect.type === "send_chunk" ? Uint8Array.from(effect.frame)
          : this.controlFrame(runtime, effect.control);
        void this.send(effect.peer, effect.type === "send_chunk" ? "chunk" : "control", data, terminal ? terminalAllowed : allowed)
          .catch(() => {
            if (!current() || terminal) return;
            if (effect.type === "send_chunk") {
              failedResponses.add(requestId);
              const error = this.controlFrame(runtime, { type: "error", key, requestId, code: "watch_path_unavailable" });
              return this.send(effect.peer, "control", error, terminalAllowed).catch(() => {});
            }
            this.effects(runtime, runtime.delivery.request_failed(requestId, "watch_path_unavailable"));
          });
      }
    }
  }
  private controlFrame(runtime: Runtime, body: { type: string; key: Key; requestId: string; code?: string }): string {
    return new TextDecoder().decode(runtime.module.encode_control(JSON.stringify({ kind: "watch", body })));
  }
  reset(): void {
    const runtime = this.runtime;
    this.lifetime.abort(); this.lifetime = new AbortController();
    this.sessionId = null; this.runtime = null; this.plans = []; this.roomPeers = [];
    for (const id of this.pending.keys()) this.finish(id, new Error("disconnected"));
    if (runtime) void runtime.then(value => value.delivery.free()).catch(() => {});
  }
}
