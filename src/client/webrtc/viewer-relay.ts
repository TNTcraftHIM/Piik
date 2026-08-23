import type {
  IceConfig,
  PreparedRouteCandidate,
  ServerMessage,
  SignalPayload,
} from "../../shared/protocol";
import {
  resolveScreenAudioQuality,
  type QualityProfile,
} from "../media/quality";
import type { PeerSnapshot } from "../types";
import { HostPeer } from "./host-peer";
import { MAX_ENDPOINT_MEDIA_CHILDREN } from "./media-assignment";

interface ViewerRelayEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate?: (snapshot: PeerSnapshot | null) => void;
}
type SelectedEdgeTurn = Extract<
  ServerMessage,
  { type: "selected-edge-turn"; edgeKind: "peer-selected" }
>;
interface PreparedChild {
  revision: number;
  childPeerId: string;
  candidate: PreparedRouteCandidate;
  peer: HostPeer;
  failed: boolean;
  replacesConnectionId: string | null;
}

export class ViewerRelay {
  private childPeerIds: string[] = [];
  private stream: MediaStream | null = null;
  private readonly peers = new Map<string, HostPeer>();
  private readonly snapshots = new Map<string, PeerSnapshot>();
  private preparedChild: PreparedChild | null = null;
  private preparedRevision: number | null = null;
  private preparedCandidate: PreparedRouteCandidate | null = null;
  private plannedChildPeerIds: string[] = [];
  private syncQueue = Promise.resolve();
  private disposed = false;

  constructor(
    private iceConfig: IceConfig,
    private desiredProfile: QualityProfile,
    private readonly events: ViewerRelayEvents,
    private readonly maxMediaEdges = MAX_ENDPOINT_MEDIA_CHILDREN,
  ) {}

  getSnapshot(childPeerId?: string): PeerSnapshot | null {
    const peerId =
      childPeerId ??
      this.childPeerIds.find((candidate) => this.snapshots.has(candidate));
    const snapshot = peerId ? this.snapshots.get(peerId) : undefined;
    return snapshot
      ? { ...snapshot, metrics: { ...snapshot.metrics } }
      : null;
  }

  prepareSelectedEdgeTurn(
    message: SelectedEdgeTurn,
    parentPeerId: string,
    routeRevision: number,
    now = Date.now(),
  ): boolean {
    if (
      this.disposed ||
      message.parentPeerId !== parentPeerId ||
      message.revision !== routeRevision ||
      Date.parse(message.expiresAt) <= now ||
      this.preparedRevision !== routeRevision ||
      this.preparedCandidate?.transport !== "selected-turn" ||
      this.preparedCandidate.childPeerId !== message.viewerPeerId ||
      this.preparedCandidate.connectionId !== message.newConnectionId
    ) {
      return false;
    }
    const prepared = this.preparedChild;
    if (prepared?.peer.connectionId === message.newConnectionId) {
      return !prepared.failed;
    }
    const stream = this.stream;
    if (!stream) return false;
    this.discardPreparedPeer();
    this.startPreparedChild(
      message.revision,
      this.preparedCandidate,
      stream,
      message,
    );
    return true;
  }

  prepareChild(
    revision: number,
    candidate: PreparedRouteCandidate,
    plannedChildPeerIds: readonly string[],
  ): boolean {
    const stream = this.stream;
    const planned = [...new Set(plannedChildPeerIds)];
    if (
      this.disposed ||
      !stream ||
      candidate.transport === "sfu" ||
      !planned.includes(candidate.childPeerId) ||
      planned.length !== plannedChildPeerIds.length ||
      planned.length < this.childPeerIds.length ||
      planned.length > this.childPeerIds.length + 1 ||
      planned.length > this.maxMediaEdges ||
      this.childPeerIds.some((peerId) => !planned.includes(peerId))
    ) {
      this.discardPreparedChild();
      return false;
    }
    if (
      this.preparedRevision === revision &&
      sameCandidate(this.preparedCandidate, candidate) &&
      samePeerIds(this.plannedChildPeerIds, planned)
    ) {
      return this.preparedChild ? !this.preparedChild.failed : true;
    }

    this.discardPreparedChild();
    this.preparedRevision = revision;
    this.preparedCandidate = { ...candidate };
    this.plannedChildPeerIds = planned;
    if (candidate.transport === "direct") {
      this.startPreparedChild(revision, candidate, stream);
    }
    return true;
  }

