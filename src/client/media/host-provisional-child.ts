import type {
  IceConfig,
  ParticipantRouteAssignment,
  ServerMessage,
  SignalPayload,
} from "../../shared/protocol";
import { countEndpointMediaCopies } from "../../shared/media-copy-accounting";
import { HostPeer } from "../webrtc/host-peer";
import type { PeerSnapshot } from "../types";
import type { QualityProfile } from "./quality";

type SelectedEdgeTurn = Extract<
  ServerMessage,
  { type: "selected-edge-turn"; edgeKind: "peer-selected" }
>;

interface HostProvisionalInput {
  revision: number;
  assignment: ParticipantRouteAssignment;
  activeChildPeerIds: readonly string[];
  maxMediaEdges: number;
}

interface HostProvisionalPrepareInput extends HostProvisionalInput {
  iceConfig: IceConfig;
  stream: MediaStream;
  profile: QualityProfile;
}

interface HostProvisionalChildEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  activeConnectionId?: (peerId: string) => string | null;
  onPromotedStreamFailure?: (peer: HostPeer) => void;
  onPromotedUpdate?: (peer: HostPeer, snapshot: PeerSnapshot) => void;
}

export type HostPreparedChildActivation =
  | { kind: "ordinary" }
  | { kind: "promote"; peerId: string; peer: HostPeer };

interface PreparedHostChild {
  revision: number;
  peerId: string;
  peer: HostPeer;
  failed: boolean;
  replacesConnectionId: string | null;
}

export class HostProvisionalChild {
  private prepared: PreparedHostChild | null = null;
  private preparedRevision: number | null = null;
  private plannedChildPeerIds: string[] = [];
  private promotedPeer: HostPeer | null = null;
  private signalingPeer: HostPeer | null = null;

  constructor(private readonly events: HostProvisionalChildEvents) {}

  prepare(input: HostProvisionalPrepareInput): boolean {
    const planned = validPlannedHostChildren(input);
    if (this.promotedPeer || !planned) {
      this.discard();
      return false;
    }
    if (
      this.preparedRevision === input.revision &&
      samePeerIds(this.plannedChildPeerIds, planned)
    ) {
      return this.prepared ? !this.prepared.failed : true;
    }
    const peerId = planned.find(
      (candidate) => !input.activeChildPeerIds.includes(candidate),
    );

    this.discard();
    this.preparedRevision = input.revision;
    this.plannedChildPeerIds = planned;
    if (!peerId) {
      return true;
    }
    if (this.events.activeConnectionId?.(peerId)) {
      this.discard();
      return false;
    }
    this.startPrepared(input.revision, peerId, input);
    return true;
  }

  prepareSelectedTurn(
    message: SelectedEdgeTurn,
    input: Pick<HostProvisionalPrepareInput, "iceConfig" | "stream" | "profile">,
    now = Date.now(),
  ): boolean {
    if (
      this.preparedRevision !== message.revision ||
      !this.plannedChildPeerIds.includes(message.viewerPeerId) ||
      Date.parse(message.expiresAt) <= now
    ) {
      return false;
    }
    const prepared = this.prepared;
    if (prepared && prepared.peerId !== message.viewerPeerId) {
      return false;
    }
    if (prepared?.peer.connectionId === message.newConnectionId) {
      return !prepared.failed;
    }
    const oldConnectionId =
      prepared?.peer.connectionId ??
      this.events.activeConnectionId?.(message.viewerPeerId);
    if (oldConnectionId !== message.oldConnectionId) {
      return false;
    }
    this.discardPeer();
    this.startPrepared(message.revision, message.viewerPeerId, input, message);
    return true;
  }

