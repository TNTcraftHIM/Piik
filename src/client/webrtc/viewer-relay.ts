import type { IceConfig, SignalPayload } from "../../shared/protocol";
import type { QualityProfile } from "../media/quality";
import type { PeerSnapshot } from "../types";
import { HostPeer } from "./host-peer";

interface ViewerRelayEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate?: (snapshot: PeerSnapshot | null) => void;
}

export class ViewerRelay {
  private childPeerId: string | null = null;
  private stream: MediaStream | null = null;
  private peer: HostPeer | null = null;
  private snapshot: PeerSnapshot | null = null;
  private syncQueue = Promise.resolve();
  private disposed = false;

  constructor(
    private iceConfig: IceConfig,
    private desiredProfile: QualityProfile,
    private readonly events: ViewerRelayEvents,
  ) {}

  getSnapshot(): PeerSnapshot | null {
    return this.snapshot
      ? { ...this.snapshot, metrics: { ...this.snapshot.metrics } }
      : null;
  }

  setChild(childPeerId: string | null): void {
    if (this.disposed) {
      return;
    }
    if (this.childPeerId === childPeerId) {
      if (
        childPeerId &&
        this.stream &&
        (!this.peer || !this.peer.isConnected())
      ) {
        this.disposePeer();
        this.startPeer(childPeerId, this.stream);
      }
      return;
    }
    this.disposePeer();
    this.childPeerId = childPeerId;
    if (childPeerId && this.stream) {
      this.startPeer(childPeerId, this.stream);
    }
  }

  setStream(stream: MediaStream): void {
    if (this.disposed) {
      return;
    }
    this.stream = stream;
    this.syncQueue = this.syncQueue
      .then(() => this.syncStream(stream))
      .catch(() => undefined);
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    this.desiredProfile = profile;
    const result = this.syncQueue.then(() => this.syncProfile(profile));
    this.syncQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch(() => false);
  }

  async acceptSignal(
    fromPeerId: string,
    payload: SignalPayload,
  ): Promise<void> {
    if (fromPeerId !== this.childPeerId) {
      return;
    }
    await this.peer?.acceptSignal(payload);
  }

  async recover(
    fromPeerId: string,
    connectionId: string,
    rebuild: boolean,
  ): Promise<void> {
    const stream = this.stream;
    const peer = this.peer;
    if (this.disposed || !stream || fromPeerId !== this.childPeerId) {
      return;
    }
    if (rebuild) {
      if (peer && peer.connectionId !== connectionId) {
        return;
      }
      this.disposePeer();
      this.startPeer(fromPeerId, stream);
      return;
    }
    if (!peer || peer.connectionId !== connectionId) {
      return;
    }
    if (await peer.restartIce()) {
      return;
    }
    if (this.peer === peer) {
      this.disposePeer();
      this.startPeer(fromPeerId, stream);
    }
  }

  updateIceConfig(iceConfig: IceConfig): void {
    this.iceConfig = iceConfig;
    this.peer?.updateIceConfig(iceConfig);
  }

  stop(): void {
    this.stream = null;
    this.disposePeer();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stream = null;
    this.childPeerId = null;
    this.disposePeer();
  }

  private async syncStream(stream: MediaStream): Promise<void> {
    const childPeerId = this.childPeerId;
    if (this.disposed || this.stream !== stream || !childPeerId) {
      return;
    }
    const peer = this.peer;
    if (!peer) {
      this.startPeer(childPeerId, stream);
      return;
    }

    let replaced = false;
    try {
      replaced = await peer.replaceStream(stream);
    } catch {
      // Rebuilding below is safer than leaving a stopped upstream track.
    }
    if (
      replaced ||
      this.disposed ||
      this.peer !== peer ||
      this.stream !== stream ||
      this.childPeerId !== childPeerId
    ) {
      return;
    }
    this.disposePeer();
    this.startPeer(childPeerId, stream);
  }

  private async syncProfile(profile: QualityProfile): Promise<boolean> {
    if (this.disposed || this.desiredProfile !== profile) {
      return false;
    }
    const peer = this.peer;
    if (!peer) {
      return true;
    }
    return peer.updateProfile(this.desiredProfile);
  }

  private startPeer(
    childPeerId: string,
    stream: MediaStream,
    attempt = 0,
  ): void {
    if (
      this.disposed ||
      this.peer ||
      this.stream !== stream ||
      this.childPeerId !== childPeerId
    ) {
      return;
    }

    let peer: HostPeer;
    peer = new HostPeer(
      childPeerId,
      this.iceConfig,
      stream,
      this.desiredProfile,
      {
        sendSignal: (targetPeerId, payload) =>
          !this.disposed &&
          this.peer === peer &&
          this.childPeerId === targetPeerId
            ? this.events.sendSignal(targetPeerId, payload)
            : false,
        onUpdate: (snapshot) => {
          if (
            !this.disposed &&
            this.peer === peer &&
            this.childPeerId === childPeerId &&
            snapshot.peerId === childPeerId &&
            snapshot.connectionId === peer.connectionId
          ) {
            this.snapshot = {
              ...snapshot,
              metrics: { ...snapshot.metrics },
            };
            this.events.onUpdate?.(this.getSnapshot());
          }
        },
      },
    );
    this.peer = peer;
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (started || this.peer !== peer) {
          return;
        }
        this.disposePeer();
        if (
          attempt < 1 &&
          !this.disposed &&
          this.stream === stream &&
          this.childPeerId === childPeerId
        ) {
          window.setTimeout(() => {
            this.startPeer(childPeerId, stream, attempt + 1);
          }, 500);
        }
      });
  }

  private disposePeer(): void {
    const peer = this.peer;
    this.peer = null;
    this.snapshot = null;
    this.events.onUpdate?.(null);
    peer?.dispose();
  }
}
