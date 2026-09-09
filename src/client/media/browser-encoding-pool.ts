import { createOpaqueId } from "../lib/opaque-id";
import { EMPTY_METRICS, type ConnectionMetrics } from "../types";
import { captureMetrics, collectConnectionMetricsFromReport, createStatsAccumulator } from "../webrtc/stats";
import { BrowserEncodingProducer } from "./browser-encoding-producer";
import { codecIdentity, fits, nativeVideoBudget, negotiatedCodec, noRegression, observeVideo,
  projectEncodingMetrics, videoOutbound, type Observation } from "./browser-encoding-stats";
import type { BrowserEncodingOutputSample, BrowserEncodingWorkerEvent,
  BrowserEncodingWorkerMessage, BrowserEncodingWorkerOptions } from "./browser-encoding-worker";
import { cloneSenderVideoTrack, videoQualitySettingsEqual, type QualityProfile } from "./quality";

export interface BrowserPooledSender {
  updateProfile(profile: QualityProfile): Promise<void>;
  setPaused(paused: boolean): void;
  metrics(transport: ConnectionMetrics): ConnectionMetrics;
  dispose(): void;
}

type Output = BrowserEncodingOutputSample & { timestamp: number };
type Group = {
  producer: BrowserEncodingProducer; source: MediaStreamTrack; profile: QualityProfile;
  codecKey: string; budget: number; ready: boolean; failed: boolean;
  report?: RTCStatsReport; previous?: RTCOutboundRtpStreamStats; output?: Observation;
  keyRequest?: Promise<void>; updating?: Promise<void>;
};
type Member = {
  id: string; source: MediaStreamTrack; sender: RTCRtpSender; connection: RTCPeerConnection;
  profile: QualityProfile; transform: RTCRtpScriptTransform;
  replaceTrack: (track: MediaStreamTrack) => Promise<boolean>;
  requestKey: () => Promise<void>; onFatal: () => void;
  paused: boolean; disabled: boolean; disposed: boolean; mixed: boolean; outputFailed: boolean;
  codec?: RTCRtpCodec; codecKey?: string; budget?: number; raw?: RTCOutboundRtpStreamStats;
  encoderStats: ReturnType<typeof createStatsAccumulator>;
  current?: Group; pending?: { group: Group; requestId?: string };
  output?: Output; previousOutput?: Output; keyRequest?: Promise<void>; replacement?: Promise<void>;
  carrier?: { context: CanvasRenderingContext2D; track: CanvasCaptureMediaStreamTrack; frame: number };
};

// M152 exposes BWE through getStats, not a bandwidth callback. The paired
// weak-entry probe bounds observation lag at this cadence; it is not a retry.
const BUDGET_SAMPLE_MS = 500;

/** One owner per captured source tree; connections retain their own RTP and transport. */
export class BrowserEncodingPool {
  private readonly members = new Set<Member>();
  private readonly groups = new Set<Group>();
  private readonly failedSources = new WeakSet<MediaStreamTrack>();
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private disposed = false;
  private sampleRequest: { id: string; timestamp: number } | undefined;

