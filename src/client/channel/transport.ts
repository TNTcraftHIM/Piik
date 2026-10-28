import { addRemoteIceCandidate } from "../webrtc/nat-prediction";
import { decodedVideoFrameSamples } from "../webrtc/stats";
import type { ChannelPublication, ChannelSignal } from "./protocol";

const MAX_FILE_FRAME_BYTES = 8192;
const MAX_CONTROL_FRAME_BYTES = 32768;
const DATA_SEND_BUFFER_BYTES = 65536;
// Application memory queues, matching Native: 32 core ranges × at most 17 frames.
const DATA_SEND_QUEUE_FRAMES = { control: 128, chunk: 32 * 17 };

export interface OutgoingMedia {
  kind: ChannelPublication["kind"];
  stream: MediaStream | null;
}

interface TransportOptions {
  polite: boolean;
  iceServers: RTCIceServer[];
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
}

/** One physical pair. Flows own stream bindings and senders, never source tracks. */
export class ChannelTransport {
  readonly pc: RTCPeerConnection;
  private sending = new Map<string, { kind: ChannelPublication["kind"]; stream: MediaStream; senders: RTCRtpSender[]; failed: boolean; rejectedTracks?: MediaStreamTrack[] }>();
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
  private writers = new Map<RTCDataChannel, ChannelWriter>();
  private lifetime = new AbortController();
  private baseFailed = false;

  constructor(private options: TransportOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers, bundlePolicy: "max-bundle" });
    this.deadline = setTimeout(() => this.timeout(), 20000);
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) options.send({ candidate: candidate.toJSON() });
    };
    this.pc.onnegotiationneeded = () => { if (!this.localOfferFailed) this.offer(); };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") {
        options.dataState?.(true);
        options.connected();
        this.reportBaseReady();
        this.syncDeadline();
      } else if (this.pc.connectionState === "failed") { options.dataState?.(false); this.fail(); }
    };
    this.pc.ondatachannel = ({ channel }) => {
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
      if (bulk) { if (!["failed", "closed"].includes(this.pc.connectionState)) this.options.bulkClosed?.(); return; }
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
    for (const [id, { kind, stream }] of streams) {
      let output = this.sending.get(id);
      if (!output) {
        output = { kind, stream: new MediaStream(), senders: [], failed: false };
        this.sending.set(id, output);
      }
      if (output.failed) continue;
      const tracks = stream?.getTracks() ?? [];
      if (output.rejectedTracks?.length === tracks.length && tracks.every(track => output.rejectedTracks!.includes(track))) continue;
      output.rejectedTracks = undefined;
      const previous = [...output.senders];
      let attached = true;
      for (const track of tracks) {
        if (!output.senders.some(sender => sender.track === track)) {
          try {
            output.stream.addTrack(track);
            output.senders.push(this.pc.addTrack(track, output.stream));
          } catch (error) {
            attached = false;
            const live = previous.filter(sender => sender.track?.readyState === "live");
            const retained = live.some(sender => sender.track?.kind === (kind === "screen" ? "video" : "audio")) ? live : [];
            for (const sender of output.senders) if (!retained.includes(sender)) this.removeSender(sender);
            output.senders = retained;
            for (const track of output.stream.getTracks()) {
              if (!retained.some(sender => sender.track === track)) output.stream.removeTrack(track);
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
        if (sender.track && tracks.includes(sender.track)) return true;
        if (sender.track) output.stream.removeTrack(sender.track);
        this.removeSender(sender);
        released = true;
        return false;
      });
    }
    return released;
  }

  private removeSender(sender: RTCRtpSender): void {
    this.stableSenders?.delete(sender);
    this.pendingOffer?.senders.delete(sender);
    this.pc.removeTrack(sender);
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
      const senders = new Map([...this.sending.values()].flatMap(output => output.senders.map(sender => [sender, sender.track] as const)));
      const channel = this.channel, bulk = this.bulk;
      this.makingOffer = true;
      try {
        try { await this.pc.setLocalDescription(); }
        catch (error) {
          if (!this.stableSenders || this.pendingOffer || this.pc.signalingState !== "stable"
            || this.closed || ["failed", "closed"].includes(this.pc.connectionState)) throw error;
          this.localOfferFailed = true;
          const reverted: string[] = [], failed: string[] = [];
          for (const [id, output] of this.sending) {
            const rejected = output.senders.filter(sender => senders.has(sender) && senders.get(sender) === sender.track
              && this.stableSenders!.get(sender) !== sender.track);
            if (!rejected.length) continue;
            reverted.push(id);
            output.rejectedTracks = output.stream.getTracks();
            for (const sender of rejected) {
              if (sender.track) output.stream.removeTrack(sender.track);
              this.removeSender(sender);
            }
            output.senders = output.senders.filter(sender => !rejected.includes(sender));
            if (!output.senders.some(sender => sender.track?.readyState === "live" && sender.track.kind === (output.kind === "screen" ? "video" : "audio"))) {
              output.failed = true;
              failed.push(id);
            }
          }
          console.warn("Channel local offer failed", { flows: reverted }, error);
          for (const id of failed) this.options.outgoingFailed?.(id);
          if ((this.channel && this.channel !== channel) || (this.bulk && this.bulk !== bulk)
            || [...this.sending.values()].some(output => output.senders.some(sender => !senders.has(sender) || senders.get(sender) !== sender.track))) this.retryOffer();
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
          const senders = new Map([...this.sending.values()].flatMap(output => output.senders.map(sender => [sender, sender.track] as const)));
          await this.pc.setLocalDescription();
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
    this.channel = null;
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
