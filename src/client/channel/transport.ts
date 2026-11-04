import { addRemoteIceCandidate } from "../webrtc/remote-ice-candidate";
import { collectTrackConnectionMetrics, decodedVideoFrameSamples, type StatsAccumulator } from "../webrtc/stats";
import { debugTrack } from "../lib/debug-webrtc";
import type { ConnectionMetrics } from "../types";
import { preferOpusStereoReceive } from "../webrtc/opus-receive-sdp";
import { applyVideoCodecPreference, normalizeVideoOfferSdp, type BrowserVideoCodecPreference } from "../webrtc/video-codec";
import type { ChannelPublication, ChannelSignal } from "./protocol";
import { applyVideoCaptureProfile, configureAudioSender, configureVideoSender, DEFAULT_ROOM_VOICE_BITRATE, screenAudioBitrate, screenShareEncodings, videoQualitySettingsEqual, type VideoSenderProfile } from "../media/quality";
import { BrowserEncodingOutput, supportsBrowserEncoding } from "../media/browser-encoding-output";
import type { BrowserEncodingPool, BrowserPooledSender } from "../media/browser-encoding-pool";
import { cloneSenderVideoTrack, senderCaptureTrack, stopSenderVideoTrack } from "../media/sender-video-track";
import { waitForConnectionOperation } from "../webrtc/connection-operation";

const MAX_FILE_FRAME_BYTES = 8192;
const MAX_CONTROL_FRAME_BYTES = 32768;
const DATA_SEND_BUFFER_BYTES = 65536;
// Application memory queues, matching Native: 32 core ranges × at most 17 frames.
const DATA_SEND_QUEUE_FRAMES = { control: 128, chunk: 32 * 17 };

export interface OutgoingMedia {
  kind: ChannelPublication["kind"];
  stream: MediaStream | null;
  profile?: VideoSenderProfile;
  audioBitrate?: number;
  voiceBitrate?: number;
  paused?: boolean;
  codec?: BrowserVideoCodecPreference;
}

interface SenderBinding {
  sender: RTCRtpSender;
  source: MediaStreamTrack;
  lifetime: AbortController;
  encoded?: BrowserEncodingOutput;
  pooled?: BrowserPooledSender | null;
}

interface OutgoingBinding {
  kind: ChannelPublication["kind"];
  stream: MediaStream;
  senders: SenderBinding[];
  failed: boolean;
  paused: boolean;
  profile?: VideoSenderProfile;
  audioBitrate?: number;
  rejectedTracks?: MediaStreamTrack[];
  replacement?: MediaStreamTrack[];
  metrics?: Map<string, StatsAccumulator>;
}

interface TransportOptions {
  polite: boolean;
  iceServers: RTCIceServer[];
  canReceiveVideoLayers?: boolean;
  videoPool?: BrowserEncodingPool;
  send(payload: ChannelSignal): void;
  receive(flowId: string, stream: MediaStream): void;
  retire?(flowId: string): void;
  outgoingFailed?(flowId: string): void;
  connected(): void;
  base(ready: boolean): void;
  failed(): void;
  data?(kind: "control" | "chunk", data: string | Uint8Array): void;
  dataState?(ready: boolean): void;
  bulkClosed?(): void;
  input?(channel: RTCDataChannel | null): void;
}

/** One physical pair. Flows own stream bindings and senders, never source tracks. */
export class ChannelTransport {
  readonly pc: RTCPeerConnection;
  private sending = new Map<string, OutgoingBinding>();
  private pausedEncodings = new WeakMap<RTCRtpSender, boolean[]>();
  private stableSenders: Map<RTCRtpSender, MediaStreamTrack | null> | null = null;
  private remoteIds = new Map<string, string>();
  private frameBaselines = new Map<string, ReadonlyMap<string, number> | null>();
  private receiving = new Map<string, MediaStream>();
  private makingOffer = false;
  private ignoreOffer = false;
  private settingAnswer = false;
  private pendingOffer: { payload: ChannelSignal; senders: Map<RTCRtpSender, MediaStreamTrack | null> } | null = null;
  private localOfferFailed = false;
  private answer: ChannelSignal | null = null;
  private candidates: RTCIceCandidateInit[] = [];
  private operations: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | null;
  private closed = false;
  private rooms = new Set<string>();
  private channel: RTCDataChannel | null = null;
  private bulk: RTCDataChannel | null = null;
  private input: RTCDataChannel | null = null;
  private inputEnabled = false;
  private writers = new Map<RTCDataChannel, ChannelWriter>();
  private lifetime = new AbortController();
  private baseFailed = false;

  outgoingMetrics(report: RTCStatsReport, flowIds: ReadonlySet<string>): Array<{ flowId: string; metrics: ConnectionMetrics }> {
    return [...this.sending].flatMap(([flowId, binding]) => {
      if (!flowIds.has(flowId)) return [];
      const video = binding.senders.find(value => value.source.kind === "video");
      const track = binding.senders.find(value => value.source.kind === (binding.kind === "screen" ? "video" : "audio"))?.sender.track;
      if (!track) return [];
      // Picture counters belong to the producer while this sender uses its clock.
      if (video && track !== video.encoded?.track) {
        debugTrack(video.source, { flowId, role: "source", senderTrackId: track.id });
        debugTrack(senderCaptureTrack(track), { flowId, role: "sender-input", senderTrackId: track.id });
      }
      const audio = binding.senders.find(value => value.source.kind === "audio")?.sender.track;
      return collectTrackConnectionMetrics(report, "send", binding.metrics ??= new Map(), {
        kind: binding.kind === "screen" ? "video" : "audio", trackIdentifier: track.id,
        audioTrackIdentifier: audio?.id ?? null,
      }).map(metrics => ({ flowId, metrics: video?.pooled?.metrics(metrics) ?? metrics }));
    });
  }