  activateChildren(revision: number, childPeerIds: readonly string[]): void {
    const prepared = this.preparedChild;
    const extendsActive =
      childPeerIds.length === this.childPeerIds.length + 1 &&
      this.childPeerIds.every((peerId) => childPeerIds.includes(peerId));
    const replacedPeer = prepared
      ? this.peers.get(prepared.childPeerId) ?? null
      : null;
    const replacesActive =
      replacedPeer?.connectionId === prepared?.replacesConnectionId;
    let promotedPeerId: string | null = null;
    if (
      prepared?.revision === revision &&
      !prepared.failed &&
      prepared.candidate.connectionId === prepared.peer.connectionId &&
      childPeerIds.includes(prepared.childPeerId) &&
      (extendsActive || replacesActive)
    ) {
      this.preparedChild = null;
      this.preparedRevision = null;
      this.preparedCandidate = null;
      this.plannedChildPeerIds = [];
      this.peers.set(prepared.childPeerId, prepared.peer);
      replacedPeer?.dispose();
      this.snapshots.set(prepared.childPeerId, prepared.peer.getSnapshot());
      promotedPeerId = prepared.childPeerId;
    } else {
      this.discardPreparedChild();
    }
    this.reconcileChildren(childPeerIds, promotedPeerId);
  }

  discardPreparedChild(): void {
    this.preparedRevision = null;
    this.preparedCandidate = null;
    this.plannedChildPeerIds = [];
    this.discardPreparedPeer();
  }

  private discardPreparedPeer(): void {
    const prepared = this.preparedChild;
    this.preparedChild = null;
    prepared?.peer.dispose();
  }

  setChildren(childPeerIds: readonly string[]): void {
    this.reconcileChildren(childPeerIds, null);
  }

  private reconcileChildren(
    childPeerIds: readonly string[],
    promotedPeerId: string | null,
  ): void {
    if (this.disposed) {
      return;
    }
    const nextChildPeerIds = [...new Set(childPeerIds)].slice(
      0,
      this.maxMediaEdges,
    );
    for (const childPeerId of this.childPeerIds) {
      if (!nextChildPeerIds.includes(childPeerId)) {
        this.disposePeer(childPeerId);
      }
    }
    this.childPeerIds = nextChildPeerIds;
    for (const childPeerId of this.childPeerIds) {
      const peer = this.peers.get(childPeerId);
      if (
        this.stream &&
        childPeerId !== promotedPeerId &&
        (!peer || !peer.isConnected())
      ) {
        this.disposePeer(childPeerId);
        this.startPeer(childPeerId, this.stream);
      }
    }
  }

