import type { ClientMessage, IceConfig, RoomVoiceState, VoiceConnection, VoiceDescription } from "../../shared/protocol";
import { observeDebugConnection } from "../lib/debug-webrtc";
import { waitForConnectionOperation } from "../webrtc/connection-operation";
import { addRemoteIceCandidate, iceServersWithNatPrediction, natPredictionSurveyUrls, NatPredictionCandidateEmitter } from "../webrtc/nat-prediction";

type VoiceSignal = Extract<ClientMessage, { type: "room-voice-signal" }>;
interface Connection {
  config: VoiceConnection;
  pc: RTCPeerConnection;
  lifetime: AbortController;
  candidates: NatPredictionCandidateEmitter;
  queuedCandidates: NonNullable<VoiceSignal["candidate"]>[];
  localCandidates: NonNullable<VoiceSignal["candidate"]>[];
  senders: Map<string, RTCRtpSender>;
  remote: Map<string, string>;
  dirty: boolean;
  requested: boolean;
  descriptionSent: boolean;
  offerRevision: number;
  remoteRevision: number;
  reported: RTCPeerConnectionState | null;
}
interface Received {
  connectionId: string;
  publicationId: string;
  track: MediaStreamTrack;
  audio?: HTMLAudioElement;
  blocked: boolean;
}

// One authorized room plan owns these audio transports. This adapter neither
// chooses neighbours nor creates a recovery planner beside the room controller.
export class BrowserVoiceEndpoint {
  private connections = new Map<string, Connection>();
  private received = new Map<string, Received>();
  private source: { publicationId: string; stream: MediaStream } | null = null;
  private state: RoomVoiceState | null = null;
  private peerId = "";
  private generation = 0;
  readonly muted = new Set<string>();
  deafened = false;

  constructor(private iceConfig: IceConfig, private readonly send: (message: ClientMessage) => boolean, private readonly changed: () => void) {}

  get microphone(): boolean { return !!this.source; }
  get autoplayBlocked(): boolean { return !this.deafened && [...this.received.values()].some(binding => binding.blocked); }
  updateIceConfig(config: IceConfig): void { this.iceConfig = config; }

  setAuthority(state: RoomVoiceState | null, peerId: string): void {
    this.state = state; this.peerId = peerId;
    const allowed = new Map(state?.connections.map(config => [config.connectionId, config]));
    for (const [id, connection] of this.connections) {
      const config = allowed.get(id);
      if (!config) this.retire(connection);
      else {
        if (connection.config.send.join() !== config.send.join() || connection.config.receive.join() !== config.receive.join()) connection.dirty = true;
        connection.config = config;
        for (const [publicationId, sender] of connection.senders) if (!config.send.includes(publicationId)) {
          connection.pc.removeTrack(sender); connection.senders.delete(publicationId);
        }
      }
    }
    const me = state?.members.find(member => member.peerId === peerId);
    if (this.source && (!me?.speak || !me.listen || !state?.publications.some(pub => pub.id === this.source!.publicationId && pub.peerId === peerId))) this.stopMicrophone();
    for (const [key, binding] of this.received) {
      const config = allowed.get(binding.connectionId);
      if (!config?.receive.includes(binding.publicationId)) this.removeReceived(key);
      else if (config.pending && binding.audio) this.removePlayback(binding);
    }
    for (const muted of this.muted) if (!state?.members.some(member => member.peerId === muted)) this.muted.delete(muted);
  }

  attach(publicationId: string, stream: MediaStream): void {
    const me = this.state?.members.find(member => member.peerId === this.peerId);
    if (!me?.listen || !me.speak || !this.state?.publications.some(pub => pub.id === publicationId && pub.peerId === this.peerId)) throw new Error("Microphone publication is not authorized");
    this.stopMicrophone();
    this.source = { publicationId, stream };
  }
  stopMicrophone(): void {
    const source = this.source; this.source = null;
    source?.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
  }

