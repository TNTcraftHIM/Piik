import type { SfuSignalMessage } from "../../shared/protocol";
import type { ConnectionMetrics } from "../types";
import { debugRtcFailure, debugRtcStats } from "../lib/debug-webrtc";
import {
  collectConnectionMetricsFromReport,
  createStatsAccumulator,
  decodedVideoFrames,
} from "../webrtc/stats";
import { preferScreenAudioStereo } from "../webrtc/screen-audio-sdp";
import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { SfuPeer, type SfuConnectionConfig } from "./peer";

interface SubscriberEvents {
  send: (message: SfuSignalMessage) => boolean;
  onStream: (stream: MediaStream | null) => void;
  onVideoAvailability?: (available: boolean) => void;
  onStats?: (metrics: ConnectionMetrics) => void;
  onDecodedFrameSample?: (framesDecodedDelta: number | null) => void;
  onFirstDecodedFrame?: () => boolean;
  onState?: (state: "connected" | "reconnecting") => void;
  onDisconnected?: () => void;
}

interface SubscribedTrack {
  track: MediaStreamTrack;
  receiver: RTCRtpReceiver;
  onEnded: () => void;
}

export class SfuSubscriber {
  private peer: SfuPeer | null = null;
  private video: SubscribedTrack | null = null;
  private audio: SubscribedTrack | null = null;
  private readonly stream = new MediaStream();
  private active = false;
  private closed = false;
  private restartPending = false;
  private streamEmitted = false;
  private stats = createStatsAccumulator();
  private statsInFlight: typeof this.stats | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private proofMode: "fresh" | "progress" | null = null;
  private stopProof: (() => void) | null = null;

  constructor(private readonly events: SubscriberEvents) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.peer || this.closed)
      throw new Error("SFU subscriber cannot be connected twice");
    this.peer = new SfuPeer(config, {
      send: this.events.send,
      onTrack: (event) => this.addTrack(event),
      onState: (state) => {
        if (state === "failed") this.fail();
        else if (state === "connected") {
          this.restartPending = false;
          this.events.onState?.("connected");
          this.startProof();
        } else if (state === "disconnected") this.reconnect();
      },
    });
    return true;
  }

  updateConfig(config: SfuConnectionConfig): void {
    this.peer?.updateConfig(config);
  }

  async acceptSignal(message: SfuSignalMessage): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    try {
      await peer.acceptSignal(message, async (description) => {
        if (description.type !== "offer")
          throw new Error("SFU subscriber expected an offer");
        await peer.pc.setRemoteDescription(description);
        if (this.peer !== peer) return;
        await peer.sendDescription(
          preferScreenAudioStereo(await peer.pc.createAnswer()),
        );
        this.restartPending = false;
      });
    } catch {
      if (this.peer === peer) this.fail();
    }
  }

  activate(): boolean {
    if (!this.peer || this.closed) return false;
    if (this.active) return true;
    this.active = true;
    this.statsTimer = setInterval(() => void this.updateStats(), 2_000);
    this.emitStream();
    this.startProof();
    return true;
  }

  deactivate(): boolean {
    void this.disconnect();
    return true;
  }

  reconnect(): boolean {
    if (
      !this.active ||
      this.restartPending ||
      !this.peer?.send({ kind: "subscribe" })
    )
      return false;
    this.restartPending = true;
    this.events.onState?.("reconnecting");
    return true;
  }

  armDecodedFrameProof(requireProgress = false): void {
    this.proofMode = requireProgress ? "progress" : "fresh";
    this.startProof();
  }

  stopDecodedFrameProof(): void {
    this.proofMode = null;
    this.stopProof?.();
    this.stopProof = null;
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    const peer = this.peer;
    this.peer = null;
    peer?.close();
    this.stopDecodedFrameProof();
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    const hadVideo = this.video !== null;
    this.detach(this.video);
    this.detach(this.audio);
    this.video = null;
    this.audio = null;
    this.stats = createStatsAccumulator();
    if (hadVideo) this.events.onVideoAvailability?.(false);
    if (this.streamEmitted) this.events.onStream(null);
    this.streamEmitted = false;
  }

  private fail(): void {
    if (this.closed) return;
    void this.disconnect();
    this.events.onDisconnected?.();
  }

  private addTrack({ track, receiver }: RTCTrackEvent): void {
    if (track.kind !== "video" && track.kind !== "audio") return;
    const isVideo = track.kind === "video";
    const previous = isVideo ? this.video : this.audio;
    if (previous?.track === track) return;
    this.detach(previous);
    const subscribed: SubscribedTrack = {
      track,
      receiver,
      onEnded: () => {
        if ((isVideo ? this.video : this.audio) !== subscribed) return;
        this.detach(subscribed);
        if (isVideo) {
          this.video = null;
          this.stopProof?.();
          this.stopProof = null;
          this.events.onVideoAvailability?.(false);
        } else this.audio = null;
        this.stats = createStatsAccumulator();
        this.emitStream();
      },
    };
    track.addEventListener("ended", subscribed.onEnded, { once: true });
    this.stream.addTrack(track);
    if (isVideo) this.video = subscribed;
    else this.audio = subscribed;
    this.stats = createStatsAccumulator();
    this.emitStream();
    if (isVideo) {
      this.events.onVideoAvailability?.(true);
      this.startProof();
    }
  }

  private detach(subscribed: SubscribedTrack | null): void {
    if (!subscribed) return;
    subscribed.track.removeEventListener("ended", subscribed.onEnded);
    this.stream.removeTrack(subscribed.track);
  }

  private emitStream(): void {
    if (!this.active || !this.video) return;
    this.streamEmitted = true;
    this.events.onStream(this.stream);
  }

  private startProof(): void {
    this.stopProof?.();
    this.stopProof = null;
    const peer = this.peer;
    const video = this.video;
    const mode = this.proofMode;
    if (!peer || !video || !mode || !this.active) return;
    this.stopProof = observeDecodedFrameProof({
      readFramesDecoded: async () =>
        decodedVideoFrames(await video.receiver.getStats()),
      owns: () =>
        this.peer === peer &&
        this.active &&
        this.video === video &&
        this.proofMode === mode,
      requireProgress: mode === "progress",
      onProof: () => {
        const accepted = this.events.onFirstDecodedFrame?.() ?? true;
        if (accepted) {
          this.proofMode = null;
          this.stopProof = null;
        }
        return accepted;
      },
    });
  }

  private async updateStats(): Promise<void> {
    const peer = this.peer;
    const video = this.video;
    const stats = this.stats;
    if (!peer || !this.active) return;
    if (!video || this.statsInFlight === stats) {
      this.events.onDecodedFrameSample?.(null);
      return;
    }
    this.statsInFlight = stats;
    try {
      const report = await peer.pc.getStats();
      debugRtcStats(peer.pc, report);
      if (this.peer !== peer || this.video !== video || this.stats !== stats)
        return;
      const metrics = collectConnectionMetricsFromReport(
        report,
        "receive",
        stats,
      );
      this.events.onDecodedFrameSample?.(metrics.intervalFramesDecoded);
      this.events.onStats?.(metrics);
    } catch (error) {
      debugRtcFailure(peer.pc, error);
      if (this.peer === peer && this.stats === stats)
        this.events.onDecodedFrameSample?.(null);
    } finally {
      if (this.statsInFlight === stats) this.statsInFlight = null;
    }
  }
}
