import { createOpaqueId } from "../lib/opaque-id";
import { debugError, debugEvent } from "../lib/debug";
import { debugRtcFailure, debugRtcStats, debugTrack, observeDebugConnection } from "../lib/debug-webrtc";
import { maxEncodedVideoFrames } from "../webrtc/stats";
import { addRemoteIceCandidate } from "../webrtc/nat-prediction";
import { encodedStreams } from "./browser-encoding-output";
import {
  applyVideoCaptureProfile, cloneSenderVideoTrack, configureVideoSender,
  needsStartupVideoProfile, startupVideoProfile, STARTUP_VIDEO_ENCODED_FRAMES,
  videoQualitySettingsEqual, type QualityProfile,
} from "./quality";

// Leave time for ordinary encoding before the outer Viewer/route deadline.
// Bound local transport setup, not frame production from a quiet source.
const LOCAL_CONNECTION_TIMEOUT_MS = 8_000;

export class BrowserEncodingProducer {
  readonly id = createOpaqueId();
  private send: RTCPeerConnection | null = null;
  private receive: RTCPeerConnection | null = null;
  private input: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly streamAbort = new AbortController();
  private streamWriter: WritableStreamDefaultWriter<RTCEncodedVideoFrame> | null = null;
  private parameterTail = Promise.resolve();
  private disposed = false;
  private paused: boolean;
  private budget: number;
  private startupPending: boolean;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private applied: { capture: QualityProfile; sender: QualityProfile } | null = null;

  constructor(
    readonly source: MediaStreamTrack,
    private desiredProfile: QualityProfile,
    private readonly codec: RTCRtpCodec,
    private readonly onFrame: (frame: RTCEncodedVideoFrame) => void,
    private readonly onFailure: () => void,
  ) {
    this.desiredProfile = { ...desiredProfile };
    this.budget = desiredProfile.maxBitrate;
    this.startupPending = needsStartupVideoProfile(desiredProfile);
    this.paused = !source.enabled;
  }

  get track(): MediaStreamTrack | null { return this.input; }
  get sender(): RTCRtpSender | null { return this.videoSender; }