  setStream(stream: MediaStream): void {
    if (this.disposed) {
      return;
    }
    const replacePrepared = this.stream !== null && this.stream !== stream;
    this.stream = stream;
    this.syncQueue = this.syncQueue
      .then(() => this.syncStream(stream, replacePrepared))
      .catch(() => undefined);
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    if (
      this.disposed ||
      (this.stream !== null &&
        resolveScreenAudioQuality(profile.screenAudioQuality) !==
          resolveScreenAudioQuality(this.desiredProfile.screenAudioQuality))
    ) {
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

  getSignalRouteRevision(
    fromPeerId: string,
    connectionId: string,
    activeRevision: number,
  ): number {
    const prepared = this.preparedChild;
    return prepared?.childPeerId === fromPeerId &&
      !prepared.failed &&
      prepared.peer.connectionId === connectionId
      ? prepared.revision
      : activeRevision;
  }

  async acceptSignal(
    fromPeerId: string,
    payload: SignalPayload,
    routeRevision: number,
  ): Promise<boolean> {
    const prepared = this.preparedChild;
    if (
      prepared?.revision === routeRevision &&
      !prepared.failed &&
      prepared.childPeerId === fromPeerId &&
      prepared.peer.connectionId === payload.connectionId
    ) {
      await prepared.peer.acceptSignal(payload);
      return true;
    }
    const peer = this.peers.get(fromPeerId);
    if (
      !this.childPeerIds.includes(fromPeerId) ||
      !peer ||
      peer.connectionId !== payload.connectionId
    ) {
      return false;
    }
    await peer.acceptSignal(payload);
    return true;
  }

  async recover(
    fromPeerId: string,
    connectionId: string,
    rebuild: boolean,
  ): Promise<void> {
    const stream = this.stream;
    const peer = this.peers.get(fromPeerId);
    if (this.disposed || !stream || !this.childPeerIds.includes(fromPeerId)) {
      return;
    }
    if (rebuild) {
      if (peer && peer.connectionId !== connectionId) {
        return;
      }
      this.disposePeer(fromPeerId);
      this.startPeer(fromPeerId, stream);
      return;
    }
    if (!peer || peer.connectionId !== connectionId) {
      return;
    }
    if (await peer.restartIce()) {
      return;
    }
    if (this.peers.get(fromPeerId) === peer) {
      this.disposePeer(fromPeerId);
      this.startPeer(fromPeerId, stream);
    }
  }

  updateIceConfig(iceConfig: IceConfig): void {
    this.iceConfig = iceConfig;
    for (const peer of this.peers.values()) {
      peer.updateIceConfig(iceConfig);
    }
    this.preparedChild?.peer.updateIceConfig(iceConfig);
  }

  stop(): void {
    this.stream = null;
    this.discardPreparedChild();
    this.disposePeers();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stream = null;
    this.discardPreparedChild();
    this.childPeerIds = [];
    this.disposePeers();
  }

  private startPreparedChild(
    revision: number,
    candidate: PreparedRouteCandidate,
    stream: MediaStream,
    selectedTurn?: SelectedEdgeTurn,
  ): void {
    const peer = this.createPeer(
      candidate.childPeerId,
      stream,
      candidate.connectionId,
      selectedTurn,
    );
    this.preparedChild = {
      revision,
      childPeerId: candidate.childPeerId,
      candidate: { ...candidate },
      peer,
      failed: false,
      replacesConnectionId:
        this.peers.get(candidate.childPeerId)?.connectionId ?? null,
    };
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (!started && this.preparedChild?.peer === peer) {
          this.failPreparedChild(peer);
        }
      });
  }

  private async syncStream(
    stream: MediaStream,
    replacePrepared: boolean,
  ): Promise<void> {
    if (this.disposed || this.stream !== stream) {
      return;
    }
    const prepared = replacePrepared ? this.preparedChild : null;
    if (prepared && !(await this.replacePeerStream(prepared.peer, stream))) {
      this.failPreparedChild(prepared.peer);
    }
    if (this.disposed || this.stream !== stream) {
      return;
    }
    await Promise.all(
      this.childPeerIds.map((childPeerId) =>
        this.syncPeerStream(childPeerId, stream),
      ),
    );
  }

  private async syncPeerStream(
    childPeerId: string,
    stream: MediaStream,
  ): Promise<void> {
    const peer = this.peers.get(childPeerId);
    if (!peer) {
      this.startPeer(childPeerId, stream);
      return;
    }

    const replaced = await this.replacePeerStream(peer, stream);
    if (
      replaced ||
      this.disposed ||
      this.peers.get(childPeerId) !== peer ||
      this.stream !== stream ||
      !this.childPeerIds.includes(childPeerId)
    ) {
      return;
    }
    this.disposePeer(childPeerId);
    this.startPeer(childPeerId, stream);
  }

