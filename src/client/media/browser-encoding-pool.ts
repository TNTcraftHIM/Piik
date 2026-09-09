import { createOpaqueId } from "../lib/opaque-id";
import { browserDebugEnabled, debugError, debugEvent } from "../lib/debug";
import { EMPTY_METRICS, type ConnectionMetrics } from "../types";
import { captureMetrics, collectConnectionMetricsFromReport, createStatsAccumulator } from "../webrtc/stats";
import { BrowserEncodingProducer } from "./browser-encoding-producer";
import { BROWSER_CARRIER_SIZE, type BrowserEncodingOutput } from "./browser-encoding-output";
import { codecIdentity, fits, nativeVideoBudget, negotiatedCodec, noRegression, observeVideo,
  projectEncodingMetrics, videoOutbound, type Observation } from "./browser-encoding-stats";
import { QUALITY_RESOLUTIONS, videoQualitySettingsEqual, type QualityProfile } from "./quality";

export interface BrowserPooledSender {
  updateProfile(profile: QualityProfile): Promise<void>;
  carrierScale(): number | undefined;
  setPaused(paused: boolean): void;
  metrics(transport: ConnectionMetrics): ConnectionMetrics;
  dispose(): void;
}

type Output = ReturnType<BrowserEncodingOutput["snapshot"]>;
type Group = {
  producer: BrowserEncodingProducer; source: MediaStreamTrack; profile: QualityProfile;
  codecKey: string; budget: number; ready: boolean; failed: boolean;
  report?: RTCStatsReport; previous?: RTCOutboundRtpStreamStats; output?: Observation;
  updating?: Promise<void>;
};
type Member = {
  id: string; source: MediaStreamTrack; sender: RTCRtpSender; connection: RTCPeerConnection;
  profile: QualityProfile; encoded: BrowserEncodingOutput;
  configureCarrier: () => Promise<boolean>;
  requestKey: () => Promise<void>; onFatal: () => void;
  paused: boolean; disabled: boolean; disposed: boolean; mixed: boolean; carrier: boolean;
  codec?: RTCRtpCodec; codecKey?: string; budget?: number; raw?: RTCOutboundRtpStreamStats;
  encoderStats: ReturnType<typeof createStatsAccumulator>;
  current?: Group; pending?: { group: Group; selecting?: boolean };
  output?: Output; previousOutput?: Output; replacement?: Promise<void>;
};

// M152 exposes BWE through getStats, not a bandwidth callback. The paired
// weak-entry probe bounds observation lag at this cadence; it is not a retry.
const BUDGET_SAMPLE_MS = 500;

/** One owner per captured source tree; connections retain their own RTP and transport. */
export class BrowserEncodingPool {
  private readonly members = new Set<Member>();
  private readonly groups = new Set<Group>();
  private readonly failedSources = new WeakSet<MediaStreamTrack>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private disposed = false;

  create(source: MediaStreamTrack, sender: RTCRtpSender, connection: RTCPeerConnection,
    profile: QualityProfile, encoded: BrowserEncodingOutput, configureCarrier: Member["configureCarrier"], requestKey: Member["requestKey"],
    onFatal: () => void): BrowserPooledSender | null {
    if (this.disposed || this.failedSources.has(source) || source.kind !== "video" || source.readyState !== "live") return null;
    const member: Member = { id: createOpaqueId(), source, sender, connection, profile: { ...profile }, encoded, configureCarrier, requestKey, onFatal,
      paused: !source.enabled, disabled: false, disposed: false, mixed: false, carrier: encoded.snapshot().frames === 0,
      encoderStats: createStatsAccumulator() };
    this.members.add(member);
    // A fresh connection has no useful raw output to preserve. Start its
    // tiny clock immediately, rather than warming two full encoders first.
    if (!member.carrier) encoded.passthrough(requestKey);
    encoded.setPaused(member.paused);
    if (!this.timer) this.timer = setInterval(() => void this.poll(), BUDGET_SAMPLE_MS);
    return {
      carrierScale: () => {
        if (!member.carrier) return;
        const width = member.sender.track?.getSettings().width ?? QUALITY_RESOLUTIONS[member.profile.resolution].width;
        return Math.max(1, width / BROWSER_CARRIER_SIZE);
      },
      updateProfile: async (next) => {
        if (member.disposed || videoQualitySettingsEqual(member.profile, next)) return;
        member.profile = { ...next };
        member.encoderStats = createStatsAccumulator(); member.previousOutput = undefined;
        // HostPeer awaits this inside its sender queue. Handoffs run outside it.
      },
      setPaused: (paused) => {
        if (member.disposed || member.paused === paused) return;
        member.paused = paused;
        member.previousOutput = undefined;
        member.encoded.setPaused(paused);
        this.updatePauses();
      },
      metrics: (transport) => this.metrics(member, transport),
      dispose: () => this.remove(member),
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const member of [...this.members]) this.remove(member);
    this.prune();
  }

