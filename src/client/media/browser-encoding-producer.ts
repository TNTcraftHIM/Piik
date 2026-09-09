import { createOpaqueId } from "../lib/opaque-id";
import { maxEncodedVideoFrames } from "../webrtc/stats";
import type { BrowserEncodingWorkerMessage, BrowserEncodingWorkerOptions } from "./browser-encoding-worker";
import {
  applyVideoCaptureProfile, cloneSenderVideoTrack, configureVideoSender,
  needsStartupVideoProfile, startupVideoProfile, STARTUP_VIDEO_ENCODED_FRAMES,
  videoQualitySettingsEqual, type QualityProfile,
} from "./quality";

export class BrowserEncodingProducer {
  readonly id = createOpaqueId();
  private send: RTCPeerConnection | null = null;
  private receive: RTCPeerConnection | null = null;
  private input: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private video: HTMLVideoElement | null = null;
  private parameterTail = Promise.resolve();
  private disposed = false;
  private paused: boolean;
  private budget: number;
  private startupPending: boolean;
  private applied: { capture: QualityProfile; sender: QualityProfile } | null = null;

  constructor(
    readonly source: MediaStreamTrack,
    private desiredProfile: QualityProfile,
    private readonly codec: RTCRtpCodec,
    private readonly worker: Worker,
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
      const send = this.send = new RTCPeerConnection({ iceServers: [] });
      const receive = this.receive = new RTCPeerConnection({ iceServers: [] });
      const transceiver = send.addTransceiver(track, { direction: "sendonly", streams: [new MediaStream([track])] });
      this.videoSender = transceiver.sender;
      transceiver.sender.transform = new RTCRtpScriptTransform(this.worker,
        { kind: "producer", id: this.id } satisfies BrowserEncodingWorkerOptions);
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
        };
      }
      const forward = (from: RTCPeerConnection, to: RTCPeerConnection) => {
        const pending: RTCIceCandidate[] = [];
        from.onicecandidate = ({ candidate }) => {
          if (!candidate || this.disposed) return;
          if (!to.remoteDescription) pending.push(candidate);
          else void to.addIceCandidate(candidate).catch(this.fail);
        };
        return async () => {
          for (const candidate of pending.splice(0)) {
            this.checkAlive();
            await to.addIceCandidate(candidate);
          }
        };
      };
      const flushReceive = forward(send, receive), flushSend = forward(receive, send);
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
    const report = await this.send!.getStats();
    if (!this.disposed && this.startupPending &&
      maxEncodedVideoFrames(report, this.input!.id) >= STARTUP_VIDEO_ENCODED_FRAMES) {
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
    this.source.removeEventListener("ended", this.fail);
    this.input?.removeEventListener("ended", this.fail);
    this.input?.stop();
    if (this.videoSender) this.worker.postMessage({ type: "remove", id: this.id } satisfies BrowserEncodingWorkerMessage);
    for (const connection of [this.send, this.receive]) {
      if (!connection) continue;
      connection.onicecandidate = connection.onconnectionstatechange = connection.ontrack = null;
      connection.close();
    }
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.input = this.videoSender = this.video = this.send = this.receive = null;
  }

  private readonly fail = (): void => {
    if (this.disposed) return;
    this.dispose();
    this.onFailure();
  };

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
    } catch (error) {
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