  private async syncProfile(profile: QualityProfile): Promise<boolean> {
    if (this.disposed || this.desiredProfile !== profile) {
      return false;
    }
    const prepared = this.preparedChild;
    const peers = [
      ...this.peers.values(),
      ...(prepared ? [prepared.peer] : []),
    ];
    if (peers.length === 0) {
      return true;
    }
    const results = await Promise.all(
      peers.map(async (peer) =>
        (this.peers.get(peer.peerId) !== peer &&
          this.preparedChild?.peer !== peer) ||
        (await peer.updateProfile(this.desiredProfile)),
      ),
    );
    return this.desiredProfile === profile && results.every(Boolean);
  }

  private async replacePeerStream(
    peer: HostPeer,
    stream: MediaStream,
  ): Promise<boolean> {
    try {
      return await peer.replaceStream(stream);
    } catch {
      return false;
    }
  }

  private startPeer(
    childPeerId: string,
    stream: MediaStream,
    attempt = 0,
  ): void {
    if (
      this.disposed ||
      this.peers.has(childPeerId) ||
      this.stream !== stream ||
      !this.childPeerIds.includes(childPeerId)
    ) {
      return;
    }

    const peer = this.createPeer(childPeerId, stream);
    this.peers.set(childPeerId, peer);
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (started || this.peers.get(childPeerId) !== peer) {
          return;
        }
        this.disposePeer(childPeerId);
        if (
          attempt < 1 &&
          !this.disposed &&
          this.stream === stream &&
          this.childPeerIds.includes(childPeerId)
        ) {
          window.setTimeout(() => {
            this.startPeer(childPeerId, stream, attempt + 1);
          }, 500);
        }
      });
  }

  private createPeer(
    childPeerId: string,
    stream: MediaStream,
    connectionId?: string,
    selectedTurn?: SelectedEdgeTurn,
  ): HostPeer {
    let peer: HostPeer;
    peer = new HostPeer(
      childPeerId,
      selectedTurn
        ? { iceServers: [selectedTurn.iceServer] }
        : this.iceConfig,
      stream,
      this.desiredProfile,
      {
        sendSignal: (targetPeerId, payload) =>
          !this.disposed &&
          (this.peers.get(childPeerId) === peer ||
            this.preparedChild?.peer === peer) &&
          childPeerId === targetPeerId
            ? this.events.sendSignal(targetPeerId, payload)
            : false,
        onUpdate: (snapshot) => {
          if (this.preparedChild?.peer === peer) {
            if (snapshot.connectionState === "failed") {
              this.failPreparedChild(peer);
            }
            return;
          }
          if (
            !this.disposed &&
            this.peers.get(childPeerId) === peer &&
            this.childPeerIds.includes(childPeerId) &&
            snapshot.peerId === childPeerId &&
            snapshot.connectionId === peer.connectionId
          ) {
            this.snapshots.set(childPeerId, {
              ...snapshot,
              metrics: { ...snapshot.metrics },
            });
            this.events.onUpdate?.(this.getSnapshot());
          }
        },
      },
      selectedTurn !== undefined,
      connectionId,
    );
    return peer;
  }

  private failPreparedChild(peer: HostPeer): void {
    const prepared = this.preparedChild;
    if (prepared?.peer !== peer) {
      return;
    }
    prepared.failed = true;
    peer.dispose();
  }

  private disposePeers(): void {
    for (const childPeerId of [...this.peers.keys()]) {
      this.disposePeer(childPeerId);
    }
  }

  private disposePeer(childPeerId: string): void {
    const peer = this.peers.get(childPeerId);
    this.peers.delete(childPeerId);
    this.snapshots.delete(childPeerId);
    this.events.onUpdate?.(this.getSnapshot());
    peer?.dispose();
  }

}

function sameCandidate(
  left: PreparedRouteCandidate | null,
  right: PreparedRouteCandidate,
): boolean {
  return (
    left?.childPeerId === right.childPeerId &&
    left.connectionId === right.connectionId &&
    left.transport === right.transport
  );
}

function samePeerIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((peerId, index) => peerId === right[index])
  );
}