  private current(connection: Connection): boolean { return this.connections.get(connection.config.connectionId) === connection && !connection.lifetime.signal.aborted; }
  private wait<T>(connection: Connection, action: () => Promise<T>): Promise<T> { return waitForConnectionOperation(connection.lifetime.signal, action); }
  private isOfferer(config: VoiceConnection): boolean { return config.transport === "peer" && config.parentPeerId === this.peerId; }
  private signal(connection: Connection, values: Omit<VoiceSignal, "type" | "connectionId">): boolean {
    return this.current(connection) && this.send({ type: "room-voice-signal", connectionId: connection.config.connectionId, ...values });
  }
  private report(connection: Connection, state: "connected" | "failed"): void {
    if (connection.reported === state) return;
    if (this.send({ type: "room-voice-transport", connectionId: connection.config.connectionId, state })) connection.reported = state;
  }
  private create(config: VoiceConnection): Connection {
    const prediction = config.transport === "peer" && !!this.iceConfig.natPredictionStunUrls?.length;
    const pc = new RTCPeerConnection({ iceServers: config.transport === "sfu" ? [] : iceServersWithNatPrediction(this.iceConfig.iceServers, prediction, this.iceConfig.natPredictionStunUrls) });
    const connection: Connection = { config, pc, lifetime: new AbortController(),
      candidates: new NatPredictionCandidateEmitter(prediction, candidate => {
        if (!candidate || !this.current(connection) || /\sTCP\s/i.test(candidate.candidate)) return;
        if (connection.localCandidates.length >= 64) { this.report(connection, "failed"); return; }
        connection.localCandidates.push(candidate); this.flushCandidates(connection);
      }, natPredictionSurveyUrls(this.iceConfig.iceServers, this.iceConfig.natPredictionStunUrls)),
      queuedCandidates: [], localCandidates: [], senders: new Map(), remote: new Map(), dirty: this.isOfferer(config),
      requested: false, descriptionSent: false, offerRevision: 0, remoteRevision: 0, reported: null };
    this.connections.set(config.connectionId, connection);
    observeDebugConnection(pc, { connectionId: config.connectionId, role: "room-voice" });
    pc.onicecandidate = event => { if (this.current(connection)) connection.candidates.add(event.candidate); };
    pc.onicegatheringstatechange = () => { if (this.current(connection) && pc.iceGatheringState === "complete") connection.candidates.gatheringComplete(); };
    pc.onnegotiationneeded = () => { if (this.current(connection)) { connection.dirty = true; this.changed(); } };
    pc.ontrack = () => { if (this.current(connection)) { this.bindReceivers(connection); this.changed(); } };
    pc.onconnectionstatechange = () => { if (this.current(connection)) this.changed(); };
    if (this.isOfferer(config)) {
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.createDataChannel("piik-room-voice");
    }
    return connection;
  }

  private flushCandidates(connection: Connection): void {
    if (!connection.descriptionSent) return;
    while (connection.localCandidates[0] && this.signal(connection, { candidate: connection.localCandidates[0] })) connection.localCandidates.shift();
  }
  private sourceTrack(publicationId: string): MediaStreamTrack | undefined {
    if (this.source?.publicationId === publicationId) return this.source.stream.getAudioTracks()[0];
    return [...this.received.values()].find(binding => binding.publicationId === publicationId && this.connections.get(binding.connectionId)?.config.pending === false)?.track;
  }
  private async syncSenders(connection: Connection): Promise<void> {
    const { pc, config } = connection;
    for (const [publicationId, sender] of connection.senders) {
      const track = config.send.includes(publicationId) ? this.sourceTrack(publicationId) : undefined;
      if (!track) {
        await this.wait(connection, () => sender.replaceTrack(null));
        pc.removeTrack(sender); connection.senders.delete(publicationId); connection.dirty = true;
      } else if (sender.track !== track) {
        await this.wait(connection, () => sender.replaceTrack(track));
        if (!connection.config.send.includes(publicationId) || this.sourceTrack(publicationId) !== track) {
          pc.removeTrack(sender); connection.senders.delete(publicationId); connection.dirty = true;
        }
      }
    }
    for (const publicationId of connection.config.send) {
      const track = this.sourceTrack(publicationId);
      if (!track || connection.senders.has(publicationId)) continue;
      const transceiver = pc.getTransceivers().find(item => item.direction !== "stopped" && !item.sender.track &&
        (config.transport !== "sfu" || connection.remote.get(item.mid ?? "") === publicationId));
      if (!transceiver && config.transport === "sfu") continue;
      const stream = new MediaStream([track]);
      const sender = transceiver?.sender ?? pc.addTrack(track, stream);
      if (transceiver) {
        await this.wait(connection, () => sender.replaceTrack(track));
        if (!connection.config.send.includes(publicationId) || this.sourceTrack(publicationId) !== track) { pc.removeTrack(sender); continue; }
        sender.setStreams(stream);
        transceiver.direction = transceiver.direction === "recvonly" || transceiver.direction === "sendrecv" ? "sendrecv" : "sendonly";
      }
      connection.senders.set(publicationId, sender); connection.dirty = true;
    }
    if (this.isOfferer(config)) {
      const receiving = pc.getTransceivers().filter(item => item.direction !== "stopped" && (item.direction === "recvonly" || item.direction === "sendrecv")).length;
      for (let index = receiving; index < config.receive.length; index++) { pc.addTransceiver("audio", { direction: "recvonly" }); connection.dirty = true; }
    }
  }

