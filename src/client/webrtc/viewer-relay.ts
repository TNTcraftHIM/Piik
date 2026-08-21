import type {
  IceConfig,
  ServerMessage,
  SignalPayload,
} from "../../shared/protocol";
import {
  resolveScreenAudioQuality,
  type QualityProfile,
} from "../media/quality";
import type { PeerSnapshot } from "../types";
import { HostPeer } from "./host-peer";
import { MAX_VIEWER_MEDIA_CHILDREN } from "./media-assignment";

interface ViewerRelayEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate?: (snapshot: PeerSnapshot | null) => void;
  onSelectedEdgeFailed?: (
    childPeerId: string,
    connectionId: string,
    revision: number,
  ) => void;
}
type SelectedEdgeTurn = Extract<
  ServerMessage,
  { type: "selected-edge-turn"; edgeKind: "peer-selected" }
>;
interface SelectedChildConnection {
  peerId: string;
  connectionId: string;
  revision: number;
  pendingCarryRevision: number | null;
}
interface PreparedChild {
  revision: number;
  childPeerId: string;
  peer: HostPeer;
}
type FailedPreparedChild = Omit<PreparedChild, "peer"> & { connectionId: string };

export class ViewerRelay {
  private childPeerIds: string[] = [];
  private stream: MediaStream | null = null;
  private readonly peers = new Map<string, HostPeer>();
  private readonly snapshots = new Map<string, PeerSnapshot>();
  private readonly retiredConnections = new Map<string, string>();
  private selectedChildConnection: SelectedChildConnection | null = null;
  private preparedChild: PreparedChild | null = null;
  private failedPreparedChild: FailedPreparedChild | null = null;
  private syncQueue = Promise.resolve();
  private disposed = false;

