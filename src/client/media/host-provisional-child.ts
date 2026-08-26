import type {
  IceConfig,
  ParticipantRouteAssignment,
  PreparedRouteCandidate,
  SignalPayload,
} from "../../shared/protocol";
import { countEndpointMediaCopies } from "../../shared/media-copy-accounting";
import { HostPeer } from "../webrtc/host-peer";
import type { BrowserVideoCodecPreference } from "../webrtc/video-codec";
import type { PeerSnapshot } from "../types";
import type { QualityProfile } from "./quality";

interface HostProvisionalInput {
  revision: number;
  assignment: ParticipantRouteAssignment;
  activeChildPeerIds: readonly string[];
  maxMediaEdges: number;
}

interface HostProvisionalPrepareInput extends HostProvisionalInput {
  candidate: PreparedRouteCandidate;
  iceConfig: IceConfig;
  stream: MediaStream;
  profile: QualityProfile;
  videoCodec: BrowserVideoCodecPreference;
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
  candidate: PreparedRouteCandidate;
  peer: HostPeer;
  failed: boolean;
  replacesConnectionId: string | null;
}

export class HostProvisionalChild {
  private prepared: PreparedHostChild | null = null;
  private preparedRevision: number | null = null;
  private preparedCandidate: PreparedRouteCandidate | null = null;
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
      sameCandidate(this.preparedCandidate, input.candidate) &&
      samePeerIds(this.plannedChildPeerIds, planned)
    ) {
      return this.prepared ? !this.prepared.failed : true;
    }

    this.discard();
    this.preparedRevision = input.revision;
    this.preparedCandidate = { ...input.candidate };
    this.plannedChildPeerIds = planned;
    if (
      this.events.activeConnectionId?.(input.candidate.childPeerId) ===
      input.candidate.connectionId
    ) {
      this.discard();
      return false;
    }
    if (input.candidate.transport === "direct") {
      this.startPrepared(input.revision, input.candidate, input);
    }
    return true;
  }

  private startPrepared(
    revision: number,
    candidate: PreparedRouteCandidate,
    input: Pick<
      HostProvisionalPrepareInput,
      "iceConfig" | "stream" | "profile" | "videoCodec"
    >,
  ): void {
    let peer: HostPeer;
    peer = new HostPeer(
      candidate.childPeerId,
      input.iceConfig,
      input.stream,
      input.profile,
      {
        sendSignal: (targetPeerId, payload) =>
          this.signalingPeer === peer &&
          targetPeerId === candidate.childPeerId &&
          payload.connectionId === candidate.connectionId
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
      input.videoCodec,
      candidate.connectionId,
    );
    this.signalingPeer = peer;
    this.prepared = {
      revision,
      candidate: { ...candidate },
      peer,
      failed: false,
      replacesConnectionId:
        this.events.activeConnectionId?.(candidate.childPeerId) ?? null,
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
        prepared.candidate.childPeerId === fromPeerId &&
        prepared.candidate.connectionId === payload.connectionId &&
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
      ? this.events.activeConnectionId?.(prepared.candidate.childPeerId) ?? null
      : null;
    if (
      prepared &&
      !prepared.failed &&
      this.preparedRevision === input.revision &&
      prepared.revision === input.revision &&
      this.preparedCandidate?.connectionId === prepared.candidate.connectionId &&
      input.assignment.childPeerIds.includes(prepared.candidate.childPeerId) &&
      (!input.activeChildPeerIds.includes(prepared.candidate.childPeerId) ||
        prepared.replacesConnectionId === currentConnectionId)
    ) {
      this.prepared = null;
      this.preparedRevision = null;
      this.preparedCandidate = null;
      this.plannedChildPeerIds = [];
      this.promotedPeer = prepared.peer;
      return {
        kind: "promote",
        peerId: prepared.candidate.childPeerId,
        peer: prepared.peer,
      };
    }
    this.discard();
    return { kind: "ordinary" };
  }

  discard(): void {
    this.preparedRevision = null;
    this.preparedCandidate = null;
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
  input: HostProvisionalPrepareInput,
): string[] | null {
  const childPeerIds = [...new Set(input.assignment.childPeerIds)];
  if (
    input.candidate.transport !== "direct" ||
    !childPeerIds.includes(input.candidate.childPeerId) ||
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
