import { addRemoteIceCandidate } from "../webrtc/nat-prediction";
import type { ChannelSignal } from "./protocol";

interface TransportOptions {
  polite: boolean;
  iceServers: RTCIceServer[];
  send(payload: ChannelSignal): void;
  receive(publicationId: string, stream: MediaStream): void;
  connected(): void;
  base(ready: boolean): void;
  failed(): void;
}

/** One physical pair. Publications own tracks; the pair only owns senders. */
export class ChannelTransport {
  readonly pc: RTCPeerConnection;
  private sending = new Map<string, { stream: MediaStream; senders: RTCRtpSender[] }>();
  private remoteIds = new Map<string, string>();
  private receiving = new Map<string, MediaStream>();
  private makingOffer = false;
  private ignoreOffer = false;
  private settingAnswer = false;
  private pendingOffer: ChannelSignal | null = null;
  private answer: ChannelSignal | null = null;
  private candidates: RTCIceCandidateInit[] = [];
  private operations: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | null;
  private closed = false;
  private rooms = new Set<string>();
  private channel: RTCDataChannel | null = null;
  private baseFailed = false;

  constructor(private options: TransportOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers, bundlePolicy: "max-bundle" });
    this.deadline = setTimeout(() => this.timeout(), 20000);
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) options.send({ candidate: candidate.toJSON() });
    };
    this.pc.onnegotiationneeded = () => {
      this.enqueue(async () => {
        if (this.pc.signalingState !== "stable") return;
        this.makingOffer = true;
        try {
          await this.pc.setLocalDescription();
          if (!this.closed) this.sendDescription();
        } finally { this.makingOffer = false; }
      });
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") {
        options.connected();
        this.reportBaseReady();
        this.syncDeadline();
      } else if (this.pc.connectionState === "failed") this.fail();
    };
    this.pc.ondatachannel = ({ channel }) => {
      if (channel.label !== "piik-room" || this.channel) { channel.close(); return; }
      this.installChannel(channel);
    };
    this.pc.ontrack = ({ streams }) => {
      for (const stream of streams) {
        const publicationId = this.remoteIds.get(stream.id);
        if (!publicationId) continue;
        this.receiving.set(stream.id, stream);
        options.receive(publicationId, stream);
      }
    };
  }

  /** Room leases share one reliable ordered channel on this physical pair. */
  setRooms(rooms: readonly string[]): void {
    const added = rooms.some(room => !this.rooms.has(room));
    this.rooms = new Set(rooms);
    if (added) this.baseFailed = false;
    if (this.rooms.size && !this.baseFailed && !this.channel && !this.options.polite) {
      this.installChannel(this.pc.createDataChannel("piik-room", { ordered: true }));
    }
    this.reportBaseReady();
    this.syncDeadline();
  }

  isBaseReady(): boolean {
    return !this.closed && !this.baseFailed && this.rooms.size > 0
      && this.channel?.readyState === "open" && this.pc.connectionState === "connected";
  }

  private installChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    const current = () => !this.closed && this.channel === channel;
    channel.onopen = () => { if (current()) { this.reportBaseReady(); this.syncDeadline(); } };
    const failed = () => {
      if (!current()) return;
      this.channel = null;
      this.failBase();
      channel.close();
    };
    channel.onclose = failed;
    channel.onerror = failed;
    this.reportBaseReady();
    this.syncDeadline();
  }

  private reportBaseReady(): void {
    if (this.isBaseReady()) this.options.base(true);
  }

  private failBase(): void {
    if (!this.rooms.size || this.baseFailed) return;
    this.baseFailed = true;
    const channel = this.channel;
    this.channel = null;
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

  setOutgoing(streams: ReadonlyMap<string, MediaStream>): void {
    for (const [id, previous] of this.sending) {
      const next = streams.get(id);
      if (next === previous.stream && next.getTracks().every(track => previous.senders.some(sender => sender.track === track))) continue;
      for (const sender of previous.senders) this.pc.removeTrack(sender);
      this.sending.delete(id);
    }
    for (const [id, stream] of streams) {
      if (!this.sending.has(id)) {
        const senders = stream.getTracks().map(track => this.pc.addTrack(track, stream));
        this.sending.set(id, { stream, senders });
      }
    }
  }

  signal(payload: ChannelSignal): void {
    this.enqueue(async () => {
      if (payload.resync) { this.resendOffer(); return; }
      if (payload.description) {
        const description = payload.description;
        if (description.type === "answer" && (!this.pendingOffer || payload.exchangeId !== this.pendingOffer.exchangeId)) return;
        if (description.type === "offer" && this.answer && payload.exchangeId === this.answer.exchangeId) { this.replayDescription(this.answer); return; }
        const ready = !this.makingOffer && (this.pc.signalingState === "stable" || this.settingAnswer);
        const collision = description.type === "offer" && !ready;
        this.ignoreOffer = !this.options.polite && collision;
        if (this.ignoreOffer) return;
        this.settingAnswer = description.type === "answer";
        this.remoteIds = new Map((payload.tracks ?? []).map(track => [track.streamId, track.publicationId]));
        try { await this.pc.setRemoteDescription(description); }
        finally { this.settingAnswer = false; }
        if (description.type === "offer" || description.type === "answer") this.pendingOffer = null;
        for (const [streamId, stream] of this.receiving) {
          const publicationId = this.remoteIds.get(streamId);
          if (publicationId) this.options.receive(publicationId, stream);
          else this.receiving.delete(streamId);
        }
        for (const candidate of this.candidates.splice(0)) await addRemoteIceCandidate(this.pc, { ...candidate, candidate: candidate.candidate ?? "" });
        if (description.type === "offer") {
          await this.pc.setLocalDescription();
          if (!this.closed) this.sendDescription(payload.exchangeId!);
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
    if (this.pendingOffer) this.replayDescription(this.pendingOffer);
  }

  private replayDescription(payload: ChannelSignal): void {
    // SDP completes its original exchange; only current publication bindings may travel with it.
    this.options.send({ ...payload, tracks: payload.tracks?.filter(track => this.sending.get(track.publicationId)?.stream.id === track.streamId) });
  }

  private sendDescription(exchangeId: string = crypto.randomUUID()): void {
    const description = this.pc.localDescription;
    if (!description || (description.type !== "offer" && description.type !== "answer")) return;
    const payload = { exchangeId, description: { type: description.type, sdp: description.sdp }, tracks: [...this.sending].map(([publicationId, { stream }]) => ({ publicationId, streamId: stream.id })) };
    if (description.type === "offer") this.pendingOffer = payload;
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

  close(): void {
    this.closed = true;
    this.clearDeadline();
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.channel?.close();
    this.channel = null;
    this.pc.close();
    this.sending.clear();
    this.receiving.clear();
    this.pendingOffer = null;
    this.answer = null;
  }
}