  private removePlayback(binding: Received): void {
    if (binding.audio) { binding.audio.pause(); binding.audio.srcObject = null; binding.audio.remove(); binding.audio = undefined; }
    binding.blocked = false;
  }
  private removeReceived(key: string): void {
    const binding = this.received.get(key);
    if (binding) this.removePlayback(binding);
    this.received.delete(key);
  }
  private bindReceivers(connection: Connection): void {
    const retained = new Set<string>();
    for (const transceiver of connection.pc.getTransceivers()) {
      const publicationId = connection.remote.get(transceiver.mid ?? ""), track = transceiver.receiver.track;
      if (!publicationId || !connection.config.receive.includes(publicationId) || track.kind !== "audio" || track.readyState === "ended") continue;
      const key = `${connection.config.connectionId}/${publicationId}`;
      retained.add(key);
      let binding = this.received.get(key);
      if (binding?.track !== track) {
        this.removeReceived(key);
        binding = { connectionId: connection.config.connectionId, publicationId, track, blocked: false };
        this.received.set(key, binding);
      }
      if (!connection.config.pending && !binding.audio) {
        const audio = binding.audio = new Audio();
        audio.autoplay = true; audio.hidden = true;
        this.syncPlaybackMute();
        audio.srcObject = new MediaStream([track]); document.body.append(audio);
        void this.play(binding);
      }
    }
    for (const [key, binding] of this.received) if (binding.connectionId === connection.config.connectionId && !retained.has(key)) this.removeReceived(key);
  }
  private async play(binding: Received): Promise<void> {
    const audio = binding.audio;
    if (!audio) return;
    try { await audio.play(); if (binding.audio !== audio) return; binding.blocked = false; }
    catch { if (binding.audio !== audio) return; binding.blocked = true; }
    this.changed();
  }
  async resume(): Promise<void> { await Promise.all([...this.received.values()].map(binding => this.play(binding))); }
  mute(peerId: string, muted: boolean): void {
    if (muted) this.muted.add(peerId); else this.muted.delete(peerId);
    this.syncPlaybackMute();
  }
  deafen(deafened: boolean): void {
    this.deafened = deafened;
    this.syncPlaybackMute();
  }
  private syncPlaybackMute(): void {
    for (const binding of this.received.values()) if (binding.audio) {
      const publisher = this.state?.publications.find(pub => pub.id === binding.publicationId)?.peerId;
      binding.audio.muted = this.deafened || !!publisher && this.muted.has(publisher);
    }
  }

  private async description(connection: Connection, sdp: RTCSessionDescriptionInit, revision: number): Promise<VoiceDescription> {
    connection.descriptionSent = false;
    await this.wait(connection, () => connection.pc.setLocalDescription(sdp));
    const local = connection.pc.localDescription!;
    const tracks: VoiceDescription["tracks"] = [];
    for (const [publicationId, sender] of connection.senders) {
      const mid = connection.pc.getTransceivers().find(item => item.sender === sender)?.mid;
      if (mid === null || mid === undefined || !connection.config.send.includes(publicationId)) continue;
      tracks.push({ mid, publicationId });
      const parameters = sender.getParameters();
      if (parameters.encodings.length) { parameters.encodings[0]!.maxBitrate = 32_000; await this.wait(connection, () => sender.setParameters(parameters)); }
    }
    return { revision, sdp: { type: local.type as "offer" | "answer", sdp: local.sdp }, tracks };
  }
  private sendDescription(connection: Connection, description: VoiceDescription): void {
    if (!this.signal(connection, { description })) throw new Error("Voice signaling unavailable");
    connection.descriptionSent = true; this.flushCandidates(connection);
  }

