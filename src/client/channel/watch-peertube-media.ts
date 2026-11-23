import { WATCH_MEDIA_RESPONSE_MS, waitForWatchMedia, type WatchMedia, type WatchMediaEvent, type WatchMediaState, type WatchMediaPatch } from "./watch-media";
import { peerTubeOrigin, publicPeerTubeURL } from "./watch-peertube-source";

// Covers public metadata and the remote iframe's API handshake. First user play has no deadline.
const PEERTUBE_STARTUP_MS = 20_000;

export class PeerTubeMedia implements WatchMedia {
  private readonly element = document.createElement("div");
  private readonly frame = document.createElement("iframe");
  private readonly scope = crypto.randomUUID();
  private readonly life = new AbortController();
  private readonly listeners = new Set<(event: WatchMediaEvent) => void>();
  private readonly pending = new Map<number, (value: unknown, error?: Error) => void>();
  private nextId = 0;
  private readonly readyQueryId = ++this.nextId;
  private mounted = false;
  private visible = false;
  private automatic = true;
  private apiReady = false;
  private closed = false;
  private duration: number | null = null;
  private position = 0;
  private state = "unstarted";
  private played = false;
  private rates = [1];
  private rate = 1;
  private setupTimer?: number;
  private presented = false;
  sourceURL = "";
  readonly seekTolerance = 2;
  readonly seekEvents = false;

  constructor(private id: string, private suspendWhenHidden = false) {
    this.element.className = "c3-watch-embed";
  }