  constructor(private options: TransportOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers, bundlePolicy: "max-bundle" });
    this.deadline = setTimeout(() => this.timeout(), 20000);
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) options.send({ candidate: candidate.toJSON() });
    };
    this.pc.onnegotiationneeded = () => { if (!this.localOfferFailed) this.offer(); };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") {
        if (this.inputEnabled) options.input?.(this.input);
        options.dataState?.(true);
        options.connected();
        this.reportBaseReady();
        this.syncDeadline();
      } else if (this.pc.connectionState === "failed") { options.dataState?.(false); options.input?.(null); this.fail(); }
      else if (["disconnected", "closed"].includes(this.pc.connectionState)) options.input?.(null);
    };
    this.pc.ondatachannel = ({ channel }) => {
      if (channel.label === "piik-input") {
        if (this.input) channel.close(); else this.installInput(channel);
        return;
      }
      if ((channel.label !== "piik-room" && channel.label !== "piik-file") || (channel.label === "piik-room" ? this.channel : this.bulk)) { channel.close(); return; }
      this.installChannel(channel);
    };
    this.pc.ontrack = ({ streams }) => {
      for (const stream of streams) {
        const flowId = this.remoteIds.get(stream.id);
        if (!flowId) continue;
        this.receiving.set(stream.id, stream);
        options.receive(flowId, stream);
      }
    };
  }

  /** Input follows selected screens, independently of room-base leases. */
  setInputEnabled(enabled: boolean): void {
    const changed = this.inputEnabled !== enabled;
    this.inputEnabled = enabled;
    if (enabled && !this.input && !this.options.polite && !this.closed && !["failed", "closed"].includes(this.pc.connectionState)) {
      this.installInput(this.pc.createDataChannel("piik-input", { ordered: true }));
      this.retryOffer();
    } else if (changed) this.options.input?.(enabled ? this.input : null);
  }

  private installInput(channel: RTCDataChannel): void {
    this.input = channel;
    const current = () => !this.closed && this.input === channel;
    channel.addEventListener("open", () => { if (current() && this.inputEnabled) this.options.input?.(channel); });
    const lost = () => {
      if (!current()) return;
      this.input = null;
      this.options.input?.(null);
      channel.close();
    };
    channel.addEventListener("close", lost);
    channel.addEventListener("error", lost);
    if (this.inputEnabled) this.options.input?.(channel);
  }

  sendInput(frame: string): boolean {
    const channel = this.input;
    if (!this.inputEnabled || channel?.readyState !== "open" || this.closed || this.pc.connectionState !== "connected") return false;
    if (frame.length > 8192 || channel.bufferedAmount > 8192) { channel.close(); return false; }
    try { channel.send(frame); return true; }
    catch { channel.close(); return false; }
  }

  /** Room leases share one reliable ordered channel on this physical pair. */
  setRooms(rooms: readonly string[]): void {
    const added = rooms.some(room => !this.rooms.has(room));
    const changed = added || rooms.length !== this.rooms.size;
    this.rooms = new Set(rooms);
    if (added) this.baseFailed = false;
    if (this.rooms.size && !this.baseFailed && !this.channel && !this.options.polite) {
      this.installChannel(this.pc.createDataChannel("piik-room", { ordered: true }));
    }
    if (this.rooms.size && !this.bulk && !this.options.polite) this.installChannel(this.pc.createDataChannel("piik-file", { ordered: true }));
    this.reportBaseReady();
    this.syncDeadline();
    if (changed) this.retryOffer();
  }

  isBaseReady(): boolean {
    return !this.closed && !this.baseFailed && this.rooms.size > 0
      && this.channel?.readyState === "open" && this.pc.connectionState === "connected";
  }

  private installChannel(channel: RTCDataChannel): void {
    const bulk = channel.label === "piik-file";
    if (bulk) this.bulk = channel; else this.channel = channel;
    const writer = new ChannelWriter(channel, bulk ? "chunk" : "control");
    this.writers.set(channel, writer);
    const current = () => !this.closed && (bulk ? this.bulk : this.channel) === channel;
    channel.onopen = () => { if (current()) { this.reportBaseReady(); this.syncDeadline(); } };
    const failed = () => {
      if (!current()) return;
      writer.close();
      this.writers.delete(channel);
      if (bulk) {
        this.bulk = null;
        channel.close();
        if (!["failed", "closed"].includes(this.pc.connectionState)) this.options.bulkClosed?.();
        return;
      }
      this.channel = null;
      this.failBase();
      channel.close();
    };
    channel.onclose = failed;
    channel.onerror = failed;
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (!current() || !this.rooms.size) return;
      if (bulk && data instanceof ArrayBuffer && data.byteLength <= MAX_FILE_FRAME_BYTES) this.options.data?.("chunk", new Uint8Array(data));
      else if (!bulk && typeof data === "string" && new TextEncoder().encode(data).length <= MAX_CONTROL_FRAME_BYTES) this.options.data?.("control", data);
    };
    this.reportBaseReady();
    this.syncDeadline();
  }

  async sendData(kind: "control" | "chunk", data: string | Uint8Array, allowed?: () => boolean): Promise<void> {
    let channel = kind === "control" ? this.channel : this.bulk;
    if (!channel) {
      await new Promise<void>((resolve, reject) => {
        const installed = ({ channel }: RTCDataChannelEvent) => { if (channel.label === (kind === "control" ? "piik-room" : "piik-file")) { cleanup(); resolve(); } };
        const aborted = () => { cleanup(); reject(new Error("peer_data_unavailable")); };
        const cleanup = () => { this.pc.removeEventListener("datachannel", installed); this.lifetime.signal.removeEventListener("abort", aborted); };
        this.pc.addEventListener("datachannel", installed);
        this.lifetime.signal.addEventListener("abort", aborted, { once: true });
        if (this.closed) aborted();
      });
      channel = kind === "control" ? this.channel : this.bulk;
    }
    if (!channel || !this.rooms.size) throw new Error("data_channel_unavailable");
    const writer = this.writers.get(channel);
    if (!writer) throw new Error("data_channel_unavailable");
    try { await writer.send(data, allowed); }
    catch (error) {
      if (this.closed || ["failed", "closed"].includes(this.pc.connectionState)) throw new Error("peer_data_unavailable");
      throw error;
    }
  }

  private reportBaseReady(): void {
    if (this.isBaseReady()) this.options.base(true);
  }

  private failBase(): void {
    if (!this.rooms.size || this.baseFailed) return;
    this.baseFailed = true;
    const channel = this.channel;
    this.channel = null;
    if (channel) { this.writers.get(channel)?.close(); this.writers.delete(channel); }
    channel?.close();
    this.options.base(false);
    this.syncDeadline();
  }

  private syncDeadline(): void {
    if (this.pc.connectionState === "connected" && (!this.rooms.size || this.baseFailed || this.channel?.readyState === "open")) {
      this.clearDeadline();
    } else if (this.rooms.size && !this.baseFailed && this.channel?.readyState !== "open" && this.deadline === null) {
      this.deadline = setTimeout(() => this.timeout(), 20000);
    }
  }

  private timeout(): void {
    this.deadline = null;
    if (this.closed) return;
    if (this.pc.connectionState === "connected") this.failBase();
    else this.fail();
  }

  setOutgoing(streams: ReadonlyMap<string, OutgoingMedia>, resourcesReleased = false): boolean {
    if (resourcesReleased || [...this.sending].some(([id, output]) => !output.failed && !streams.has(id)) || [...streams].some(([id, { stream }]) => {
      const output = this.sending.get(id);
      if (output?.failed) return false;
      const previous = output?.rejectedTracks ?? output?.stream.getTracks();
      const tracks = stream?.getTracks() ?? [];
      return !previous || previous.length !== tracks.length || tracks.some(track => !previous.includes(track));
    })) this.retryOffer();
    let released = false;
    for (const [id, previous] of this.sending) {
      if (streams.has(id)) continue;
      released ||= previous.senders.length > 0;
      for (const sender of previous.senders) this.removeSender(sender);
      for (const track of previous.stream.getTracks()) previous.stream.removeTrack(track);
      this.sending.delete(id);
    }
    for (const [id, { kind, stream, profile, audioBitrate, codec, voiceBitrate, paused = false }] of streams) {
      let output = this.sending.get(id);
      if (!output) {
        output = { kind, stream: new MediaStream(), senders: [], failed: false, paused };
        this.sending.set(id, output);
      }
      if (output.failed) continue;
      if (profile && (!output.profile || !videoQualitySettingsEqual(output.profile, profile))) {
        output.profile = profile;
        const owner = output;
        for (const sender of owner.senders) if (sender.source.kind === "video") {
          this.enqueue(() => this.applyVideoProfile(id, owner, sender, profile));
        }
      }
      if (output.paused !== paused) {
        output.paused = paused;
        const owner = output;
        for (const sender of owner.senders) {
          sender.encoded?.setPaused(paused);
          sender.pooled?.setPaused(paused);
          this.enqueue(() => this.applyPaused(id, owner, sender));
        }
      }
      const bitrate = kind === "voice" ? voiceBitrate ?? DEFAULT_ROOM_VOICE_BITRATE : screenAudioBitrate(audioBitrate);
      if (output.audioBitrate !== bitrate) {
        output.audioBitrate = bitrate;
        const owner = output;
        for (const sender of owner.senders) if (sender.source.kind === "audio") {
          this.enqueue(() => this.applyAudioBitrate(id, owner, sender));
        }
      }
      const tracks = stream?.getTracks() ?? [];
      if (output.replacement || output.senders.some(sender => tracks.some(track =>
        track.kind === sender.source.kind && track !== sender.source))) {
        if (output.replacement?.length === tracks.length && tracks.every(track => output.replacement!.includes(track))) continue;
        const owner = output;
        owner.replacement = tracks;
        this.enqueue(async () => {
          if (this.sending.get(id) !== owner || owner.replacement !== tracks || owner.failed) return;
          try {
            const retained: SenderBinding[] = [];
            for (const track of tracks) {
              const sender = owner.senders.find(sender => sender.source.kind === track.kind && !retained.includes(sender));
              if (sender) {
                if (sender.source !== track) await this.replaceSource(id, owner, sender, track);
                if (this.closed || this.sending.get(id) !== owner) return;
                retained.push(sender);
              } else {
                owner.stream.addTrack(track);
                const added = this.addSender(id, owner, track, codec);
                retained.push(added);
                owner.senders.push(added);
                if (track.kind === "audio") {
                  await this.applyAudioBitrate(id, owner, added);
                }
                if (owner.paused) await this.applyPaused(id, owner, added);
              }
            }
            for (const sender of owner.senders) if (!retained.includes(sender)) this.removeSender(sender);
            owner.senders = retained;
            for (const previous of owner.stream.getTracks()) if (!tracks.includes(previous)) owner.stream.removeTrack(previous);
            for (const track of tracks) if (!owner.stream.getTracks().includes(track)) owner.stream.addTrack(track);
          } catch (error) {
            if (!this.closed && this.sending.get(id) === owner && owner.replacement === tracks) {
              this.failOutput(id, owner);
              console.warn("Channel source replacement failed", { flowId: id }, error);
            }
          } finally { if (owner.replacement === tracks) owner.replacement = undefined; }
        });
        continue;
      }
      if (output.rejectedTracks?.length === tracks.length && tracks.every(track => output.rejectedTracks!.includes(track))) continue;
      output.rejectedTracks = undefined;
      const previous = [...output.senders];
      let attached = true;
      for (const track of tracks) {
        if (!output.senders.some(sender => sender.source === track)) {
          try {
            output.stream.addTrack(track);
            const video = kind === "screen" && track.kind === "video";
            const sender = this.addSender(id, output, track, codec);
            output.senders.push(sender);
            if (track.kind === "audio") {
              const owner = output;
              this.enqueue(() => this.applyAudioBitrate(id, owner, sender));
            }
            if (video && profile) {
              const owner = output;
              this.enqueue(() => this.applyVideoProfile(id, owner, sender, profile));
            }
            if (output.paused) {
              const owner = output;
              this.enqueue(() => this.applyPaused(id, owner, sender));
            }
          } catch (error) {
            attached = false;
            const live = previous.filter(sender => sender.sender.track?.readyState === "live");
            const retained = live.some(sender => sender.source.kind === (kind === "screen" ? "video" : "audio")) ? live : [];
            for (const sender of output.senders) if (!retained.includes(sender)) this.removeSender(sender);
            output.senders = retained;
            for (const track of output.stream.getTracks()) {
              if (!retained.some(sender => sender.source === track)) output.stream.removeTrack(track);
            }
            console.warn("Channel media sender attach failed", { flowId: id, kind: track.kind }, error);
            output.rejectedTracks = [...tracks];
            output.failed = retained.length === 0;
            if (output.failed) this.options.outgoingFailed?.(id);
            break;
          }
        }
      }
      if (attached) output.senders = output.senders.filter(sender => {
        if (tracks.includes(sender.source)) return true;
        output.stream.removeTrack(sender.source);
        this.removeSender(sender);
        released = true;
        return false;
      });
    }
    return released;
  }

  private ownsSender(id: string, owner: OutgoingBinding, binding: SenderBinding): boolean {
    return !this.closed && this.sending.get(id) === owner && !owner.failed && owner.senders.includes(binding);
  }

  private failOutput(id: string, owner: OutgoingBinding): void {
    if (this.closed || this.sending.get(id) !== owner || owner.failed) return;
    owner.failed = true;
    for (const binding of owner.senders) this.removeSender(binding);
    owner.senders = [];
    for (const track of owner.stream.getTracks()) owner.stream.removeTrack(track);
    this.options.outgoingFailed?.(id);
  }

  private cloneVideo(id: string, owner: OutgoingBinding, source: MediaStreamTrack): MediaStreamTrack {
    const track = cloneSenderVideoTrack(source, ended => {
      if (owner.senders.some(binding => binding.sender.track === ended)) this.failOutput(id, owner);
    });
    track.enabled = !owner.paused;
    return track;
  }

  private commitSenderTrack(sender: RTCRtpSender): void {
    if (this.stableSenders?.has(sender)) this.stableSenders.set(sender, sender.track);
    if (this.pendingOffer?.senders.has(sender)) this.pendingOffer.senders.set(sender, sender.track);
  }

  private async replaceSource(id: string, owner: OutgoingBinding, binding: SenderBinding, source: MediaStreamTrack): Promise<void> {
    const previous = binding.sender.track;
    const isolated = !!binding.encoded || previous !== binding.source;
    const next = isolated ? this.cloneVideo(id, owner, source) : source;
    let retained = false;
    try {
      await waitForConnectionOperation(binding.lifetime.signal, () => binding.sender.replaceTrack(next));
      if (!this.ownsSender(id, owner, binding)) return;
      const pooled = binding.pooled;
      binding.pooled = undefined;
      binding.source = source;
      pooled?.dispose();
      this.attachPool(id, owner, binding);
      if (source.kind === "video" && owner.profile) await this.applyVideoProfile(id, owner, binding, owner.profile);
      if (!this.ownsSender(id, owner, binding)) return;
      this.commitSenderTrack(binding.sender);
      retained = true;
    } finally {
      if (isolated) {
        if (!retained) stopSenderVideoTrack(next);
        if ((retained || !this.ownsSender(id, owner, binding)) && previous !== next && previous !== binding.encoded?.track) stopSenderVideoTrack(previous);
      }
    }
  }

  private async applyAudioBitrate(id: string, owner: OutgoingBinding, binding: SenderBinding): Promise<void> {
    if (!this.ownsSender(id, owner, binding)) return;
    const sender = binding.sender;
    const parameters = sender.getParameters();
    if (!parameters.encodings.length) return;
    try { await waitForConnectionOperation(binding.lifetime.signal, () => configureAudioSender(sender, owner.audioBitrate!)); }
    catch (error) { if (this.ownsSender(id, owner, binding)) console.warn("Channel audio bitrate could not be applied", { flowId: id }, error); }
  }

  private addSender(id: string, owner: OutgoingBinding, source: MediaStreamTrack, codec?: BrowserVideoCodecPreference, allowPool = true): SenderBinding {
    if (owner.kind !== "screen" || source.kind !== "video") return { sender: this.pc.addTrack(source, owner.stream), source, lifetime: new AbortController() };
    const profile = owner.profile;
    const layered = this.options.canReceiveVideoLayers, count = layered ? 2 : 1;
    const isolated = !layered && profile && this.options.videoPool && supportsBrowserEncoding();
    const pooled = allowPool && isolated;
    const track = isolated ? this.cloneVideo(id, owner, source) : source;
    const encodings = profile ? screenShareEncodings(profile, source.getSettings(), count, count)
      : layered ? [{ rid: "q", scaleResolutionDownBy: 2 }, { rid: "h", scaleResolutionDownBy: 1 }] : [{}];
    if (!layered) delete encodings[0].rid;
    let binding: SenderBinding | undefined;
    try {
      const transceiver = this.pc.addTransceiver(track, { direction: "sendrecv", streams: [owner.stream], sendEncodings: encodings });
      binding = { sender: transceiver.sender, source, lifetime: new AbortController() };
      if (codec && !applyVideoCodecPreference(transceiver, codec)) throw new Error("video_codec_unsupported");
      if (pooled) {
        // Attach synchronously while this sender's encoded stream is still claimable.
        // The physical PC also carries ordinary audio, receive tracks and Native flows.
        try {
          binding.encoded = new BrowserEncodingOutput(binding.sender, () => this.failOutput(id, owner), { flowId: id });
        } catch (error) {
          // A refused claim may already have intercepted this sender. Recreate
          // only this optional optimization's new sender with ordinary media.
          this.removeSender(binding);
          binding = undefined;
          console.warn("Channel encoding pool unavailable for sender", { flowId: id }, error);
          return this.addSender(id, owner, source, codec, false);
        }
        binding.encoded.setPaused(owner.paused);
        this.attachPool(id, owner, binding);
      }
      return binding;
    } catch (error) {
      if (binding) this.removeSender(binding);
      else if (isolated) stopSenderVideoTrack(track);
      throw error;
    }
  }

  /** Pool handoffs use the same queue as SDP, without turning a failed handoff into a pair failure. */
  private senderOperation<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.operations.then(operation);
    this.operations = work.then(() => {}, () => {});
    return work;
  }

  private attachPool(id: string, owner: OutgoingBinding, binding: SenderBinding): void {
    const encoded = binding.encoded, pool = this.options.videoPool;
    if (!encoded || !pool || !owner.profile) return;
    const source = binding.source, sender = binding.sender;
    let member: BrowserPooledSender | null = null;
    const owns = () => this.ownsSender(id, owner, binding) && binding.source === source && binding.pooled === member;
    const requestKey = () => this.senderOperation(async () => {
      if (!owns()) return;
      const request = sender.setParameters as (parameters: RTCRtpSendParameters,
        options: { encodingOptions: Array<{ keyFrame: boolean }> }) => Promise<void>;
      await waitForConnectionOperation(binding.lifetime.signal,
        () => request.call(sender, sender.getParameters(), { encodingOptions: [{ keyFrame: true }] }));
    });
    member = pool.create(source, sender, this.pc, owner.profile, encoded,
      () => this.senderOperation(async () => {
        if (!owns()) return false;
        const previous = sender.track!;
        const next = member?.carrierScale() !== undefined ? encoded.track
          : previous === encoded.track ? this.cloneVideo(id, owner, source) : previous;
        try {
          next.enabled = !owner.paused;
          if (next !== encoded.track) await waitForConnectionOperation(binding.lifetime.signal, () => applyVideoCaptureProfile(next, owner.profile!));
          if (!owns()) return false;
          if (next !== previous) await waitForConnectionOperation(binding.lifetime.signal, () => sender.replaceTrack(next));
          await waitForConnectionOperation(binding.lifetime.signal, () => configureVideoSender(sender, owner.profile!, member?.carrierScale()));
          if (!owns()) return false;
          if (next.readyState === "ended") throw new Error("Replacement video track ended");
          this.commitSenderTrack(sender);
          if (previous !== next && previous !== encoded.track) stopSenderVideoTrack(previous);
          owner.metrics = undefined;
          return true;
        } catch (error) {
          if (owns() && sender.track !== previous) {
            try { await waitForConnectionOperation(binding.lifetime.signal, () => sender.replaceTrack(previous)); }
            catch { if (owns()) this.failOutput(id, owner); }
          }
          if (owns()) console.warn("Channel pooled carrier could not be applied", { flowId: id }, error);
          return false;
        } finally {
          if (next !== encoded.track && next !== previous && (!owns() || sender.track !== next)) stopSenderVideoTrack(next);
          if (!owns() && previous !== encoded.track) stopSenderVideoTrack(previous);
        }
      }), requestKey, () => { if (owns()) this.failOutput(id, owner); });
    binding.pooled = member;
    if (!member) encoded.passthrough(requestKey);
    member?.setPaused(owner.paused);
  }

  private async applyPaused(id: string, owner: OutgoingBinding, binding: SenderBinding): Promise<void> {
    if (!this.ownsSender(id, owner, binding)) return;
    const sender = binding.sender;
    const paused = owner.paused;
    binding.encoded?.setPaused(paused);
    binding.pooled?.setPaused(paused);
    if (sender.track && sender.track !== binding.source) sender.track.enabled = !paused;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) return;
      let active = this.pausedEncodings.get(sender);
      if (paused && !active) {
        active = parameters.encodings.map(encoding => encoding.active ?? true);
        this.pausedEncodings.set(sender, active);
      }
      if (!active) return;
      parameters.encodings.forEach((encoding, index) => { encoding.active = !paused && (active![index] ?? true); });
      await waitForConnectionOperation(binding.lifetime.signal, () => sender.setParameters(parameters));
      if (!paused) this.pausedEncodings.delete(sender);
    } catch (error) { if (this.ownsSender(id, owner, binding)) console.warn("Channel sender pause could not be applied", { flowId: id }, error); }
  }

  private async applyVideoProfile(id: string, owner: OutgoingBinding, binding: SenderBinding, profile: VideoSenderProfile): Promise<void> {
    const current = () => this.ownsSender(id, owner, binding);
    if (!current()) return;
    const sender = binding.sender;
    if (!sender.getParameters().encodings.length) return;
    try {
      await binding.pooled?.updateProfile(profile);
      const applied = await waitForConnectionOperation(binding.lifetime.signal,
        () => configureVideoSender(sender, profile, binding.pooled?.carrierScale()));
      if (current() && applied.mismatches.length) {
        console.warn("Channel source quality parameters were not fully applied", { flowId: id, parameters: applied.mismatches });
      }
    } catch (error) {
      if (current()) console.warn("Channel source quality parameters could not be applied", { flowId: id }, error);
    }
  }

  /** An explicit source edit shares the negotiation queue, but cannot fail the pair. */
  configureVideo(id: string, profile: VideoSenderProfile): Promise<void> {
    const owner = this.sending.get(id);
    return this.senderOperation(async () => {
      if (this.closed || !owner || this.sending.get(id) !== owner || owner.failed) return;
      for (const binding of owner.senders) if (binding.source.kind === "video" && binding.sender.getParameters().encodings.length) {
        await binding.pooled?.updateProfile(profile);
        const applied = await waitForConnectionOperation(binding.lifetime.signal,
          () => configureVideoSender(binding.sender, profile, binding.pooled?.carrierScale()));
        if (applied.mismatches.length) throw new Error("capture_quality_unsupported");
      }
      if (this.sending.get(id) === owner) owner.profile = profile;
    });
  }

  private removeSender(binding: SenderBinding): void {
    const { sender, encoded, pooled } = binding;
    binding.lifetime.abort();
    binding.pooled = undefined;
    pooled?.dispose();
    encoded?.dispose();
    if (sender.track !== binding.source && sender.track !== encoded?.track) stopSenderVideoTrack(sender.track);
    this.stableSenders?.delete(sender);
    this.pendingOffer?.senders.delete(sender);
    if (!this.closed) this.pc.removeTrack(sender);
  }

  private retryOffer(): void {
    if (!this.localOfferFailed && ![...this.sending.values()].some(output => !output.failed && output.rejectedTracks)) return;
    this.localOfferFailed = false;
    for (const output of this.sending.values()) output.rejectedTracks = undefined;
    this.offer();
  }

  private offer(): void {
    this.enqueue(async () => {
      if (this.pc.signalingState !== "stable" || this.pendingOffer) return;
      const senders = new Map([...this.sending.values()].flatMap(output => output.senders.map(({ sender }) => [sender, sender.track] as const)));
      const channel = this.channel, bulk = this.bulk;
      this.makingOffer = true;
      try {
        try {
          const offer = preferOpusStereoReceive(await this.pc.createOffer());
          await this.pc.setLocalDescription({ ...offer, sdp: normalizeVideoOfferSdp(offer.sdp!) });
        }
        catch (error) {
          if (!this.stableSenders || this.pendingOffer || this.pc.signalingState !== "stable"
            || this.closed || ["failed", "closed"].includes(this.pc.connectionState)) throw error;
          this.localOfferFailed = true;
          const reverted: string[] = [], failed: string[] = [];
          for (const [id, output] of this.sending) {
            const rejected = output.senders.filter(({ sender }) => senders.has(sender) && senders.get(sender) === sender.track
              && this.stableSenders!.get(sender) !== sender.track);
            if (!rejected.length) continue;
            reverted.push(id);
            output.rejectedTracks = output.stream.getTracks();
            for (const sender of rejected) {
              output.stream.removeTrack(sender.source);
              this.removeSender(sender);
            }
            output.senders = output.senders.filter(sender => !rejected.includes(sender));
            if (!output.senders.some(({ sender }) => sender.track?.readyState === "live" && sender.track.kind === (output.kind === "screen" ? "video" : "audio"))) {
              output.failed = true;
              failed.push(id);
            }
          }
          console.warn("Channel local offer failed", { flows: reverted }, error);
          for (const id of failed) this.options.outgoingFailed?.(id);
          if ((this.channel && this.channel !== channel) || (this.bulk && this.bulk !== bulk)
            || [...this.sending.values()].some(output => output.senders.some(({ sender }) => !senders.has(sender) || senders.get(sender) !== sender.track))) this.retryOffer();
          return;
        }
        if (!this.closed) this.sendDescription(senders);
      } finally { this.makingOffer = false; }
    });
  }

  private confirmSenders(senders: ReadonlyMap<RTCRtpSender, MediaStreamTrack | null>): void {
    this.stableSenders = new Map(this.pc.getTransceivers()
      .filter(transceiver => ["sendonly", "sendrecv"].includes(transceiver.currentDirection ?? "")
        && senders.has(transceiver.sender) && senders.get(transceiver.sender) === transceiver.sender.track)
      .map(transceiver => [transceiver.sender, transceiver.sender.track]));
    for (const [id, owner] of this.sending) for (const sender of owner.senders) if (this.stableSenders.has(sender.sender)) {
      if (sender.source.kind === "audio") this.enqueue(() => this.applyAudioBitrate(id, owner, sender));
      if (sender.source.kind === "video" && owner.profile) this.enqueue(() => this.applyVideoProfile(id, owner, sender, owner.profile!));
      this.enqueue(() => this.applyPaused(id, owner, sender));
    }
  }

  hasRemoteStream(flowId: string, stream: MediaStream): boolean {
    return this.remoteIds.get(stream.id) === flowId;
  }

  frameBaseline(flowId: string): ReadonlyMap<string, number> | null {
    return this.frameBaselines.get(flowId) ?? null;
  }

  signal(payload: ChannelSignal): void {
    this.enqueue(async () => {
      if (payload.resync) { this.resendOffer(); return; }
      if (payload.description) {
        const description = payload.description;
        if (description.type === "answer" && (!this.pendingOffer || payload.exchangeId !== this.pendingOffer.payload.exchangeId)) return;
        if (description.type === "offer" && this.answer && payload.exchangeId === this.answer.exchangeId) { this.replayDescription(this.answer); return; }
        const ready = !this.makingOffer && (this.pc.signalingState === "stable" || this.settingAnswer);
        const collision = description.type === "offer" && !ready;
        this.ignoreOffer = !this.options.polite && collision;
        if (this.ignoreOffer) return;
        this.settingAnswer = description.type === "answer";
        const previousIds = this.remoteIds;
        const offeredSenders = this.pendingOffer?.senders;
        const remoteIds = new Map((payload.tracks ?? []).map(track => [track.streamId, track.flowId]));
        const flows = new Set(remoteIds.values());
        const added = [...flows].filter(id => !this.frameBaselines.has(id));
        if (added.length) {
          let baseline: ReadonlyMap<string, number> | null = null;
          try {
            const samples = decodedVideoFrameSamples(await this.pc.getStats());
            if (samples.every(sample => sample.framesDecoded !== null)) {
              baseline = new Map(samples.map(sample => [sample.id, sample.framesDecoded!]));
            }
          } catch { /* An unknown baseline requires observed progress, not transport failure. */ }
          if (this.closed) return;
          for (const id of added) this.frameBaselines.set(id, baseline);
        }
        this.remoteIds = remoteIds;
        try { await this.pc.setRemoteDescription(description); }
        finally { this.settingAnswer = false; }
        if (description.type === "answer") this.confirmSenders(offeredSenders!);
        if (description.type === "offer" || description.type === "answer") this.pendingOffer = null;
        for (const [streamId, stream] of this.receiving) {
          const flowId = this.remoteIds.get(streamId);
          if (flowId) this.options.receive(flowId, stream);
          else this.receiving.delete(streamId);
        }
        for (const id of this.frameBaselines.keys()) if (!flows.has(id)) this.frameBaselines.delete(id);
        for (const id of new Set(previousIds.values())) {
          if (!flows.has(id)) this.options.retire?.(id);
        }
        for (const candidate of this.candidates.splice(0)) await addRemoteIceCandidate(this.pc, { ...candidate, candidate: candidate.candidate ?? "" });
        if (description.type === "offer") {
          const senders = new Map([...this.sending.values()].flatMap(output => output.senders.map(({ sender }) => [sender, sender.track] as const)));
          await this.pc.setLocalDescription(preferOpusStereoReceive(await this.pc.createAnswer()));
          if (!this.closed) { this.confirmSenders(senders); this.sendDescription(senders, payload.exchangeId!); }
        }
      } else if (payload.candidate && !this.ignoreOffer) {
        if (this.pc.remoteDescription) await addRemoteIceCandidate(this.pc, { ...payload.candidate, candidate: payload.candidate.candidate ?? "" });
        else if (this.candidates.length < 128) this.candidates.push(payload.candidate);
      }
    });
  }

  resync(): void {
    this.enqueue(async () => {
      this.options.send({ resync: true });
      this.resendOffer();
    });
  }

  private resendOffer(): void {
    if (this.pendingOffer) this.replayDescription(this.pendingOffer.payload);
  }

  private replayDescription(payload: ChannelSignal): void {
    // SDP completes its original exchange; only current flow bindings may travel with it.
    this.options.send({ ...payload, tracks: payload.tracks?.filter(track => {
      const output = this.sending.get(track.flowId);
      return output && !output.failed && output.stream.id === track.streamId;
    }) });
  }

  private sendDescription(senders: Map<RTCRtpSender, MediaStreamTrack | null>, exchangeId: string = crypto.randomUUID()): void {
    const description = this.pc.localDescription;
    if (!description || (description.type !== "offer" && description.type !== "answer")) return;
    const payload = { exchangeId, description: { type: description.type, sdp: description.sdp }, tracks: [...this.sending]
      .filter(([, output]) => !output.failed).map(([flowId, { stream }]) => ({ flowId, streamId: stream.id })) };
    if (description.type === "offer") this.pendingOffer = { payload, senders };
    else if (description.type === "answer") this.answer = payload;
    this.options.send(payload);
  }

  private enqueue(action: () => Promise<void>): void {
    this.operations = this.operations.then(async () => { if (!this.closed) await action(); })
      .catch(error => { if (!this.closed) { console.warn("Channel media negotiation failed", error); this.fail(); } });
  }

  private clearDeadline(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private fail(): void {
    if (this.closed) return;
    this.clearDeadline();
    this.failBase();
    this.options.failed();
  }

  close(): boolean {
    const released = [...this.sending.values()].some(output => output.senders.length > 0);
    this.closed = true;
    this.options.dataState?.(false);
    this.options.input?.(null);
    this.lifetime.abort();
    for (const writer of this.writers.values()) writer.close();
    this.writers.clear();
    this.clearDeadline();
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.channel?.close();
    this.bulk?.close();
    this.input?.close();
    this.channel = null;
    for (const owner of this.sending.values()) for (const binding of owner.senders) this.removeSender(binding);
    this.pc.close();
    this.sending.clear();
    this.receiving.clear();
    this.frameBaselines.clear();
    this.pendingOffer = null;
    this.stableSenders = null;
    this.answer = null;
    return released;
  }
}