  constructor(
    private iceConfig: IceConfig,
    private desiredProfile: QualityProfile,
    private readonly events: ViewerRelayEvents,
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

  startSelectedEdgeTurn(
    message: SelectedEdgeTurn,
    parentPeerId: string,
    routeRevision: number,
    now = Date.now(),
  ): boolean {
    const stream = this.stream;
    const currentPeer = this.peers.get(message.viewerPeerId);
    const connectionId =
      currentPeer?.connectionId ??
      this.retiredConnections.get(message.viewerPeerId);
    const selected = this.selectedChildConnection;
    if (
      selected?.peerId === message.viewerPeerId &&
      selected.connectionId === message.newConnectionId &&
      currentPeer?.connectionId === selected.connectionId &&
      message.parentPeerId === parentPeerId &&
      message.revision >= selected.revision
    ) {
      selected.revision = message.revision;
      selected.pendingCarryRevision = message.revision;
      return true;
    }
    const retainedChildPeerIds = selected
      ? this.childPeerIds.filter((peerId) => peerId !== selected.peerId)
      : this.childPeerIds;
    if (
      this.disposed ||
      !stream ||
      message.parentPeerId !== parentPeerId ||
      message.revision !== routeRevision ||
      Date.parse(message.expiresAt) <= now ||
      connectionId !== message.oldConnectionId ||
      (!retainedChildPeerIds.includes(message.viewerPeerId) &&
        retainedChildPeerIds.length >= MAX_VIEWER_MEDIA_CHILDREN)
    ) {
      return false;
    }
    if (selected) {
      this.clearSelectedEdgeTurn();
    }
    if (!this.childPeerIds.includes(message.viewerPeerId)) {
      this.childPeerIds.push(message.viewerPeerId);
    }
    this.disposePeer(message.viewerPeerId);
    this.selectedChildConnection = {
      peerId: message.viewerPeerId,
      connectionId: message.newConnectionId,
      revision: message.revision,
      pendingCarryRevision: null,
    };
    this.startPeer(message.viewerPeerId, stream, 0, message);
    return true;
  }

  clearSelectedEdgeTurn(): void {
    const selected = this.selectedChildConnection;
    if (!selected) {
      return;
    }
    this.selectedChildConnection = null;
    this.childPeerIds = this.childPeerIds.filter(
      (peerId) => peerId !== selected.peerId,
    );
    this.disposePeer(selected.peerId);
  }

  acceptActiveRevision(revision: number): void {
    const selected = this.selectedChildConnection;
    if (!selected) {
      return;
    }
    if (selected.pendingCarryRevision === revision) {
      selected.pendingCarryRevision = null;
      return;
    }
    this.clearSelectedEdgeTurn();
  }

  prepareChild(
    revision: number,
    plannedChildPeerIds: readonly string[],
  ): boolean {
    const stream = this.stream;
    const planned = [...new Set(plannedChildPeerIds)];
    const childPeerId = planned.find(
      (peerId) => !this.childPeerIds.includes(peerId),
    );
    if (
      this.disposed ||
      !stream ||
      planned.length !== plannedChildPeerIds.length ||
      planned.length !== this.childPeerIds.length + 1 ||
      planned.length > MAX_VIEWER_MEDIA_CHILDREN ||
      this.childPeerIds.some((peerId) => !planned.includes(peerId)) ||
      !childPeerId ||
      this.peers.has(childPeerId)
    ) {
      this.discardPreparedChild();
      return false;
    }
    if (
      this.preparedChild?.revision === revision &&
      this.preparedChild.childPeerId === childPeerId
    ) {
      return true;
    }
    if (
      this.failedPreparedChild?.revision === revision &&
      this.failedPreparedChild.childPeerId === childPeerId
    ) {
      return false;
    }

    this.discardPreparedChild();
    const peer = this.createPeer(childPeerId, stream);
    this.preparedChild = { revision, childPeerId, peer };
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (!started && this.preparedChild?.peer === peer) {
          this.failPreparedChild(peer);
        }
      });
    return true;
  }

  activateChildren(revision: number, childPeerIds: readonly string[]): void {
    const prepared = this.preparedChild;
    const failed = this.failedPreparedChild;
    const extendsActive =
      childPeerIds.length === this.childPeerIds.length + 1 &&
      this.childPeerIds.every((peerId) => childPeerIds.includes(peerId));
    let promotedPeerId: string | null = null;
    if (
      prepared?.revision === revision &&
      childPeerIds.includes(prepared.childPeerId) &&
      extendsActive
    ) {
      this.preparedChild = null;
      this.peers.set(prepared.childPeerId, prepared.peer);
      this.snapshots.set(prepared.childPeerId, prepared.peer.getSnapshot());
      promotedPeerId = prepared.childPeerId;
    } else if (
      failed?.revision === revision &&
      childPeerIds.includes(failed.childPeerId) &&
      extendsActive
    ) {
      return;
    } else {
      this.discardPreparedChild();
    }
    this.reconcileChildren(childPeerIds, promotedPeerId);
  }

  discardPreparedChild(): void {
    const prepared = this.preparedChild;
    this.preparedChild = null;
    this.failedPreparedChild = null;
    prepared?.peer.dispose();
  }

  setChildren(childPeerIds: readonly string[]): void {
    const failedChildPeerId = this.failedPreparedChild?.childPeerId;
    this.reconcileChildren(
      failedChildPeerId
        ? childPeerIds.filter((peerId) => peerId !== failedChildPeerId)
        : childPeerIds,
      null,
    );
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
      MAX_VIEWER_MEDIA_CHILDREN,
    );
    const selectedPeerId = this.selectedChildConnection?.peerId ?? null;
    if (selectedPeerId && !nextChildPeerIds.includes(selectedPeerId)) {
      if (nextChildPeerIds.length >= MAX_VIEWER_MEDIA_CHILDREN) {
        nextChildPeerIds.pop();
      }
      nextChildPeerIds.push(selectedPeerId);
    }
    for (const childPeerId of this.childPeerIds) {
      if (!nextChildPeerIds.includes(childPeerId)) {
        this.disposePeer(childPeerId);
      }
    }
    this.childPeerIds = nextChildPeerIds;
    for (const childPeerId of this.childPeerIds) {
      const peer = this.peers.get(childPeerId);
      if (childPeerId === selectedPeerId) {
        continue;
      }
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
      prepared.childPeerId === fromPeerId &&
      prepared.peer.connectionId === payload.connectionId
    ) {
      await prepared.peer.acceptSignal(payload);
      return true;
    }
    const peer = this.peers.get(fromPeerId);
    const selected = this.selectedChildConnection;
    if (
      !this.childPeerIds.includes(fromPeerId) ||
      !peer ||
      peer.connectionId !== payload.connectionId ||
      (selected?.peerId === fromPeerId &&
        (selected.connectionId !== payload.connectionId ||
          selected.revision !== routeRevision))
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
    this.clearSelectedEdgeTurn();
    this.disposePeers();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stream = null;
    this.discardPreparedChild();
    this.selectedChildConnection = null;
    this.childPeerIds = [];
    this.disposePeers();
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
    selectedTurn?: SelectedEdgeTurn,
  ): void {
    if (
      this.disposed ||
      this.peers.has(childPeerId) ||
      this.stream !== stream ||
      !this.childPeerIds.includes(childPeerId)
    ) {
      return;
    }

    const peer = this.createPeer(childPeerId, stream, selectedTurn);
    this.peers.set(childPeerId, peer);
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (started || this.peers.get(childPeerId) !== peer) {
          return;
        }
        if (selectedTurn) {
          this.failSelectedChild(childPeerId, peer.connectionId);
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
            if (selectedTurn && snapshot.connectionState === "failed") {
              this.failSelectedChild(childPeerId, peer.connectionId);
              return;
            }
            this.snapshots.set(childPeerId, {
              ...snapshot,
              metrics: { ...snapshot.metrics },
            });
            this.events.onUpdate?.(this.getSnapshot());
          }
        },
      },
      selectedTurn !== undefined,
      selectedTurn?.newConnectionId,
    );
    return peer;
  }

  private failSelectedChild(childPeerId: string, connectionId: string): void {
    const selected = this.selectedChildConnection;
    if (
      selected?.peerId !== childPeerId ||
      selected.connectionId !== connectionId
    ) {
      return;
    }
    this.events.onSelectedEdgeFailed?.(
      childPeerId,
      connectionId,
      selected.revision,
    );
    this.disposePeer(childPeerId);
  }

  private failPreparedChild(peer: HostPeer): void {
    const prepared = this.preparedChild;
    if (prepared?.peer !== peer) {
      return;
    }
    this.preparedChild = null;
    const { revision, childPeerId } = prepared;
    this.failedPreparedChild = {
      revision,
      childPeerId,
      connectionId: peer.connectionId,
    };
    peer.dispose();
  }

  private disposePeers(): void {
    for (const childPeerId of [...this.peers.keys()]) {
      this.disposePeer(childPeerId);
    }
  }

  private disposePeer(childPeerId: string): void {
    const peer = this.peers.get(childPeerId);
    if (
      peer &&
      this.selectedChildConnection?.peerId === childPeerId &&
      this.selectedChildConnection.connectionId === peer.connectionId
    ) {
      this.selectedChildConnection = null;
      this.childPeerIds = this.childPeerIds.filter(
        (peerId) => peerId !== childPeerId,
      );
    }
    if (peer) {
      this.retiredConnections.delete(childPeerId);
      this.retiredConnections.set(childPeerId, peer.connectionId);
      while (this.retiredConnections.size > MAX_VIEWER_MEDIA_CHILDREN) {
        const oldestPeerId = this.retiredConnections.keys().next().value;
        if (typeof oldestPeerId === "string") {
          this.retiredConnections.delete(oldestPeerId);
        }
      }
    }
    this.peers.delete(childPeerId);
    this.snapshots.delete(childPeerId);
    this.events.onUpdate?.(this.getSnapshot());
    peer?.dispose();
  }
}