  readonly presentation = { kind: "embed" as const, element: this.element,
    mounted: () => { this.presented = true; this.element.dispatchEvent(new Event("mounted")); },
    setVisible: (visible: boolean, automatic = true) => {
      if (this.life.signal.aborted) return;
      const wasAvailable = this.playbackAvailable();
      this.visible = visible; this.automatic = automatic;
      if (visible && !this.mounted && this.element.isConnected) {
        this.mounted = true;
        void this.mount().catch(() => this.fail());
      }
      if (!visible && this.suspendWhenHidden && this.apiReady && this.state === "playing")
        void this.call("pause").catch(() => this.fail());
      if (!wasAvailable && this.playbackAvailable()) this.emit("visibility-resumed");
    },
  };
  waitForPresentation(signal: AbortSignal): Promise<void> {
    const until = AbortSignal.any([signal, this.life.signal]);
    until.throwIfAborted();
    if (this.presented) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => reject(until.reason);
      until.addEventListener("abort", abort, { once: true });
      this.element.addEventListener("mounted", () => { until.removeEventListener("abort", abort); resolve(); }, { once: true, signal: until });
    });
  }
  private async mount() {
    this.setupTimer = window.setTimeout(() => this.fail(), PEERTUBE_STARTUP_MS);
    const url = await publicPeerTubeURL(this.id, this.life.signal);
    this.life.signal.throwIfAborted();
    this.sourceURL = url;
    this.frame.title = "PeerTube";
    this.frame.allow = "autoplay; fullscreen; picture-in-picture";
    this.frame.setAttribute("credentialless", "");
    this.frame.referrerPolicy = "no-referrer";
    this.frame.src = this.sourceURL + "?api=1&p2p=0&scope=" + this.scope;
    window.addEventListener("message", this.receive, { signal: this.life.signal });
    this.element.append(this.frame);
  }
  private send(method: string, params?: unknown, id?: number) {
    this.frame.contentWindow?.postMessage(JSON.stringify({ method: this.scope + "::" + method, params, id }), peerTubeOrigin);
  }
  private call(method: string, params?: unknown): Promise<unknown> {
    this.life.signal.throwIfAborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer); this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const timer = window.setTimeout(() => finish(undefined, new Error("watch_media_failed")), WATCH_MEDIA_RESPONSE_MS);
      this.pending.set(id, finish); this.send(method, params, id);
    });
  }
  private receive = (event: MessageEvent) => {
    if (event.origin !== peerTubeOrigin || event.source !== this.frame.contentWindow || typeof event.data !== "string") return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (!packet || typeof packet !== "object") return;
    if (!packet.method && packet.id === this.readyQueryId) {
      if (!packet.error && packet.result === true) this.onReady();
      return;
    }
    if (!packet.method) { this.pending.get(packet.id)?.(packet.result, packet.error ? new Error("watch_media_failed") : undefined); return; }
    if (typeof packet.method !== "string" || !packet.method.startsWith(this.scope + "::")) return;
    const method = packet.method.slice(this.scope.length + 2), value = packet.params;
    if (method === "__ready" && value?.type === "publish-request") {
      this.send("__ready", { type: "publish-reply", publish: [] });
      // The startup timer covers both the ready event and its query fallback.
      if (!this.apiReady) this.send("isReady", undefined, this.readyQueryId);
    } else if (method === "ready" && value === true) this.onReady();
    else if (method === "playbackStatusUpdate" && Number.isFinite(value?.position)) {
      const duration = typeof value.duration === "string" && value.duration.trim() ? Number(value.duration) : value.duration;
      if (Number.isFinite(duration) && duration >= 0) this.duration = duration;
      const previous = this.position; this.position = value.position;
      this.state = value.playbackState;
      if (!this.played && this.state === "playing" && this.position > previous) { this.played = true; this.emit("loadeddata"); }
    } else if (method === "playbackStatusChange" && ["playing","paused","ended"].includes(value)) {
      this.state = value; this.emit(value === "paused" ? "pause" : value);
    }
  };
  private onReady() {
    if (this.life.signal.aborted || this.apiReady) return;
    this.apiReady = true; clearTimeout(this.setupTimer);
    void this.call("getPlaybackRates").then(rates => {
      if (this.life.signal.aborted) return;
      if (Array.isArray(rates)) this.rates = rates.filter(rate => Number.isFinite(rate) && rate > 0);
      this.emit("loadedmetadata");
    }).catch(() => this.fail());
  }
  private fail() {
    if (this.life.signal.aborted) return;
    this.retireTransport(new Error("watch_media_unavailable"));
    this.emit("error");
  }
  playbackAvailable() { return this.visible && this.automatic; }
  playbackRates() { return this.rates; }
  ready(signal: AbortSignal) { return waitForWatchMedia(this, signal); }
  async read(): Promise<WatchMediaState> {
    this.life.signal.throwIfAborted();
    const [position, playing, rate] = this.apiReady
      ? await Promise.all([this.call("getCurrentTime"), this.call("isPlaying"), this.call("getPlaybackRate")]) : [0, false, 1];
    if (typeof position !== "number" || !Number.isFinite(position) || typeof playing !== "boolean" || typeof rate !== "number" || !Number.isFinite(rate))
      throw new Error("watch_media_failed");
    if (rate !== this.rate) { this.rate = rate; this.emit("ratechange"); }
    return { position, paused: !playing, rate, duration: this.duration, buffered: null,
      readyState: this.played ? playing ? 3 : 2 : this.apiReady ? 1 : 0, ended: this.state === "ended" };
  }
  async patch(value: WatchMediaPatch) {
    this.life.signal.throwIfAborted();
    if (!this.visible || !this.apiReady) return;
    if (value.rate !== undefined) {
      if (!this.rates.includes(value.rate)) throw new Error("watch_media_unsupported");
      await this.call("setPlaybackRate", value.rate);
    }
    if (value.position !== undefined) await this.call("seek", value.position);
    if (value.paused === true) await this.call("pause");
    else if (value.paused === false && this.playbackAvailable()) await this.call("play");
  }
  listen(changed: (event: WatchMediaEvent) => void) { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  private emit(event: WatchMediaEvent) { for (const changed of this.listeners) changed(event); }
  private retireTransport(reason?: Error) {
    this.life.abort(reason);
    clearTimeout(this.setupTimer);
    for (const finish of this.pending.values()) finish(undefined, this.life.signal.reason);
    this.frame.remove();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.retireTransport();
    this.element.remove(); this.emit("closed"); this.listeners.clear();
  }
}
