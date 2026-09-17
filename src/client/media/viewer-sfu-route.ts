import type {
  ClientMessage,
  MediaRoutePhase,
  ParticipantRouteAssignment,
  PreparedRouteCandidate,
  ServerMessage,
  SfuSignalMessage,
} from "../../shared/protocol";
import { SfuSubscriber } from "../sfu/subscriber";
import type { ConnectionMetrics } from "../types";
import type { SfuConnectionConfig } from "../sfu/publisher";
import {
  SfuQualityProbe,
  type CandidateQualityProbeResult,
} from "./candidate-quality-probe";
import {
  MediaRouteTransition,
  reportActivePeerRouteFailure,
  type RouteOperationToken,
  type RouteUpdateInput,
  type RouteUpdateResult,
} from "./route-transition";

interface ViewerSubscriberTransport {
  connect(config: SfuConnectionConfig): Promise<boolean>;
  updateConfig(config: SfuConnectionConfig): void;
  acceptSignal(message: SfuSignalMessage): Promise<void>;
  reconnect(): boolean;
  activate(): boolean;
  deactivate(): boolean;
  armDecodedFrameProof(requireProgress?: boolean): void;
  stopDecodedFrameProof(): void;
  disconnect(): Promise<void>;
}

interface ViewerSubscriberSlot {
  mediaIdentity: string;
  connectionId: string;
  revision: number;
  phase: MediaRoutePhase;
  publicationGeneration: string;
  subscriber: ViewerSubscriberTransport;
  connected: boolean;
  activated: boolean;
  stream: MediaStream | null;
  decodedFrame: boolean;
  readySent: boolean;
  qualityProbe: SfuQualityProbe | null;
  qualityResult: CandidateQualityProbeResult;
  failed: boolean;
  activationToken: RouteOperationToken | null;
}

interface ViewerSfuRouteEvents {
  activatePeer: (
    assignment: ParticipantRouteAssignment,
    revision?: number,
  ) => boolean | void | Promise<boolean | void>;
  preparePeer?: (
    assignment: ParticipantRouteAssignment | null,
    revision?: number,
    candidate?: PreparedRouteCandidate,
  ) => void;
  prepareChild?: (
    candidate: PreparedRouteCandidate | null,
    childPeerIds?: readonly string[],
    revision?: number,
  ) => void;
  activateChildren?: (
    childPeerIds: readonly string[],
    revision: number,
  ) => void;
  resetMedia?: () => void;
  reconcileSfuChildren?: (childPeerIds: string[]) => void;
  onSfuStream: (
    stream: MediaStream,
    assignment: ParticipantRouteAssignment,
    initialVideoStream: boolean,
    revision: number,
  ) => void;
  onSfuVideoAvailability?: (available: boolean, revision: number) => void;
  onSfuUpdate?: (metrics: ConnectionMetrics | null, revision: number) => void;
  currentPeerMetrics?: () => ConnectionMetrics | null;
  qualityProbeEligible?: () => boolean;
  onSfuDecodedFrameSample?: (
    framesDecodedDelta: number | null,
    revision: number,
    mediaIdentity: string,
    connectionId: string,
  ) => void;
  onSfuState?: (
    state: "connected" | "reconnecting",
    revision: number,
  ) => void;
  send: (message: ClientMessage) => boolean;
  createSubscriber?: (
    events: {
      onStream: (stream: MediaStream | null) => void;
      onVideoAvailability: (available: boolean) => void;
      onStats: (metrics: ConnectionMetrics) => void;
      onDecodedFrameSample: (framesDecodedDelta: number | null) => void;
      onFirstDecodedFrame: () => boolean;
      onState: (state: "connected" | "reconnecting") => void;
      onDisconnected: () => void;
    },
  ) => ViewerSubscriberTransport;
}