  private startPrepared(
    revision: number,
    peerId: string,
    input: Pick<HostProvisionalPrepareInput, "iceConfig" | "stream" | "profile">,
    selectedTurn?: SelectedEdgeTurn,
  ): void {
    let peer: HostPeer;
    peer = new HostPeer(
      peerId,
      selectedTurn
        ? { iceServers: [selectedTurn.iceServer] }
        : input.iceConfig,
      input.stream,
      input.profile,
      {
        sendSignal: (targetPeerId, payload) =>
          this.signalingPeer === peer && targetPeerId === peerId
            ? this.events.sendSignal(targetPeerId, payload)
            : false,
        onUpdate: (snapshot) => {
          if (this.prepared?.peer === peer) {
            if (snapshot.connectionState === "failed") {
              this.fail(peer);
            }
            return;
          }
          if (this.promotedPeer === peer) {
            this.events.onPromotedUpdate?.(peer, snapshot);
          }
        },
      },
      selectedTurn !== undefined,
      selectedTurn?.newConnectionId,
    );
    this.signalingPeer = peer;
    this.prepared = {
      revision,
      peerId,
      peer,
      failed: false,
      replacesConnectionId: selectedTurn?.oldConnectionId ?? null,
    };
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (!started && this.prepared?.peer === peer) {
          this.fail(peer);
        }
      });
  }

  ownsSignal(fromPeerId: string, payload: SignalPayload): boolean {
    const prepared = this.prepared;
    return Boolean(
      prepared &&
        !prepared.failed &&
        prepared.peerId === fromPeerId &&
        prepared.peer.connectionId === payload.connectionId,
    );
  }

  acceptSignal(fromPeerId: string, payload: SignalPayload): boolean {
    const prepared = this.prepared;
    if (!this.ownsSignal(fromPeerId, payload) || !prepared) {
      return false;
    }
    void prepared.peer.acceptSignal(payload);
    return true;
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    const peer = this.livePeer();
    return peer ? peer.updateProfile(profile) : Promise.resolve(true);
  }

  async replaceStream(stream: MediaStream): Promise<boolean> {
    const peer = this.livePeer();
    if (!peer) {
      return true;
    }
    const replaced = await peer.replaceStream(stream).catch(() => false);
    if (this.prepared?.peer !== peer) {
      if (this.promotedPeer === peer && !replaced) {
        this.events.onPromotedStreamFailure?.(peer);
      }
      return this.promotedPeer === peer ? replaced : true;
    }
    if (!replaced) {
      this.fail(peer);
    }
    return replaced;
  }

  activate(input: HostProvisionalInput): HostPreparedChildActivation {
    const prepared = this.prepared;
    const currentConnectionId = prepared
      ? this.events.activeConnectionId?.(prepared.peerId) ?? null
      : null;
    if (
      prepared &&
      !prepared.failed &&
      this.preparedRevision === input.revision &&
      prepared.revision === input.revision &&
      input.assignment.childPeerIds.includes(prepared.peerId) &&
      (!input.activeChildPeerIds.includes(prepared.peerId) ||
        prepared.replacesConnectionId === currentConnectionId)
    ) {
      this.prepared = null;
      this.preparedRevision = null;
      this.plannedChildPeerIds = [];
      this.promotedPeer = prepared.peer;
      return { kind: "promote", peerId: prepared.peerId, peer: prepared.peer };
    }
    this.discard();
    return { kind: "ordinary" };
  }

  discard(): void {
    this.preparedRevision = null;
    this.plannedChildPeerIds = [];
    this.discardPeer();
  }

  private discardPeer(): void {
    const prepared = this.prepared;
    this.prepared = null;
    if (this.signalingPeer === prepared?.peer) {
      this.signalingPeer = null;
    }
    prepared?.peer.dispose();
  }

  private livePeer(): HostPeer | null {
    return this.prepared && !this.prepared.failed
      ? this.prepared.peer
      : null;
  }

  private fail(peer: HostPeer): void {
    if (this.prepared?.peer !== peer) {
      return;
    }
    this.prepared.failed = true;
    if (this.signalingPeer === peer) {
      this.signalingPeer = null;
    }
    peer.dispose();
  }
}

function validPlannedHostChildren(
  input: HostProvisionalInput,
): string[] | null {
  const childPeerIds = [...new Set(input.assignment.childPeerIds)];
  if (
    childPeerIds.length !== input.assignment.childPeerIds.length ||
    childPeerIds.length < input.activeChildPeerIds.length ||
    childPeerIds.length > input.activeChildPeerIds.length + 1 ||
    input.activeChildPeerIds.some(
      (candidate) => !childPeerIds.includes(candidate),
    ) ||
    countEndpointMediaCopies({
      childPeerIds: input.assignment.childPeerIds,
      publicationGeneration: input.assignment.sfuPublicationGeneration,
    }) > input.maxMediaEdges
  ) {
    return null;
  }
  return childPeerIds;
}

function samePeerIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((peerId, index) => peerId === right[index])
  );
}