  async start(initialBudget = this.desiredProfile.maxBitrate): Promise<void> {
    this.checkAlive();
    if (this.send) throw new Error("Browser encoding producer already started");
    this.budget = initialBudget;
    try {
      if (this.source.readyState !== "live") throw new Error("Browser encoding source ended");
      const track = this.input = cloneSenderVideoTrack(this.source);
      track.enabled = !this.paused;
      this.source.addEventListener("ended", this.fail);
      track.addEventListener("ended", this.fail);
      const send = this.send = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true } as RTCConfiguration);
      const receive = this.receive = new RTCPeerConnection({ iceServers: [] });
      observeDebugConnection(send, { producerId: this.id, role: "pool-producer" });
      observeDebugConnection(receive, { producerId: this.id, role: "pool-local-receiver" });
      const transceiver = send.addTransceiver(track, { direction: "sendonly", streams: [new MediaStream([track])] });
      this.videoSender = transceiver.sender;
      const streams = encodedStreams(transceiver.sender), writer = streams.writable.getWriter();
      this.streamWriter = writer;
      void streams.readable.pipeTo(new WritableStream({ write: async (frame) => {
        if (this.disposed) return;
        // Outputs clone synchronously before the local decoder consumes the original.
        this.onFrame(frame);
        await writer.write(frame);
      } }), { signal: this.streamAbort.signal }).then(this.fail, this.fail).finally(() => {
        try { writer.releaseLock(); } catch { /* Owner abort retired the writer. */ }
      });
      transceiver.setCodecPreferences([this.codec]);
      const video = this.video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      receive.ontrack = ({ track: received }) => {
        if (this.disposed) return;
        video.srcObject = new MediaStream([received]);
        void video.play().catch(this.fail);
      };
      for (const connection of [send, receive]) {
        connection.onconnectionstatechange = () => {
          if (connection.connectionState === "failed") this.fail();
          else if (send.connectionState === "connected" && receive.connectionState === "connected") {
            this.clearStartupTimer();
          }
        };
      }
      const forward = (from: RTCPeerConnection, to: RTCPeerConnection) => {
        const pending: RTCIceCandidate[] = [];
        from.onicecandidate = ({ candidate }) => {
          if (!candidate || this.disposed) return;
          if (!to.remoteDescription) pending.push(candidate);
          else void addRemoteIceCandidate(to, candidate).catch(this.fail);
        };
        return async () => {
          for (const candidate of pending.splice(0)) {
            this.checkAlive();
            await addRemoteIceCandidate(to, candidate);
          }
        };
      };
      const flushReceive = forward(send, receive), flushSend = forward(receive, send);
      this.startupTimer = setTimeout(() => {
        this.fail(new DOMException("Local encoding connection timed out", "TimeoutError"));
      }, LOCAL_CONNECTION_TIMEOUT_MS);
      await this.serialize(() => this.applyCurrent());
      await send.setLocalDescription(await send.createOffer());
      this.checkAlive();
      await receive.setRemoteDescription(send.localDescription!);
      await flushReceive();
      this.checkAlive();
      await receive.setLocalDescription(await receive.createAnswer());
      this.checkAlive();
      await send.setRemoteDescription(receive.localDescription!);
      await flushSend();
      this.checkAlive();
    } catch (error) {
      const retired = this.disposed;
      this.dispose();
      if (retired) this.checkAlive();
      throw error;
    }
  }

  update(profile: QualityProfile, budget: number): Promise<void> {
    this.desiredProfile = { ...profile };
    this.budget = budget;
    if (!needsStartupVideoProfile(profile)) this.startupPending = false;
    return this.serialize(() => this.applyCurrent());
  }

  requestKey(): Promise<void> {
    return this.serialize(async () => {
      const sender = this.requireSender();
      // Chromium's supported keyframe option is not yet in TypeScript's DOM declarations.
      const request = sender.setParameters as (parameters: RTCRtpSendParameters,
        options: { encodingOptions: Array<{ keyFrame: boolean }> }) => Promise<void>;
      await request.call(sender, sender.getParameters(), { encodingOptions: [{ keyFrame: true }] });
    });
  }

  async report(): Promise<RTCStatsReport> {
    this.requireSender();
    const connection = this.send!;
    const report = await connection.getStats().catch((error) => { debugRtcFailure(connection, error); throw error; });
    debugRtcStats(connection, report);
    if (!this.disposed && this.startupPending &&
      (maxEncodedVideoFrames(report, this.input!.id) ?? 0) >= STARTUP_VIDEO_ENCODED_FRAMES) {
      this.startupPending = false;
      void this.serialize(() => this.applyCurrent()).catch(this.fail);
    }
    return report;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.input) this.input.enabled = !paused;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStartupTimer();
    debugEvent("encoding-pool", "producer-retired", { producerId: this.id });
    this.source.removeEventListener("ended", this.fail);
    this.input?.removeEventListener("ended", this.fail);
    this.input?.stop();
    this.streamAbort.abort();
    void this.streamWriter?.abort().catch(() => undefined);
    this.streamWriter = null;
    for (const connection of [this.send, this.receive]) {
      if (!connection) continue;
      connection.onicecandidate = connection.onconnectionstatechange = connection.ontrack = null;
      connection.close();
    }
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.input = this.videoSender = this.video = this.send = this.receive = null;
  }

  private readonly fail = (error?: unknown): void => {
    if (this.disposed) return;
    debugError("encoding-pool", "producer-failed", error, { producerId: this.id });
    this.dispose();
    this.onFailure();
  };

  private clearStartupTimer(): void {
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private checkAlive(): void {
    if (this.disposed) throw new DOMException("Browser encoding producer was retired", "AbortError");
  }

  private requireSender(): RTCRtpSender {
    this.checkAlive();
    if (!this.videoSender) throw new Error("Browser encoding producer has not started");
    return this.videoSender;
  }

  private async applyCurrent(): Promise<void> {
    const sender = this.requireSender(), track = this.input!;
    const profile = this.desiredProfile;
    const previous = this.applied;
    const effective = this.startupPending ? startupVideoProfile(profile) : profile;
    const parameters = { ...effective, maxBitrate: Math.min(profile.maxBitrate, this.budget) };
    const captureChanged = !previous || !videoQualitySettingsEqual(previous.capture, profile);
    const senderChanged = !previous || !videoQualitySettingsEqual(previous.sender, parameters);
    if (!captureChanged && !senderChanged) return;
    try {
      if (captureChanged) await applyVideoCaptureProfile(track, profile);
      this.checkAlive();
      if (senderChanged) await configureVideoSender(sender, parameters);
      this.checkAlive();
      this.applied = { capture: profile, sender: parameters };
      debugEvent("encoding-pool", "producer-configured", { producerId: this.id, profile, parameters });
      if (captureChanged) debugTrack(track, { producerId: this.id });
    } catch (error) {
      debugError("encoding-pool", "producer-settings-failed", error, { producerId: this.id, requested: profile, parameters });
      if (captureChanged && previous && !this.disposed) {
        await applyVideoCaptureProfile(track, previous.capture).catch(this.fail);
      }
      throw error;
    }
  }

  private serialize(operation: () => Promise<unknown>): Promise<void> {
    return this.parameterTail = this.parameterTail.catch(() => undefined).then(async () => {
      this.checkAlive();
      await operation();
      this.checkAlive();
    });
  }
}