/** One bounded writer per SCTP stream; producers own their application work. */
class ChannelWriter {
  private tail = Promise.resolve();
  private lifetime = new AbortController();
  private queuedFrames = 0;
  constructor(private channel: RTCDataChannel, private kind: "control" | "chunk") { channel.bufferedAmountLowThreshold = DATA_SEND_BUFFER_BYTES / 2; }
  send(data: string | Uint8Array, allowed?: () => boolean): Promise<void> {
    const size = typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
    if (size > (this.kind === "control" ? MAX_CONTROL_FRAME_BYTES : MAX_FILE_FRAME_BYTES)) return Promise.reject(new Error(this.kind === "control" ? "control_frame_too_large" : "file_frame_too_large"));
    if (this.queuedFrames >= DATA_SEND_QUEUE_FRAMES[this.kind]) return Promise.reject(new Error("data_channel_busy"));
    this.queuedFrames += 1;
    const work = this.tail.then(async () => {
      this.lifetime.signal.throwIfAborted();
      while (this.channel.readyState !== "open" || this.channel.bufferedAmount + size > DATA_SEND_BUFFER_BYTES) {
        if (["closing", "closed"].includes(this.channel.readyState)) throw new Error("data_channel_unavailable");
        await new Promise<void>((resolve, reject) => {
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error("data_channel_unavailable")); };
          const cleanup = () => { for (const event of ["open", "bufferedamountlow"]) this.channel.removeEventListener(event, ready); for (const event of ["closing", "close", "error"]) this.channel.removeEventListener(event, failed); this.lifetime.signal.removeEventListener("abort", failed); };
          for (const event of ["open", "bufferedamountlow"]) this.channel.addEventListener(event, ready, { once: true });
          for (const event of ["closing", "close", "error"]) this.channel.addEventListener(event, failed, { once: true });
          this.lifetime.signal.addEventListener("abort", failed, { once: true });
        });
      }
      if (allowed && !allowed()) throw new Error("room_unavailable");
      if (typeof data === "string") this.channel.send(data); else this.channel.send(data as Uint8Array<ArrayBuffer>);
    }).finally(() => { this.queuedFrames -= 1; });
    this.tail = work.catch(() => {});
    return work;
  }
  close(): void { this.lifetime.abort(); }
}
