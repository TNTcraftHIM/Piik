import type {
  ServerMessage,
  SfuMedia,
  SfuSignalMessage,
} from "../../shared/protocol";

export type SfuConnectionConfig = Omit<
  Extract<ServerMessage, { type: "sfu-config" }>,
  "type"
>;

interface SfuPeerEvents {
  send: (message: SfuSignalMessage) => boolean;
  onState: (state: RTCPeerConnectionState) => void;
  onTrack?: (event: RTCTrackEvent) => void;
}

// The room WebSocket owns signaling; losing it does not retire healthy media.
export class SfuPeer {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  private localCandidates: NonNullable<SfuSignalMessage["candidate"]>[] = [];
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private descriptionSent = false;
  private pendingDescription: Pick<
    SfuSignalMessage,
    "kind" | "description" | "media"
  > | null = null;
  private closed = false;
  private signalTail: Promise<void> = Promise.resolve();

  constructor(
    private config: SfuConnectionConfig,
    private readonly events: SfuPeerEvents,
  ) {
    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed || !candidate || candidate.protocol === "tcp") return;
      const value = { ...candidate.toJSON(), candidate: candidate.candidate };
      if (this.localCandidates.length >= 64) this.events.onState("failed");
      else {
        this.localCandidates.push(value);
        this.flushSignaling();
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.closed) this.events.onState(this.pc.connectionState);
    };
    this.pc.ontrack = (event) => {
      if (!this.closed) this.events.onTrack?.(event);
    };
  }

  updateConfig(config: SfuConnectionConfig): void {
    if (
      this.config.connectionId === config.connectionId &&
      this.config.publicationGeneration === config.publicationGeneration
    ) {
      this.config = config;
      this.flushSignaling();
    }
  }

  send(
    payload: Pick<
      SfuSignalMessage,
      "kind" | "description" | "candidate" | "media"
    >,
  ): boolean {
    return (
      !this.closed &&
      this.events.send({
        type: "sfu-signal",
        revision: this.config.revision,
        publicationGeneration: this.config.publicationGeneration,
        connectionId: this.config.connectionId,
        ...payload,
      })
    );
  }

  async sendDescription(
    description: RTCSessionDescriptionInit,
    media?: SfuMedia,
  ): Promise<void> {
    this.descriptionSent = false;
    await this.pc.setLocalDescription(description);
    if (this.closed) return;
    const local = this.pc.localDescription;
    if (!local || (local.type !== "offer" && local.type !== "answer")) {
      throw new Error("SFU has no local description");
    }
    this.pendingDescription = {
      kind: "description",
      description: { type: local.type, sdp: local.sdp },
      ...(media ? { media } : {}),
    };
    this.flushSignaling();
  }

  private flushSignaling(): void {
    if (this.closed) return;
    if (this.pendingDescription) {
      if (!this.send(this.pendingDescription)) return;
      this.pendingDescription = null;
      this.descriptionSent = true;
    }
    if (!this.descriptionSent) return;
    while (this.localCandidates[0]) {
      if (!this.send({ kind: "candidate", candidate: this.localCandidates[0] }))
        return;
      this.localCandidates.shift();
    }
  }

  acceptSignal(
    message: SfuSignalMessage,
    onDescription: (description: RTCSessionDescriptionInit) => Promise<void>,
    onLayers?: (activeCount: number) => Promise<void>,
  ): Promise<void> {
    if (
      this.closed ||
      message.connectionId !== this.config.connectionId ||
      message.publicationGeneration !== this.config.publicationGeneration
    )
      return Promise.resolve();
    const work = async (): Promise<void> => {
      if (this.closed) return;
      if (message.kind === "layers" && message.activeCount !== undefined) {
        await onLayers?.(message.activeCount);
      } else if (message.kind === "description" && message.description) {
        await onDescription(message.description);
        for (const candidate of this.remoteCandidates.splice(0))
          await this.pc.addIceCandidate(candidate);
      } else if (message.kind === "candidate" && message.candidate) {
        if (this.pc.remoteDescription)
          await this.pc.addIceCandidate(message.candidate);
        else if (this.remoteCandidates.length < 64)
          this.remoteCandidates.push(message.candidate);
        else throw new Error("Too many SFU ICE candidates");
      }
    };
    const next = this.signalTail.then(work);
    this.signalTail = next.catch(() => undefined);
    return next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.localCandidates = [];
    this.remoteCandidates = [];
    this.pendingDescription = null;
    this.pc.close();
  }
}