  create(source: MediaStreamTrack, sender: RTCRtpSender, connection: RTCPeerConnection,
    profile: QualityProfile, replaceTrack: Member["replaceTrack"], requestKey: Member["requestKey"],
    onFatal: () => void): BrowserPooledSender | null {
    if (this.disposed || this.failedSources.has(source) || source.kind !== "video" || source.readyState !== "live" ||
      sender.transform || typeof RTCRtpScriptTransform === "undefined" || typeof Worker === "undefined" ||
      typeof HTMLCanvasElement === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
    let member: Member | undefined;
    try {
      const id = createOpaqueId();
      const transform = new RTCRtpScriptTransform(this.ensureWorker(),
        { kind: "carrier", id, passthrough: true } satisfies BrowserEncodingWorkerOptions);
      member = { id, source, sender, connection, profile: { ...profile }, transform, replaceTrack, requestKey, onFatal,
        paused: !source.enabled, disabled: false, disposed: false, mixed: false, outputFailed: false,
        encoderStats: createStatsAccumulator() };
      sender.transform = transform;
      this.members.add(member);
      if (member.paused) this.post({ type: "pause", carrierId: id, paused: true });
      const owned = member;
      if (!this.timer) this.timer = setInterval(() => void this.poll(), BUDGET_SAMPLE_MS);
      return {
        updateProfile: async (next) => {
          if (owned.disposed || videoQualitySettingsEqual(owned.profile, next)) return;
          owned.profile = { ...next };
          owned.encoderStats = createStatsAccumulator(); owned.previousOutput = undefined;
          // HostPeer awaits this inside its sender queue. Handoffs run outside it.
        },
        setPaused: (paused) => {
          if (owned.disposed || owned.paused === paused) return;
          owned.paused = paused;
          owned.previousOutput = undefined;
          this.post({ type: "pause", carrierId: owned.id, paused });
          this.updatePauses();
        },
        metrics: (transport) => this.metrics(owned, transport),
        dispose: () => this.remove(owned),
      };
    } catch {
      if (member) this.remove(member);
      this.failedSources.add(source);
      this.prune();
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const member of [...this.members]) this.remove(member);
    this.prune();
  }

  private post(message: BrowserEncodingWorkerMessage): void { this.worker?.postMessage(message); }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL("./browser-encoding-worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<BrowserEncodingWorkerEvent>) => {
        if (this.worker === worker) this.onMessage(event.data);
      };
      worker.onerror = () => { if (this.worker === worker) this.failWorker(); };
    }
    return this.worker;
  }

  private compatible(member: Member, group: Group): boolean {
    return member.source === group.source && member.codecKey === group.codecKey &&
      videoQualitySettingsEqual(member.profile, group.profile) && !group.failed;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      await Promise.allSettled([
        ...[...this.members].map(async (member) => {
          if (member.disposed || member.disabled || member.connection.connectionState !== "connected") { member.budget = undefined; return; }
          const report = await member.connection.getStats().catch(() => null);
          if (member.disposed) return;
          if (!report) { member.budget = undefined; return; }
          const codec = negotiatedCodec(report);
          if (!codec) {
            if (member.current || member.pending) this.failSource(member.source);
            else {
              const outbound = videoOutbound(report);
              if (outbound?.codecId && report.get(outbound.codecId)) this.failSource(member.source);
            }
            return;
          }
          const key = codecIdentity(codec);
          if (member.codecKey && member.codecKey !== key && (member.current || member.pending)) {
            this.failSource(member.source); return;
          }
          member.codec = codec; member.codecKey = key;
          member.raw = videoOutbound(report);
          member.budget = nativeVideoBudget(member.raw, member.profile.maxBitrate);
        }),
        ...[...this.groups].map(async (group) => {
          if (!group.ready || group.failed) { group.output = undefined; return; }
          const report = await group.producer.report().catch(() => null);
          if (!this.groups.has(group)) return;
          if (!report) { group.output = undefined; return; }
          group.report = report;
          const video = videoOutbound(report);
          group.output = observeVideo(video, group.previous);
          group.previous = video;
        }),
      ]);
      if (this.disposed) return;
      this.reconcile();
      const id = createOpaqueId();
      this.sampleRequest = { id, timestamp: performance.now() };
      this.post({ type: "sample", requestId: id });
    } finally { this.polling = false; }
  }

  private reconcile(): void {
    const changing = new Set<Group>();
    for (const group of this.groups) {
      const references = [...this.members].filter((member) => member.current === group || member.pending?.group === group);
      const profile = references[0]?.profile;
      if (!profile || group.failed || videoQualitySettingsEqual(profile, group.profile) ||
        !references.every((member) => member.source === group.source && member.codecKey === group.codecKey &&
          videoQualitySettingsEqual(member.profile, profile))) continue;
      changing.add(group);
      if (!group.ready || group.updating) continue;
      for (const member of references) if (member.current === group && member.pending && !member.pending.requestId) member.pending = undefined;
      const next = { ...profile };
      const budget = Math.min(next.maxBitrate, Math.max(...references.map((member) => member.budget ?? group.budget)));
      group.budget = budget;
      group.updating = group.producer.update(next, budget).then(() => {
        if (!this.groups.has(group)) return;
        group.profile = next;
        for (const member of this.members) if (member.current === group || member.pending?.group === group) {
          member.encoderStats = createStatsAccumulator(); member.previousOutput = undefined;
        }
      }).catch(() => {
        if (this.groups.has(group)) this.failSource(group.source);
      }).finally(() => { group.updating = undefined; });
    }
    for (const member of this.members) {
      if (member.disposed || member.disabled || member.paused || member.replacement || !member.codec || member.budget === undefined) continue;
      if ([member.current, member.pending?.group].some((group) => group && (group.updating || changing.has(group)))) continue;
      if (member.pending) {
        const pending = member.pending;
        if (!pending.requestId && member.current && this.compatible(member, member.current) &&
          fits(member.current.output, member.budget) && pending.group.budget < member.current.budget) {
          member.pending = undefined;
          continue;
        }
        if (!pending.requestId && !this.compatible(member, pending.group)) {
          member.pending = undefined;
          continue;
        }
        const ownedBudget = pending.group.budget <= member.budget;
        // The worker already waits for a real recovery frame. A rate-owned
        // downgrade need not wait another statistics window while the old
        // high-rate output keeps congesting the same path.
        if (!pending.requestId && pending.group.ready &&
          (fits(pending.group.output, member.budget) || (member.current && ownedBudget))) {
          const output = pending.group.output;
          if (member.current || (output && noRegression(output, member.raw?.frameWidth ?? null,
            member.raw?.frameHeight ?? null, member.raw?.framesPerSecond ?? null, member.profile))) {
            pending.requestId = createOpaqueId();
            member.mixed = true;
            this.post({ type: "select", carrierId: member.id, producerId: pending.group.producer.id, requestId: pending.requestId });
          }
        }
        continue;
      }
      const current = member.current;
      if (current && this.compatible(member, current) &&
        (!current.output || current.output.bitrate === 0 || current.output.fps === 0)) continue;
      if (current && this.compatible(member, current) && fits(current.output, member.budget)) {
        // Reuse an earlier producer only after this member's real encoder recovered.
        for (const group of this.groups) {
          if (group === current) break;
          if (this.compatible(member, group) && fits(group.output, member.budget) && current.output?.reason === "none" &&
            noRegression(group.output!, current.output.width, current.output.height, current.output.fps, member.profile)) {
            member.pending = { group }; break;
          }
        }
        continue;
      }
      // An unshared pipeline already has the right owner: let its native
      // encoder adapt to the updated budget instead of recreating it.
      if (current && this.compatible(member, current) && ![...this.members].some((other) =>
        other !== member && (other.current === current || other.pending?.group === current))) continue;
      const candidates = [...this.groups].filter((group) => this.compatible(member, group));
      let target = candidates.find((group) => group !== current && fits(group.output, member.budget) &&
        (!current || group.budget === member.budget));
      target ??= candidates.find((group) => group !== current && group.budget === member.budget);
      if (!target) {
        target = this.startGroup(member, member.budget);
      }
      member.pending = { group: target };
    }
    for (const group of this.groups) {
      const references = [...this.members].filter((member) => member.current === group || member.pending?.group === group);
      const budgets = references.flatMap((member) => this.compatible(member, group) && member.budget !== undefined ? [member.budget] : []);
      if (group.ready && budgets.length) {
        const budget = Math.max(...budgets);
        if (budget !== group.budget && !group.updating) {
          group.budget = budget;
          group.updating = group.producer.update(group.profile, budget).catch(() => {
            if (this.groups.has(group)) this.failSource(group.source);
          })
            .finally(() => { group.updating = undefined; });
        }
      }
    }
    this.updatePauses();
    this.prune();
  }

  private startGroup(member: Member, budget: number): Group {
    const profile = { ...member.profile };
    const producer = new BrowserEncodingProducer(member.source, profile, member.codec!, this.worker!,
      () => { group.failed = true; this.failSource(member.source); });
    const group: Group = { producer, source: member.source, profile, codecKey: member.codecKey!, budget, ready: false, failed: false };
    this.groups.add(group);
    void producer.start(budget).then(() => { if (this.groups.has(group)) group.ready = true; }, () => {
      if (this.groups.has(group)) { group.failed = true; this.failSource(group.source); }
    });
    return group;
  }

  private onMessage(event: BrowserEncodingWorkerEvent): void {
    if (this.disposed) return;
    if (event.type === "frame") {
      for (const id of event.carrierIds) {
        const member = [...this.members].find((candidate) => candidate.id === id);
        const carrier = member?.carrier;
        if (!carrier || member.paused) continue;
        carrier.context.fillStyle = "#080808"; carrier.context.fillRect(0, 0, 16, 16);
        carrier.context.fillStyle = "#181818"; carrier.context.fillRect(carrier.frame++ % 16, 0, 1, 1);
        carrier.track.requestFrame();
      }
    } else if (event.type === "key") {
      const owner = [...this.members].find((member) => member.id === event.id) ??
        [...this.groups].find((group) => group.producer.id === event.id);
      if (!owner || owner.keyRequest || "producer" in owner && this.failedSources.has(owner.source)) return;
      const request = "producer" in owner ? () => owner.producer.requestKey() : owner.requestKey;
      owner.keyRequest = request().catch(() => {
        if ("producer" in owner) {
          if (this.groups.has(owner)) this.failSource(owner.source);
        } else if (this.members.has(owner)) {
          if (owner.disabled) owner.onFatal();
          else this.failSource(owner.source);
        }
      }).finally(() => { owner.keyRequest = undefined; });
    } else if (event.type === "selected") {
      const member = [...this.members].find((candidate) => candidate.id === event.carrierId);
      if (!member || member.pending?.requestId !== event.requestId || member.pending.group.producer.id !== event.producerId) return;
      // This key was actually written. A newer profile remains intent for the next handoff.
      member.current = member.pending.group;
      member.pending = undefined;
      member.encoderStats = createStatsAccumulator();
      member.previousOutput = undefined;
      member.mixed = true;
      if (!member.carrier) this.installCarrier(member);
      this.prune();
    } else if (event.type === "sample") {
      if (event.requestId !== this.sampleRequest?.id) return;
      for (const sample of event.outputs) {
        const member = [...this.members].find((candidate) => candidate.id === sample.carrierId);
        if (!member) continue;
        member.output = { ...sample, timestamp: this.sampleRequest.timestamp };
        if (!member.pending && !member.replacement && sample.frames > 0 &&
          sample.lastProducerId === (member.current?.producer.id ?? null)) member.mixed = false;
      }
      this.sampleRequest = undefined;
    } else {
      const group = [...this.groups].find((candidate) => candidate.producer.id === event.id);
      const member = [...this.members].find((candidate) => candidate.id === event.id);
      if (group) group.failed = true;
      if (member) member.outputFailed = true;
      const source = group?.source ?? member?.source;
      if (source) this.failSource(source);
    }
  }

  private installCarrier(member: Member): void {
    if (member.disposed || member.replacement) return;
    try {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas capture unavailable");
      context.fillRect(0, 0, 16, 16);
      const track = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
      if (!track || typeof track.requestFrame !== "function") {
        track?.stop(); throw new Error("Manual canvas capture unavailable");
      }
      track.contentHint = "motion";
      const carrier = { context, track, frame: 0 };
      member.carrier = carrier;
      member.replacement = member.replaceTrack(track).then((replaced) => {
        if (member.disposed) return;
        if (!replaced) {
          track.stop(); member.carrier = undefined; member.disabled = true;
          if (member.outputFailed || member.current?.failed) member.onFatal();
        }
      }, () => { if (!member.disposed) { track.stop(); member.carrier = undefined; this.failSource(member.source); } })
        .finally(() => { member.replacement = undefined; });
    } catch { this.failSource(member.source); }
  }

  private restore(member: Member): void {
    if (member.disposed || member.replacement) return;
    member.mixed = true;
    member.pending = undefined;
    let track: MediaStreamTrack;
    try { track = cloneSenderVideoTrack(member.source); }
    catch { member.onFatal(); return; }
    track.enabled = !member.paused;
    member.replacement = member.replaceTrack(track).then(async (replaced) => {
      if (member.disposed) { if (!replaced) track.stop(); return; }
      if (!replaced) {
        track.stop(); member.disabled = true;
        if (member.outputFailed || member.current?.failed) member.onFatal();
        return;
      }
      if (member.outputFailed) {
        const previousId = member.id;
        const id = createOpaqueId();
        const transform = new RTCRtpScriptTransform(this.ensureWorker(),
          { kind: "carrier", id, passthrough: true } satisfies BrowserEncodingWorkerOptions);
        member.sender.transform = transform;
        member.id = id; member.transform = transform; member.outputFailed = false;
        this.post({ type: "remove", id: previousId });
        if (member.paused) this.post({ type: "pause", carrierId: id, paused: true });
      } else {
        this.post({ type: "passthrough", carrierId: member.id });
      }
      member.carrier?.track.stop(); member.carrier = undefined;
      member.current = undefined;
      member.encoderStats = createStatsAccumulator(); member.previousOutput = undefined;
      // M152 detach does not short-circuit its transform. Keep own-frame passthrough
      // until the sender owner retires, and begin the real source on a fresh key.
      await member.requestKey();
    }).catch(() => {
      track.stop();
      if (!member.disposed) member.onFatal();
    }).finally(() => { member.replacement = undefined; this.prune(); });
  }

  private failSource(source: MediaStreamTrack): void {
    if (this.failedSources.has(source)) {
      for (const member of this.members) if (member.source === source && !member.replacement &&
        (member.outputFailed || member.current?.failed)) member.onFatal();
      return;
    }
    this.failedSources.add(source);
    for (const member of this.members) if (member.source === source) {
      member.disabled = true;
      if (member.replacement) void member.replacement.then(() => this.restore(member));
      else this.restore(member);
    }
  }

  private failWorker(): void {
    if (this.disposed) return;
    const wasPooling = [...this.members].some((member) => !member.disabled);
    this.worker?.terminate(); this.worker = null;
    this.sampleRequest = undefined;
    for (const group of this.groups) group.failed = true;
    for (const member of [...this.members]) {
      member.outputFailed = true;
      this.failedSources.add(member.source);
      member.disabled = true;
      if (!wasPooling) member.onFatal();
      else if (member.replacement) void member.replacement.then(() => this.restore(member));
      else this.restore(member);
    }
    this.prune();
  }

  private updatePauses(): void {
    for (const group of this.groups) group.producer.setPaused(![...this.members].some((member) =>
      !member.paused && (member.current === group || member.pending?.group === group)));
  }

  private metrics(member: Member, transport: ConnectionMetrics): ConnectionMetrics {
    if (member.disposed || (!member.current && !member.mixed)) return transport;
    const group = member.current, input = group?.producer.track, sample = member.output, previous = member.previousOutput;
    member.previousOutput = sample;
    const measured = !member.mixed && !member.paused && input && group?.report && !group.failed && sample?.lastProducerId === group.producer.id &&
      previous?.lastProducerId === group.producer.id && sample.timestamp > previous.timestamp;
    const encoder = measured ? { ...collectConnectionMetricsFromReport(group.report!, "send", member.encoderStats),
      ...captureMetrics(input) } : EMPTY_METRICS;
    const qualityEligible = !!measured && !member.pending && !group.updating && this.compatible(member, group) &&
      (encoder.nativeEdgeQualityState === "degraded" || fits(group.output, member.budget));
    return projectEncodingMetrics(transport, encoder, measured ? sample : undefined, measured ? previous : undefined, qualityEligible);
  }

  private remove(member: Member): void {
    if (member.disposed) return;
    member.disposed = true;
    this.members.delete(member);
    if (member.sender.transform === member.transform) member.sender.transform = null;
    this.post({ type: "remove", id: member.id });
    member.carrier?.track.stop(); member.carrier = undefined;
    member.current = undefined; member.pending = undefined;
    this.prune();
  }

  private prune(): void {
    for (const group of this.groups) if (![...this.members].some((member) => member.current === group || member.pending?.group === group)) {
      this.groups.delete(group); group.producer.dispose();
    }
    if (!this.members.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.worker?.terminate(); this.worker = null;
      this.sampleRequest = undefined;
    }
  }
}
