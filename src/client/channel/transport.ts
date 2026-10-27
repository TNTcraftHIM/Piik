import { addRemoteIceCandidate } from "../webrtc/nat-prediction";
import type { ChannelSignal } from "./protocol";

interface TransportOptions {
  polite: boolean;
  iceServers: RTCIceServer[];
  send(payload: ChannelSignal): void;
  receive(publicationId: string, stream: MediaStream): void;
  connected(): void;
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
  private candidates: RTCIceCandidateInit[] = [];
  private operations: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | null;
  private closed = false;

  constructor(private options: TransportOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers, bundlePolicy: "max-bundle" });
    this.deadline = setTimeout(() => this.fail(), 20000);
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
        this.clearDeadline();
        options.connected();
      } else if (this.pc.connectionState === "failed") this.fail();
    };
    this.pc.ontrack = ({ streams }) => {
      for (const stream of streams) {
        this.receiving.set(stream.id, stream);
        const publicationId = this.remoteIds.get(stream.id);
        if (publicationId) options.receive(publicationId, stream);
      }
    };
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
      if (payload.description) {
        const description = payload.description;
        const ready = !this.makingOffer && (this.pc.signalingState === "stable" || this.settingAnswer);
        const collision = description.type === "offer" && !ready;
        this.ignoreOffer = !this.options.polite && collision;
        if (this.ignoreOffer) return;
        this.settingAnswer = description.type === "answer";
        this.remoteIds = new Map((payload.tracks ?? []).map(track => [track.streamId, track.publicationId]));
        try { await this.pc.setRemoteDescription(description); }
        finally { this.settingAnswer = false; }
        for (const [streamId, stream] of this.receiving) {
          const publicationId = this.remoteIds.get(streamId);
          if (publicationId) this.options.receive(publicationId, stream);
        }
        for (const candidate of this.candidates.splice(0)) await addRemoteIceCandidate(this.pc, { ...candidate, candidate: candidate.candidate ?? "" });
        if (description.type === "offer") {
          await this.pc.setLocalDescription();
          if (!this.closed) this.sendDescription();
        }
      } else if (payload.candidate && !this.ignoreOffer) {
        if (this.pc.remoteDescription) await addRemoteIceCandidate(this.pc, { ...payload.candidate, candidate: payload.candidate.candidate ?? "" });
        else if (this.candidates.length < 128) this.candidates.push(payload.candidate);
      }
    });
  }

  private sendDescription(): void {
    const description = this.pc.localDescription;
    if (!description) return;
    this.options.send({ description: description.toJSON(), tracks: [...this.sending].map(([publicationId, { stream }]) => ({ publicationId, streamId: stream.id })) });
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
    this.options.failed();
  }

  close(): void {
    this.closed = true;
    this.clearDeadline();
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    this.sending.clear();
    this.receiving.clear();
  }
}