  async reconcile(): Promise<void> {
    const generation = this.generation;
    for (const config of this.state?.connections ?? []) {
      if (generation !== this.generation) return;
      const connection = this.connections.get(config.connectionId) ?? this.create(config);
      try {
        await this.syncSenders(connection);
        this.bindReceivers(connection);
        if (connection.pc.connectionState === "connected") this.report(connection, "connected");
        else if (connection.pc.connectionState === "failed" || connection.pc.connectionState === "closed") { this.report(connection, "failed"); continue; }
        if (!connection.dirty || connection.pc.signalingState !== "stable") continue;
        if (this.isOfferer(config)) {
          connection.dirty = false;
          const offer = await this.wait(connection, () => connection.pc.createOffer());
          this.sendDescription(connection, await this.description(connection, offer, ++connection.offerRevision));
        } else if (!connection.requested) {
          if (this.signal(connection, { renegotiate: true })) connection.requested = true;
        }
      } catch (error) { if (this.current(connection)) { this.report(connection, "failed"); throw error; } }
    }
  }

  async receive(message: Extract<ClientMessage, { type: "room-voice-signal" }>): Promise<void> {
    const connection = this.connections.get(message.connectionId);
    if (!connection) return;
    try { await this.receiveSignal(connection, message); }
    catch (error) { if (this.current(connection)) { this.report(connection, "failed"); throw error; } }
  }
  private async receiveSignal(connection: Connection, message: VoiceSignal): Promise<void> {
    if (message.renegotiate) { if (this.isOfferer(connection.config)) connection.dirty = true; return; }
    if (message.candidate) {
      if (connection.pc.remoteDescription) await this.wait(connection, () => addRemoteIceCandidate(connection.pc, message.candidate!));
      else if (connection.queuedCandidates.length < 64) connection.queuedCandidates.push(message.candidate);
      else throw new Error("Too many voice ICE candidates");
      return;
    }
    const description = message.description;
    if (!description) return;
    const offer = description.sdp.type === "offer";
    if (offer === this.isOfferer(connection.config) || description.revision <= connection.remoteRevision ||
      (!offer && (description.revision !== connection.offerRevision || connection.pc.signalingState !== "have-local-offer"))) return;
    const mids = new Set<string>();
    const publications = new Set<string>();
    const allowed = connection.config.transport === "sfu" && offer ? [...connection.config.send, ...connection.config.receive] : connection.config.receive;
    for (const track of description.tracks) {
      if (mids.has(track.mid) || publications.has(track.publicationId)) throw new Error("Duplicate voice track mapping");
      mids.add(track.mid); publications.add(track.publicationId);
    }
    await this.wait(connection, () => connection.pc.setRemoteDescription(description.sdp));
    // A newer authority state can retire a source while its SDP is in flight.
    // Complete transport negotiation, but never bind from the manifest alone.
    connection.remote = new Map(description.tracks.filter(track => allowed.includes(track.publicationId)).map(track => [track.mid, track.publicationId]));
    connection.remoteRevision = description.revision;
    for (const candidate of connection.queuedCandidates.splice(0)) await this.wait(connection, () => addRemoteIceCandidate(connection.pc, candidate));
    this.bindReceivers(connection);
    if (offer) {
      connection.requested = false;
      await this.syncSenders(connection);
      connection.dirty = false;
      const answer = await this.wait(connection, () => connection.pc.createAnswer());
      this.sendDescription(connection, await this.description(connection, answer, description.revision));
    }
  }

  private retire(connection: Connection): void {
    this.connections.delete(connection.config.connectionId);
    connection.lifetime.abort(); connection.candidates.discard(); connection.pc.close();
    for (const [key, binding] of this.received) if (binding.connectionId === connection.config.connectionId) this.removeReceived(key);
  }
  close(): void {
    this.generation++;
    this.state = null; this.stopMicrophone();
    for (const connection of this.connections.values()) this.retire(connection);
    for (const key of this.received.keys()) this.removeReceived(key);
  }
}