export class ViewerSfuRoute {
  private readonly route = new MediaRouteTransition();
  private pending: ViewerSubscriberSlot | null = null;
  private active: ViewerSubscriberSlot | null = null;
  private recovery: { revision: number; refreshed: boolean } | null = null;
  private pendingPeerRevision: number | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private resyncGeneration = 0;
  private resyncing = false;
  private subscriberGeneration = 0;
  private paused = false;
  private closed = false;

  constructor(
    private viewerPeerId: string,
    private readonly events: ViewerSfuRouteEvents,
  ) {}

  accept(update: RouteUpdateInput, acknowledge = true): RouteUpdateResult {
    if (this.closed) {
      return "stale";
    }
    const previousRevision = this.route.getRevision();
    const previousMediaAssignment = this.route.getMediaAssignment();
    const sameCommittedMedia = sameUpstream(
      previousMediaAssignment,
      update.assignment,
    );
    const continuingRecovery = previousRevision !== update.revision &&
      sameCommittedMedia && this.recovery !== null;
    const result = this.route.accept(update);
    if (result === "stale") {
      return result;
    }
    if (this.active) {
      this.active.subscriber.updateConfig({ ...this.active, revision: update.revision });
    }
    if (continuingRecovery) {
      if (this.active) {
        this.active.revision = update.revision;
      }
      if (this.pending?.phase === "active") {
        this.pending.revision = update.revision;
      }
      if (this.recovery) {
        this.recovery.revision = update.revision;
        if (this.pending === null) {
          this.recovery.refreshed = false;
        }
      }
    }
    const pausedActiveReconciliation =
      this.paused && update.phase === "active" && result !== "duplicate";
    const retiredActive = pausedActiveReconciliation
      ? this.detachUnreferencedActive(update.assignment)
      : null;
    if (pausedActiveReconciliation) {
      this.activateChildren(update.assignment.childPeerIds, update.revision);
    }
    if (this.paused && update.phase === "prepare") {
      this.discardPending();
      return result;
    }
    if (result === "duplicate") {
      return result;
    }
    if (retiredActive) {
      void this.queueTransition(() =>
        this.disconnectRetiredSubscriber(retiredActive),
      );
    }
    if (previousRevision !== update.revision && !sameCommittedMedia) {
      this.recovery = null;
      if (
        update.phase !== "prepare" &&
        this.pendingPeerRevision !== null
      ) {
        this.events.preparePeer?.(null);
        this.pendingPeerRevision = null;
      }
    }
    if (update.phase === "prepare") {
      const candidate = update.candidate;
      const ownsUpstreamCandidate = candidate.childPeerId === this.viewerPeerId;
      const ownsChildCandidate =
        candidate.transport !== "sfu" &&
        update.assignment.childPeerIds.includes(candidate.childPeerId);
      this.events.prepareChild?.(
        ownsChildCandidate ? candidate : null,
        ownsChildCandidate ? update.assignment.childPeerIds : undefined,
        ownsChildCandidate ? update.revision : undefined,
      );
      const needsPeerCandidate =
        ownsUpstreamCandidate &&
        candidate.transport !== "sfu" &&
        update.assignment.upstream.kind === "peer" &&
        candidate.connectionId.length > 0;
      const replacedPeerCandidate = this.pendingPeerRevision !== null;
      if (replacedPeerCandidate) {
        this.pendingPeerRevision = null;
        this.events.preparePeer?.(null);
      }
      if (needsPeerCandidate && update.assignment.upstream.kind === "peer") {
        this.pendingPeerRevision = update.revision;
        this.events.preparePeer?.(update.assignment, update.revision, candidate);
      } else if (
        update.assignment.upstream.kind !== "peer" &&
        !replacedPeerCandidate
      ) {
        this.events.preparePeer?.(null);
      }
      if (this.pending?.revision !== update.revision) {
        this.clearPending();
      }
      if (
        !ownsUpstreamCandidate ||
        candidate.transport !== "sfu" ||
        update.assignment.upstream.kind !== "sfu"
      ) {
        this.clearPending();
      }
      return result;
    }

    const token = this.route.token();
    if (!token) {
      return result;
    }
    if (this.pendingPeerRevision !== update.revision) {
      this.preparePeer(update.assignment);
    }
    if (this.resyncing) {
      return result;
    }
    void this.queueActiveRoute(token, acknowledge, this.paused);
    return result;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.pending?.qualityProbe?.reset();
      if (this.pending) {
        this.pending.qualityResult = "pending";
      }
    }
    if (paused) {
      this.discardPending();
      return;
    }
    for (const slot of new Set([this.active, this.pending])) {
      if (slot?.activated && !slot.failed) {
        slot.subscriber.armDecodedFrameProof();
      }
    }
  }

  resetQualityProbe(): void {
    this.pending?.qualityProbe?.reset();
    if (this.pending) {
      this.pending.qualityResult = "pending";
    }
  }

  reconnectActive(): boolean {
    const revision = this.route.getRevision();
    const assignment = this.route.getActiveAssignment();
    const active = this.active;
    if (
      this.closed ||
      this.resyncing ||
      this.pending !== null ||
      this.paused ||
      revision === null ||
      this.route.getPhase() !== "active" ||
      assignment?.upstream.kind !== "sfu" ||
      !active ||
      active.failed ||
      !active.activated ||
      active.revision !== revision ||
      active.publicationGeneration !== assignment.sfuPublicationGeneration
    ) {
      return false;
    }

    return active.subscriber.reconnect();
  }

  private discardPending(): void {
    this.pendingPeerRevision = null;
    this.events.preparePeer?.(null);
    this.events.prepareChild?.(null);
    this.clearPending();
  }

  async resyncAuthoritative(
    update: RouteUpdateInput,
    viewerPeerId: string,
  ): Promise<RouteUpdateResult> {
    if (this.closed) {
      return "stale";
    }
    const identityChanged = viewerPeerId !== this.viewerPeerId;
    if (identityChanged) {
      this.viewerPeerId = viewerPeerId;
    }
    this.pendingPeerRevision = null;
    const currentMediaAssignment = this.route.getMediaAssignment();
    const preservesActiveMedia = Boolean(
      !identityChanged &&
        update.phase === "active" &&
        sameUpstream(currentMediaAssignment, update.assignment) &&
        (update.assignment.upstream.kind !== "sfu" ||
          (this.active?.activated &&
            !this.active.failed &&
            this.active.publicationGeneration ===
              update.assignment.sfuPublicationGeneration)),
    );
    if (
      !identityChanged &&
      ((!this.active && !this.pending) || preservesActiveMedia)
    ) {
      const result = this.accept(update, false);
      if (result !== "stale") {
        await this.transitionTail;
        return result;
      }
    }

    const resyncGeneration = ++this.resyncGeneration;
    this.resyncing = true;
    this.route.reset();
    this.recovery = null;
    this.events.prepareChild?.(null);
    const pending = this.pending;
    const active = this.active;
    this.pending = null;
    this.active = null;
    if (pending) {
      pending.failed = true;
    }
    if (active) {
      active.failed = true;
    }
    const accepted = this.route.accept(update);
    this.preparePeer(update.assignment);
    this.events.resetMedia?.();

    await this.queueTransition(async () => {
      if (active?.activated) {
        try {
          active.subscriber.deactivate();
        } catch {
          // Disconnect remains the fail-closed cleanup path.
        }
      }
      if (active) {
        await disconnectSubscriber(active.subscriber);
      }
      if (pending && pending !== active) {
        await disconnectSubscriber(pending.subscriber);
      }
    });

    if (this.closed || this.resyncGeneration !== resyncGeneration) {
      return "stale";
    }
    this.resyncing = false;
    const token = this.route.token();
    if (token && this.route.getPhase() === "active") {
      await this.queueActiveRoute(token, false);
    }
    return accepted;
  }

  async acceptConfig(
    message: Extract<ServerMessage, { type: "sfu-config" }>,
  ): Promise<void> {
    if (
      this.closed ||
      !this.route.acceptsConfig(message.revision)
    ) {
      return;
    }
    const token = this.route.token();
    const assignment = this.route.getPlannedAssignment();
    const phase = this.route.getPhase();
    const candidate = this.route.getPreparedCandidate();
    const publicationGeneration = assignment?.sfuPublicationGeneration;
    if (
      !token ||
      !phase ||
      assignment?.upstream.kind !== "sfu" ||
      !publicationGeneration ||
      message.publicationGeneration !== publicationGeneration ||
      (phase === "prepare" &&
        (candidate?.childPeerId !== this.viewerPeerId ||
          candidate.transport !== "sfu"))
    ) {
      return;
    }

    if (
      phase === "active" &&
      this.active?.publicationGeneration === publicationGeneration &&
      this.active.activated &&
      this.active.connectionId === message.connectionId
    ) {
      this.active.subscriber.updateConfig(message);
      if (phase === "active") {
        await this.queueActiveRoute(token, true, this.paused);
      }
      return;
    }
    if (
      this.pending?.revision === message.revision &&
      this.pending.publicationGeneration === publicationGeneration &&
      this.pending.connectionId === message.connectionId &&
      !this.pending.failed
    ) {
      this.pending.subscriber.updateConfig(message);
      return;
    }

    this.clearPending();
    let slot: ViewerSubscriberSlot;
    const subscriberEvents = {
      send: this.events.send,
      onStream: (stream: MediaStream | null) => {
        if (stream) {
          this.handleStream(slot, stream);
        }
      },
      onVideoAvailability: (available: boolean) => {
        this.handleVideoAvailability(slot, available);
      },
      onStats: (metrics: ConnectionMetrics) => {
        if (this.active === slot && !slot.failed) {
          this.events.onSfuUpdate?.(metrics, slot.revision);
        } else if (
          this.pending === slot &&
          !slot.failed &&
          slot.qualityProbe
        ) {
          if (this.events.qualityProbeEligible?.() === false) {
            slot.qualityProbe.reset();
            slot.qualityResult = "pending";
          } else {
            slot.qualityResult = slot.qualityProbe.observe(
              this.events.currentPeerMetrics?.() ?? null,
              metrics,
            );
            if (slot.qualityResult === "approved") {
              this.sendPendingReady(slot);
            } else if (
              slot.qualityResult === "rejected" &&
              this.routeFailed(slot.revision, "prepare")
            ) {
              this.clearPending();
            }
          }
        }
      },
      onDecodedFrameSample: (framesDecodedDelta: number | null) => {
        if (this.active === slot && !slot.failed) {
          this.events.onSfuDecodedFrameSample?.(
            framesDecodedDelta,
            slot.revision,
            slot.mediaIdentity,
            slot.connectionId,
          );
        }
      },
      onFirstDecodedFrame: () => this.handlePendingDecodedFrame(slot),
      onState: (state: "connected" | "reconnecting") => {
        if (this.active === slot && !slot.failed) {
          this.events.onSfuState?.(state, slot.revision);
        }
      },
      onDisconnected: () => this.failSubscriberSlot(slot),
    };
    const subscriber =
      this.events.createSubscriber?.(subscriberEvents) ??
      new SfuSubscriber(subscriberEvents);
    const preparedCandidate = this.route.getPreparedCandidate();
    slot = {
      mediaIdentity: `${publicationGeneration}:${++this.subscriberGeneration}`,
      connectionId: message.connectionId,
      revision: message.revision,
      phase,
      publicationGeneration,
      subscriber,
      connected: false,
      activated: false,
      stream: null,
      decodedFrame: false,
      readySent: false,
      qualityProbe:
        preparedCandidate?.transport === "sfu" &&
        preparedCandidate.qualityProbe
          ? new SfuQualityProbe()
          : null,
      qualityResult: "pending",
      failed: false,
      activationToken: null,
    };
    this.pending = slot;
    try {
      const connected = await subscriber.connect(message);
      if (!connected) {
        const currentToken = this.currentPendingToken(slot, token);
        if (this.pending === slot && currentToken) {
          slot.revision = currentToken.revision;
          this.handleFailure(slot);
        } else {
          if (this.pending === slot) {
            this.pending = null;
          }
          slot.failed = true;
        }
        await disconnectSubscriber(subscriber);
        return;
      }
      const currentToken = this.currentPendingToken(slot, token);
      if (this.pending !== slot || !currentToken) {
        if (this.pending === slot) {
          this.pending = null;
        }
        slot.failed = true;
        await disconnectSubscriber(subscriber);
        return;
      }
      slot.revision = currentToken.revision;
      slot.connected = true;
      if (!subscriber.activate()) {
        this.failSubscriberSlot(slot);
        await disconnectSubscriber(subscriber);
        return;
      }
      slot.activated = true;
      if (!this.paused) {
        subscriber.armDecodedFrameProof();
      }
      if (slot.phase === "active" && !this.resyncing) {
        await this.queueActiveRoute(currentToken, true);
      }
    } catch {
      this.failSubscriberSlot(slot);
      await disconnectSubscriber(subscriber);
    }
  }

  reportPeerFailure(parentPeerId: string, connectionId: string): boolean {
    return reportActivePeerRouteFailure(
      this.route,
      parentPeerId,
      connectionId,
      this.events.send,
    );
  }

  async acceptSignal(message: SfuSignalMessage): Promise<void> {
    const slot = [this.pending, this.active].find((slot) =>
      slot && !slot.failed && slot.connectionId === message.connectionId &&
      slot.publicationGeneration === message.publicationGeneration,
    );
    if (slot === this.pending && slot?.revision !== message.revision) return;
    await slot?.subscriber.acceptSignal(message);
  }

  async disconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resyncGeneration += 1;
    this.resyncing = false;
    this.route.reset();
    this.recovery = null;
    this.pendingPeerRevision = null;
    this.events.preparePeer?.(null);
    this.events.prepareChild?.(null);
    await this.queueTransition(async () => {
      const pending = this.pending;
      const active = this.active;
      this.pending = null;
      this.active = null;
      if (pending) {
        pending.failed = true;
      }
      if (active) {
        active.failed = true;
      }
      this.events.onSfuUpdate?.(
        null,
        active?.revision ?? pending?.revision ?? this.route.getRevision() ?? 0,
      );
      if (active?.activated) {
        try {
          active.subscriber.deactivate();
        } catch {
          // Disconnect remains the fail-closed cleanup path.
        }
      }
      await Promise.all([
        pending ? disconnectSubscriber(pending.subscriber) : undefined,
        active && active !== pending
          ? disconnectSubscriber(active.subscriber)
          : undefined,
      ]);
    });
  }

  private preparePeer(assignment: ParticipantRouteAssignment): void {
    this.events.preparePeer?.(
      assignment.upstream.kind === "peer" ? assignment : null,
    );
  }

  private queueActiveRoute(
    token: RouteOperationToken,
    acknowledge: boolean,
    retireUnreferenced = false,
  ): Promise<void> {
    return this.queueTransition(async () => {
      if (this.closed || this.resyncing || !this.route.owns(token, "active")) {
        return;
      }
      const assignment = this.route.getActiveAssignment();
      if (!assignment) {
        return;
      }
      const assignedPublicationGeneration =
        assignment.upstream.kind === "sfu"
          ? assignment.sfuPublicationGeneration
          : null;
      if (
        retireUnreferenced &&
        this.active?.publicationGeneration !== assignedPublicationGeneration
      ) {
        await this.retireActive();
        if (!this.route.owns(token, "active")) {
          return;
        }
      }
      if (assignment.upstream.kind === "sfu") {
        this.activateChildren(assignment.childPeerIds, token.revision);
        const mediaAssignment = this.route.getMediaAssignment();
        if (
          mediaAssignment?.upstream.kind === "sfu" &&
          this.active?.publicationGeneration ===
            assignment.sfuPublicationGeneration &&
          this.active?.activated &&
          this.pending?.publicationGeneration !== assignment.sfuPublicationGeneration
        ) {
          this.clearPending();
          this.active.revision = token.revision;
          this.active.subscriber.updateConfig(this.active);
          this.commitMedia(token);
          return;
        }
        await this.activateSfu(token, acknowledge);
        return;
      }

      const pendingPeerRevision = this.pendingPeerRevision;
      const promoted =
        pendingPeerRevision === token.revision
          ? await this.events.activatePeer(assignment, token.revision)
          : false;
      if (pendingPeerRevision === token.revision && promoted !== true) {
        return;
      }
      this.pendingPeerRevision = null;
      this.clearPending();
      if (this.active) {
        await this.retireActive();
      }
      if (!this.route.owns(token, "active")) {
        return;
      }
      if (!promoted) {
        await this.events.activatePeer(assignment);
      }
      if (!this.route.owns(token, "active")) {
        return;
      }
      this.activateChildren(assignment.childPeerIds, token.revision);
      this.commitMedia(token);
    });
  }

  private queueTransition(work: () => Promise<void>): Promise<void> {
    const next = this.transitionTail.then(work, work);
    this.transitionTail = next.catch(() => undefined);
    return this.transitionTail;
  }

  private activateChildren(childPeerIds: readonly string[], revision: number): void {
    if (this.events.activateChildren) {
      this.events.activateChildren(childPeerIds, revision);
    } else {
      this.events.reconcileSfuChildren?.([...childPeerIds]);
    }
  }

  private async activateSfu(
    token: RouteOperationToken,
    acknowledge: boolean,
  ): Promise<void> {
    const assignment = this.route.getActiveAssignment();
    const publicationGeneration = assignment?.sfuPublicationGeneration;
    if (
      this.active?.revision === token.revision &&
      this.active.publicationGeneration === publicationGeneration &&
      this.active.activated && this.pending === null
    ) {
      return;
    }
    const pending = this.pending;
    if (
      !pending ||
      pending.revision !== token.revision ||
      pending.publicationGeneration !== publicationGeneration ||
      !pending.connected
    ) {
      if (
        acknowledge &&
        this.route.owns(token, "active") &&
        pending === null
      ) {
        this.requestRecovery(token.revision);
      }
      return;
    }
    pending.activationToken = token;
    await this.promotePendingSfu(pending);
  }

  private handleStream(slot: ViewerSubscriberSlot, stream: MediaStream): void {
    if (this.closed || slot.failed || !slot.activated) {
      return;
    }
    slot.stream = stream;
    if (this.active === slot) {
      const assignment = this.route.getMediaAssignment();
      if (assignment?.upstream.kind === "sfu") {
        this.events.onSfuStream(stream, assignment, false, slot.revision);
      }
      return;
    }
    void this.queueTransition(() => this.promotePendingSfu(slot));
  }

  private handlePendingDecodedFrame(slot: ViewerSubscriberSlot): boolean {
    if (this.closed || slot.failed || this.pending !== slot) {
      return true;
    }
    if (this.paused || !slot.activated) {
      return false;
    }
    const assignment = this.route.getPlannedAssignment();
    const phase = this.route.getPhase();
    if (
      this.route.getRevision() !== slot.revision ||
      assignment?.upstream.kind !== "sfu" ||
      assignment.sfuPublicationGeneration !== slot.publicationGeneration ||
      phase === null
    ) {
      return true;
    }
    slot.decodedFrame = true;
    if (phase === "prepare") {
      this.sendPendingReady(slot);
      return slot.qualityProbe !== null || slot.readySent;
    }
    void this.queueTransition(() => this.promotePendingSfu(slot));
    return true;
  }

  private sendPendingReady(slot: ViewerSubscriberSlot): void {
    if (
      this.pending !== slot ||
      slot.failed ||
      slot.readySent ||
      !slot.decodedFrame ||
      (slot.qualityProbe !== null && slot.qualityResult !== "approved") ||
      (slot.qualityProbe !== null &&
        this.events.qualityProbeEligible?.() === false) ||
      this.route.getPhase() !== "prepare" ||
      this.route.getRevision() !== slot.revision
    ) {
      return;
    }
    slot.readySent = this.events.send({
      type: "route-ready",
      revision: slot.revision,
      phase: "prepare",
    });
  }

  private async promotePendingSfu(slot: ViewerSubscriberSlot): Promise<void> {
    const token = slot.activationToken;
    const assignment = this.route.getActiveAssignment();
    if (
      this.pending !== slot ||
      !slot.stream ||
      !slot.decodedFrame ||
      !token ||
      !this.route.owns(token, "active") ||
      assignment?.upstream.kind !== "sfu"
    ) {
      return;
    }
    slot.subscriber.stopDecodedFrameProof();
    this.pending = null;
    const previous = this.active;
    this.active = slot;
    if (!this.route.markMediaActive(token)) {
      this.active = previous;
      slot.failed = true;
      await disconnectSubscriber(slot.subscriber);
      return;
    }
    this.recovery = null;
    this.events.onSfuStream(slot.stream, assignment, true, slot.revision);
    if (previous && previous !== slot) {
      previous.failed = true;
      try {
        previous.subscriber.deactivate();
      } catch {
        // Disconnect remains the fail-closed cleanup path.
      }
      await disconnectSubscriber(previous.subscriber);
    }
  }

  private handleVideoAvailability(
    slot: ViewerSubscriberSlot,
    available: boolean,
  ): void {
    if (
      this.closed ||
      this.active !== slot ||
      slot.failed ||
      !slot.activated ||
      this.route.getMediaAssignment()?.upstream.kind !== "sfu"
    ) {
      return;
    }
    this.events.onSfuVideoAvailability?.(available, slot.revision);
  }

  private commitMedia(token: RouteOperationToken): void {
    if (!this.route.markMediaActive(token)) {
      return;
    }
    this.recovery = null;
  }

  private clearPending(): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.failed = true;
    void disconnectSubscriber(pending.subscriber);
  }

  private async retireActive(): Promise<void> {
    if (!this.active) {
      return;
    }
    const active = this.active;
    this.active = null;
    active.failed = true;
    this.events.onSfuUpdate?.(null, active.revision);
    await this.disconnectRetiredSubscriber(active);
  }

  private detachUnreferencedActive(
    assignment: ParticipantRouteAssignment,
  ): ViewerSubscriberSlot | null {
    const publicationGeneration =
      assignment.upstream.kind === "sfu"
        ? assignment.sfuPublicationGeneration
        : null;
    if (
      !this.active ||
      this.active.publicationGeneration === publicationGeneration
    ) {
      return null;
    }
    const active = this.active;
    this.active = null;
    active.failed = true;
    this.events.onSfuUpdate?.(null, active.revision);
    return active;
  }

  private async disconnectRetiredSubscriber(
    active: ViewerSubscriberSlot,
  ): Promise<void> {
    if (active.activated) {
      try {
        active.subscriber.deactivate();
      } catch {
        // Disconnect remains the fail-closed cleanup path.
      }
    }
    await disconnectSubscriber(active.subscriber);
  }

  private handleFailure(slot: ViewerSubscriberSlot): void {
    if (this.closed || slot.failed) {
      return;
    }
    const wasActive = this.active === slot;
    const wasPending = this.pending === slot;
    if (!wasActive && !wasPending) {
      slot.failed = true;
      return;
    }
    slot.failed = true;
    slot.subscriber.stopDecodedFrameProof();
    if (this.pending === slot) {
      this.pending = null;
    }
    if (wasActive) {
      this.active = null;
      this.events.onSfuUpdate?.(null, slot.revision);
    }

    const assignment = this.route.getPlannedAssignment();
    const revision = this.route.getRevision();
    const phase = this.route.getPhase();
    const matchesPlannedRoute =
      revision === slot.revision &&
      assignment?.upstream.kind === "sfu" &&
      assignment.sfuPublicationGeneration === slot.publicationGeneration;
    if (revision === null || phase === null) {
      return;
    }
    if (phase === "prepare") {
      const activeRevision = this.route.getActiveRevision();
      const activeAssignment = this.route.getActiveAssignment();
      if (wasActive) {
        if (
          activeRevision !== null &&
          activeAssignment?.upstream.kind === "sfu" &&
          activeAssignment.sfuPublicationGeneration === slot.publicationGeneration
        ) {
          this.routeFailed(activeRevision, "active", slot.connectionId);
        }
      } else if (matchesPlannedRoute) {
        this.routeFailed(revision, "prepare");
      }
      return;
    }
    if (!matchesPlannedRoute) {
      return;
    }
    if (
      this.recovery?.revision === revision &&
      this.recovery.refreshed
    ) {
      this.routeFailed(revision, "active", slot.connectionId);
      return;
    }
    this.requestRecovery(revision);
  }

  private failSubscriberSlot(slot: ViewerSubscriberSlot): void {
    if (this.pending !== slot && this.active !== slot) {
      slot.failed = true;
      return;
    }
    this.handleFailure(slot);
  }

  private requestRecovery(revision: number): void {
    if (!this.recovery || this.recovery.revision !== revision) {
      this.recovery = { revision, refreshed: false };
    }
    if (!this.recovery.refreshed) {
      if (this.events.send({ type: "refresh-sfu", revision })) {
        this.recovery.refreshed = true;
        return;
      }
    }
  }

  private currentPendingToken(
    slot: ViewerSubscriberSlot,
    original: RouteOperationToken,
  ): RouteOperationToken | null {
    if (this.route.owns(original)) {
      return original;
    }
    if (slot.phase !== "active") {
      return null;
    }
    const current = this.route.token();
    const assignment = this.route.getActiveAssignment();
    return current &&
      this.route.owns(current, "active") &&
      assignment?.upstream.kind === "sfu" &&
      assignment.sfuPublicationGeneration === slot.publicationGeneration
      ? current
      : null;
  }

  private routeFailed(
    revision: number,
    phase: MediaRoutePhase,
    connectionId: string | null = null,
  ): boolean {
    return this.events.send({
      type: "route-failed",
      revision,
      phase,
      connectionId,
    });
  }

}

function sameUpstream(
  current: ParticipantRouteAssignment | null,
  next: ParticipantRouteAssignment,
): boolean {
  if (!current || current.upstream.kind !== next.upstream.kind) {
    return false;
  }
  if (current.upstream.kind === "peer" && next.upstream.kind === "peer") {
    return current.upstream.peerId === next.upstream.peerId;
  }
  if (current.upstream.kind === "sfu" && next.upstream.kind === "sfu") {
    return (
      current.sfuPublicationGeneration === next.sfuPublicationGeneration
    );
  }
  return current.upstream.kind === "none";
}

async function disconnectSubscriber(
  subscriber: ViewerSubscriberTransport,
): Promise<void> {
  subscriber.stopDecodedFrameProof();
  await subscriber.disconnect().catch(() => undefined);
}