  private compatible(member: Member, group: Group): boolean {
    return member.source === group.source && member.codecKey === group.codecKey &&
      videoQualitySettingsEqual(member.profile, group.profile) && !group.failed;
  }

  private references(group: Group): Member[] {
    return [...this.members].filter((member) => member.current === group || member.pending?.group === group);
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
      for (const member of this.members) {
        member.output = member.encoded.snapshot();
        if (!member.pending && !member.replacement && member.output.frames > 0 &&
          member.output.lastProducerId === (member.current?.producer.id ?? null)) member.mixed = false;
      }
      if (browserDebugEnabled) debugEvent("encoding-pool", "sample", {
        members: [...this.members].map((member) => ({ memberId: member.id, trackId: member.source.id,
          rtpStatsId: member.raw?.id, ssrc: member.raw?.ssrc,
          producerId: member.current?.producer.id, pendingProducerId: member.pending?.group.producer.id,
          budget: member.budget, carrier: member.carrier, paused: member.paused, disabled: member.disabled, output: member.output })),
        groups: [...this.groups].map((group) => ({ producerId: group.producer.id, budget: group.budget,
          ready: group.ready, failed: group.failed, output: group.output })),
      });
    } finally { this.polling = false; }
  }

  private reconcile(): void {
    const changing = new Set<Group>();
    for (const group of this.groups) {
      const references = this.references(group);
      const profile = references[0]?.profile;
      if (!profile || group.failed || videoQualitySettingsEqual(profile, group.profile) ||
        !references.every((member) => member.source === group.source && member.codecKey === group.codecKey &&
          videoQualitySettingsEqual(member.profile, profile))) continue;
      changing.add(group);
      if (!group.ready || group.updating) continue;
      for (const member of references) if (member.current === group && member.pending && !member.pending.selecting) member.pending = undefined;
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
        // A shared producer can outgrow a waiting child's native allocation.
        // Replan that membership; never wait forever for its budget to catch up.
        if (!pending.selecting && pending.group.budget > member.budget &&
          !fits(pending.group.output, member.budget) && this.references(pending.group).some((other) => other !== member)) {
          member.pending = undefined;
          continue;
        }
        if (!pending.selecting && member.current && this.compatible(member, member.current) &&
          fits(member.current.output, member.budget) && pending.group.budget < member.current.budget) {
          member.pending = undefined;
          continue;
        }
        if (!pending.selecting && !this.compatible(member, pending.group)) {
          member.pending = undefined;
          continue;
        }
        const ownedBudget = pending.group.budget <= member.budget;
        // The output already waits for a real recovery frame. A rate-owned
        // downgrade need not wait another statistics window while the old
        // high-rate output keeps congesting the same path.
        if (!pending.selecting && pending.group.ready &&
          (fits(pending.group.output, member.budget) || ((member.current || member.carrier) && ownedBudget))) {
          const output = pending.group.output;
          // A fresh carrier has delivered no picture. Its tiny encode cannot
          // establish a quality baseline for the first real output.
          if (member.current || member.carrier || (output && noRegression(output, member.raw?.frameWidth ?? null,
            member.raw?.frameHeight ?? null, member.raw?.framesPerSecond ?? null, member.profile))) {
            pending.selecting = true;
            member.mixed = true;
            member.encoded.select(pending.group.producer.id, () => pending.group.producer.requestKey(), () => {
              if (member.disposed || member.pending !== pending) return;
              member.current = pending.group;
              member.pending = undefined;
              member.encoderStats = createStatsAccumulator(); member.previousOutput = undefined;
              member.carrier = true;
              member.replacement = member.configureCarrier().then((applied) => {
                if (!member.disposed && !applied) this.failSource(member.source);
              }).catch(() => this.failSource(member.source)).finally(() => { member.replacement = undefined; });
              this.prune();
            });
          }
        }
        continue;
      }
      const current = member.current;
      if (current && this.compatible(member, current) &&
        (!current.output || current.output.bitrate === 0 || current.output.fps === 0)) continue;
      if (current?.output && this.compatible(member, current) && fits(current.output, member.budget)) {
        // Equal outputs converge to the earlier owner. A strictly better healthy
        // output is also reusable when this encoder has not recovered itself.
        let earlier = true;
        for (const group of this.groups) {
          if (group === current) { earlier = false; continue; }
          const improves = group.output && current.output && (group.output.width > current.output.width ||
            group.output.height > current.output.height || Math.round(group.output.fps) > Math.round(current.output.fps));
          if ((earlier || improves) && this.compatible(member, group) && fits(group.output, member.budget) && group.output?.reason === "none" &&
            noRegression(group.output!, current.output.width, current.output.height, current.output.fps, member.profile)) {
            member.pending = { group }; break;
          }
        }
        continue;
      }
      // An unshared pipeline already has the right owner: let its native
      // encoder adapt to the updated budget instead of recreating it.
      if (current && this.compatible(member, current) && !this.references(current).some((other) => other !== member)) continue;
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
      const references = this.references(group);
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
    const producer = new BrowserEncodingProducer(member.source, profile, member.codec!, (frame) => {
      for (const output of this.members) if (output.current === group || output.pending?.group === group) {
        output.encoded.push(producer.id, frame);
      }
    },
      () => { group.failed = true; this.failSource(member.source); });
    const group: Group = { producer, source: member.source, profile, codecKey: member.codecKey!, budget, ready: false, failed: false };
    this.groups.add(group);
    debugEvent("encoding-pool", "producer-preparing", { producerId: producer.id, trackId: member.source.id, codec: member.codecKey, budget, profile });
    void producer.start(budget).then(() => { if (this.groups.has(group)) group.ready = true; }, (error) => {
      debugError("encoding-pool", "producer-start-failed", error, { producerId: producer.id });
      if (this.groups.has(group)) { group.failed = true; this.failSource(group.source); }
    });
    return group;
  }

  private restore(member: Member): void {
    if (member.disposed) return;
    member.mixed = true;
    member.pending = undefined;
    member.carrier = false;
    member.replacement = member.configureCarrier().then((applied) => {
      if (member.disposed) return;
      if (!applied) { member.onFatal(); return; }
      member.encoded.passthrough(member.requestKey);
      member.current = undefined;
      member.encoderStats = createStatsAccumulator(); member.previousOutput = undefined;
    }).catch(() => { if (!member.disposed) member.onFatal(); })
      .finally(() => { member.replacement = undefined; this.prune(); });
  }

  private failSource(source: MediaStreamTrack): void {
    if (this.failedSources.has(source)) return;
    this.failedSources.add(source);
    for (const member of this.members) if (member.source === source) {
      member.disabled = true;
      if (member.replacement) void member.replacement.then(() => this.restore(member));
      else this.restore(member);
    }
  }

  private updatePauses(): void {
    for (const group of this.groups) group.producer.setPaused(!this.references(group).some((member) => !member.paused));
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
    member.encoded.passthrough(member.requestKey);
    member.carrier = false;
    member.current = undefined; member.pending = undefined;
    this.prune();
  }

  private prune(): void {
    for (const group of this.groups) if (!this.references(group).length) {
      this.groups.delete(group); group.producer.dispose();
    }
    if (!this.members.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
