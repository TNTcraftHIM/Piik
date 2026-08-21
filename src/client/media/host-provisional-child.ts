import type {
  IceConfig,
  ParticipantRouteAssignment,
  SignalPayload,
} from "../../shared/protocol";
import { HostPeer } from "../webrtc/host-peer";
import type { PeerSnapshot } from "../types";
import type { QualityProfile } from "./quality";

export interface HostPreparedChildIdentity {
  revision: number;
  peerId: string;
  failedConnectionId: string | null;
}

interface HostProvisionalInput {
  revision: number;
  assignment: ParticipantRouteAssignment;
  activeChildPeerIds: readonly string[];
  selectedPeerId: string | null;
  maxMediaEdges: number;
}

interface HostProvisionalPrepareInput extends HostProvisionalInput {
  iceConfig: IceConfig;
  stream: MediaStream;
  profile: QualityProfile;
}

interface HostProvisionalChildEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  hasActivePeer?: (peerId: string) => boolean;
  onPromotedStreamFailure?: (peer: HostPeer) => void;
  onPromotedUpdate?: (peer: HostPeer, snapshot: PeerSnapshot) => void;
}

export type HostPreparedChildResolution =
  | { kind: "ordinary" }
  | { kind: "promote"; peerId: string }
  | { kind: "failed"; peerId: string; connectionId: string };

export type HostPreparedChildActivation =
  | Exclude<HostPreparedChildResolution, { kind: "promote" }>
  | { kind: "promote"; peerId: string; peer: HostPeer };

interface PreparedHostChild extends HostPreparedChildIdentity {
  peer: HostPeer;
}

export class HostProvisionalChild {
  private prepared: PreparedHostChild | null = null;
  private promotedPeer: HostPeer | null = null;
  private signalingPeer: HostPeer | null = null;

  constructor(private readonly events: HostProvisionalChildEvents) {}

  prepare(input: HostProvisionalPrepareInput): boolean {
    const peerId = plannedHostProvisionalChild(input);
    if (
      this.promotedPeer ||
      !peerId ||
      this.events.hasActivePeer?.(peerId)
    ) {
      this.discard();
      return false;
    }
    if (
      this.prepared?.revision === input.revision &&
      this.prepared.peerId === peerId
    ) {
      return this.prepared.failedConnectionId === null;
    }

    this.discard();
    let peer: HostPeer;
    peer = new HostPeer(
      peerId,
      input.iceConfig,
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
    );
    this.signalingPeer = peer;
    this.prepared = {
      revision: input.revision,
      peerId,
      peer,
      failedConnectionId: null,
    };
    void peer
      .start()
      .catch(() => false)
      .then((started) => {
        if (!started && this.prepared?.peer === peer) {
          this.fail(peer);
        }
      });
    return true;
  }

  ownsSignal(fromPeerId: string, payload: SignalPayload): boolean {
    const prepared = this.prepared;
    return Boolean(
      prepared &&
        prepared.failedConnectionId === null &&
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
    const activation = resolveHostPreparedChildActivation({
      ...input,
      prepared,
    });
    if (activation.kind === "promote") {
      if (prepared) {
        this.prepared = null;
        this.promotedPeer = prepared.peer;
        return { ...activation, peer: prepared.peer };
      }
      this.discard();
      return { kind: "ordinary" };
    }
    if (activation.kind === "failed") {
      this.prepared = null;
      prepared?.peer.dispose();
      return activation;
    }
    this.discard();
    return activation;
  }

  discard(): void {
    const prepared = this.prepared;
    this.prepared = null;
    if (this.signalingPeer === prepared?.peer) {
      this.signalingPeer = null;
    }
    prepared?.peer.dispose();
  }

  private livePeer(): HostPeer | null {
    return this.prepared?.failedConnectionId === null
      ? this.prepared.peer
      : null;
  }

  private fail(peer: HostPeer): void {
    if (this.prepared?.peer !== peer) {
      return;
    }
    this.prepared.failedConnectionId = peer.connectionId;
    if (this.signalingPeer === peer) {
      this.signalingPeer = null;
    }
    peer.dispose();
  }
}

export function plannedHostProvisionalChild(
  input: HostProvisionalInput,
): string | null {
  const childPeerIds = [...new Set(input.assignment.childPeerIds)];
  const peerId = childPeerIds.find(
    (candidate) => !input.activeChildPeerIds.includes(candidate),
  );
  if (
    childPeerIds.length !== input.assignment.childPeerIds.length ||
    childPeerIds.length !== input.activeChildPeerIds.length + 1 ||
    input.activeChildPeerIds.some(
      (candidate) => !childPeerIds.includes(candidate),
    ) ||
    hostPhysicalMediaEdges(input.assignment, input.selectedPeerId) >
      input.maxMediaEdges
  ) {
    return null;
  }
  return peerId ?? null;
}

export function resolveHostPreparedChildActivation(
  input: HostProvisionalInput & {
    prepared: HostPreparedChildIdentity | null;
  },
): HostPreparedChildResolution {
  const peerId = plannedHostProvisionalChild(input);
  if (
    !peerId ||
    input.prepared?.revision !== input.revision ||
    input.prepared.peerId !== peerId
  ) {
    return { kind: "ordinary" };
  }
  return input.prepared.failedConnectionId
    ? {
        kind: "failed",
        peerId,
        connectionId: input.prepared.failedConnectionId,
      }
    : { kind: "promote", peerId };
}

function hostPhysicalMediaEdges(
  assignment: ParticipantRouteAssignment,
  selectedPeerId: string | null,
): number {
  const selectedOverlayEdges =
    selectedPeerId && !assignment.childPeerIds.includes(selectedPeerId) ? 1 : 0;
  return (
    assignment.childPeerIds.length +
    (assignment.sfuPublicationGeneration ? 1 : 0) +
    selectedOverlayEdges
  );
}
