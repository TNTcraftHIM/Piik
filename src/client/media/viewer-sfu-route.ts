import type {
  ClientMessage,
  MediaRoutePhase,
  ParticipantRouteAssignment,
  ServerMessage,
} from "../../shared/protocol";
import { SfuSubscriber } from "../sfu/subscriber";
import type { ConnectionMetrics } from "../types";
import type { SfuConnectionConfig } from "../sfu/publisher";
import {
  MediaRouteTransition,
  reportActivePeerRouteFailure,
  type RouteOperationToken,
  type RouteUpdateInput,
  type RouteUpdateResult,
} from "./route-transition";

interface ViewerSubscriberTransport {
  connect(config: SfuConnectionConfig): Promise<boolean>;
  activate(): boolean;
  deactivate(): boolean;
  disconnect(): Promise<void>;
}

interface ViewerSubscriberSlot {
  revision: number;
  subscriber: ViewerSubscriberTransport;
  connected: boolean;
  activated: boolean;
  mediaAvailable: boolean;
  failed: boolean;
  activationToken: RouteOperationToken | null;
}

interface ViewerSfuRouteEvents {
  activatePeer: (
    assignment: ParticipantRouteAssignment,
    revision?: number,
  ) => boolean | void | Promise<boolean | void>;
  preparePeer?: (assignment: ParticipantRouteAssignment | null, revision?: number) => void;
  resetMedia?: () => void;
  reconcileSfuChildren: (childPeerIds: string[]) => void;
  onSfuStream: (
    stream: MediaStream,
    assignment: ParticipantRouteAssignment,
    initialVideoStream: boolean,
  ) => void;
  onSfuVideoAvailability?: (available: boolean) => void;
  onSfuUpdate?: (metrics: ConnectionMetrics | null) => void;
  onSfuState?: (state: "connected" | "reconnecting") => void;
  onHealthySfu?: (revision: number) => void;
  send: (message: ClientMessage) => boolean;
  createSubscriber?: (
    events: {
      onStream: (stream: MediaStream | null) => void;
      onVideoAvailability: (available: boolean) => void;
      onStats: (metrics: ConnectionMetrics) => void;
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
  private peerProbeRevision: number | null = null;
  private failedPeerProbe: { revision: number; parentPeerId: string; connectionId: string } | null = null;
  private healthySfuWindows: number | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private resyncGeneration = 0;
  private resyncing = false;
  private closed = false;

  constructor(private readonly events: ViewerSfuRouteEvents) {}

  accept(update: RouteUpdateInput, acknowledge = true): RouteUpdateResult {
    if (this.closed) {
      return "stale";
    }
    const previousRevision = this.route.getRevision();
    const result = this.route.accept(update);
    if (result === "stale") {
      return result;
    }
    const rearmHealthySfu =
      result === "duplicate" &&
      update.phase === "active" &&
      update.assignment.upstream.kind === "sfu";
    if (previousRevision !== update.revision) {
      this.recovery = null;
      this.peerProbeRevision = null;
      this.failedPeerProbe = null;
      this.healthySfuWindows = null;
    }
    if (update.phase === "prepare") {
      const mediaUpstream = this.route.getMediaAssignment()?.upstream;
      if (
        update.assignment.upstream.kind === "peer" &&
        (mediaUpstream?.kind !== "peer" ||
          mediaUpstream.peerId !== update.assignment.upstream.peerId)
      ) {
        this.peerProbeRevision = update.revision;
        this.events.preparePeer?.(update.assignment, update.revision);
      }
      if (update.assignment.upstream.kind !== "sfu") {
        this.events.reconcileSfuChildren(update.assignment.childPeerIds);
      }
      if (this.pending?.revision !== update.revision) {
        this.clearPending();
      }
      if (update.assignment.upstream.kind !== "sfu") {
        this.clearPending();
      }
      return result;
    }

    const token = this.route.token();
    if (!token) {
      return result;
    }
    if (this.peerProbeRevision !== update.revision) {
      this.preparePeer(update.assignment);
    }
    if (this.resyncing) {
      return result;
    }
    void this.queueActiveRoute(token, acknowledge);
    if (rearmHealthySfu) {
      this.armHealthySfuReselection(update.revision);
    }
    return result;
  }

  async resyncAuthoritative(
    update: RouteUpdateInput,
  ): Promise<RouteUpdateResult> {
    if (this.closed) {
      return "stale";
    }
    this.peerProbeRevision = this.failedPeerProbe = null;
    if (!this.active && !this.pending) {
      const result = this.accept(update, false);
      if (result !== "stale") {
        return result;
      }
    }

    const resyncGeneration = ++this.resyncGeneration;
    this.resyncing = true;
    this.route.reset();
    this.recovery = null;
    this.healthySfuWindows = null;
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
    if (this.closed || !this.route.acceptsConfig(message.revision)) {
      return;
    }
    const token = this.route.token();
    const assignment = this.route.getPlannedAssignment();
    const phase = this.route.getPhase();
    if (!token || !phase || assignment?.upstream.kind !== "sfu") {
      return;
    }

    if (this.active?.revision === message.revision && this.active.activated) {
      if (phase === "prepare") {
        this.ready(message.revision, "prepare");
      }
      return;
    }
    if (this.pending?.revision === message.revision && !this.pending.failed) {
      if (this.pending.connected && phase === "prepare") {
        this.ready(message.revision, "prepare");
      }
      return;
    }

    this.clearPending();
    let slot: ViewerSubscriberSlot;
    const subscriberEvents = {
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
          this.events.onSfuUpdate?.(metrics);
          if (this.healthySfuWindows !== null && this.healthySfuWindows >= 0) {
            if (
              (metrics.intervalPacketsReceived ?? 0) <= 0 ||
              (metrics.intervalFramesDecoded ?? 0) <= 0
            ) {
              this.healthySfuWindows = null;
            } else if (++this.healthySfuWindows === 2) {
              this.healthySfuWindows = null;
              this.events.onHealthySfu?.(slot.revision);
            }
          }
        }
      },
      onState: (state: "connected" | "reconnecting") => {
        if (this.active === slot && !slot.failed) {
          this.events.onSfuState?.(state);
          if (state === "reconnecting") {
            this.healthySfuWindows = -1;
          } else if (this.healthySfuWindows === -1) {
            this.healthySfuWindows = 0;
          }
        }
      },
      onDisconnected: () => this.handleFailure(slot),
    };
    const subscriber =
      this.events.createSubscriber?.(subscriberEvents) ??
      new SfuSubscriber(subscriberEvents);
    slot = {
      revision: message.revision,
      subscriber,
      connected: false,
      activated: false,
      mediaAvailable: false,
      failed: false,
      activationToken: null,
    };
    this.pending = slot;
    try {
      const connected = await subscriber.connect({
        url: message.url,
        token: message.token,
      });
      if (!connected) {
        if (this.pending === slot && this.route.owns(token)) {
          this.handleFailure(slot);
        }
        await disconnectSubscriber(subscriber);
        return;
      }
      if (this.pending !== slot || !this.route.owns(token)) {
        await disconnectSubscriber(subscriber);
        return;
      }
      slot.connected = true;
      if (phase === "prepare") {
        this.ready(message.revision, "prepare");
      } else if (!this.resyncing) {
        await this.queueActiveRoute(token, true);
      }
    } catch {
      await disconnectSubscriber(subscriber);
      this.handleFailure(slot);
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

  reportPeerProbeFailure(parentPeerId: string, connectionId: string, ready: boolean): boolean {
    const revision = this.peerProbeRevision, phase = this.route.getPhase();
    const upstream = this.route.getPlannedAssignment()?.upstream;
    if (revision === null || phase === null ||
      upstream?.kind !== "peer" || upstream.peerId !== parentPeerId) return false;
    if (ready) this.failedPeerProbe = { revision, parentPeerId, connectionId };
    this.events.send({ type: "route-failed", revision, phase, connectionId });
    return true;
  }

  armHealthySfuReselection(revision: number): void {
    if (
      this.route.getRevision() === revision &&
      this.route.getPlannedAssignment()?.upstream.kind === "sfu"
    ) {
      this.healthySfuWindows = 0;
    }
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
    this.peerProbeRevision = null;
    this.failedPeerProbe = null;
    this.healthySfuWindows = null;
    this.events.preparePeer?.(null);
    await this.queueTransition(async () => {
      const pending = this.pending;
      const active = this.active;
      this.pending = null;
      this.active = null;
      this.events.onSfuUpdate?.(null);
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
  ): Promise<void> {
    return this.queueTransition(async () => {
      if (this.closed || this.resyncing || !this.route.owns(token, "active")) {
        return;
      }
      const assignment = this.route.getActiveAssignment();
      if (!assignment) {
        return;
      }
      if (assignment.upstream.kind === "sfu") {
        this.events.reconcileSfuChildren(assignment.childPeerIds);
        const mediaAssignment = this.route.getMediaAssignment();
        if (
          mediaAssignment?.upstream.kind === "sfu" &&
          this.active?.activated &&
          this.pending?.revision !== token.revision
        ) {
          this.clearPending();
          this.active.revision = token.revision;
          this.commitMedia(token, acknowledge);
          return;
        }
        await this.activateSfu(token, acknowledge);
        return;
      }

      const probeRevision = this.peerProbeRevision;
      const failedProbe = this.failedPeerProbe;
      if (failedProbe?.revision === token.revision &&
        assignment.upstream.kind === "peer" &&
        assignment.upstream.peerId === failedProbe.parentPeerId) {
        this.failedPeerProbe = null;
        this.events.send({ type: "route-failed", revision: token.revision,
          phase: "active", connectionId: failedProbe.connectionId });
        return;
      }
      const promoted =
        probeRevision === token.revision
          ? await this.events.activatePeer(assignment, token.revision)
          : false;
      if (probeRevision === token.revision && promoted !== true) {
        return;
      }
      this.peerProbeRevision = null;
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
      this.commitMedia(token, acknowledge);
    });
  }

  private queueTransition(work: () => Promise<void>): Promise<void> {
    const next = this.transitionTail.then(work, work);
    this.transitionTail = next.catch(() => undefined);
    return this.transitionTail;
  }

  private async activateSfu(
    token: RouteOperationToken,
    acknowledge: boolean,
  ): Promise<void> {
    if (this.active?.revision === token.revision && this.active.activated) {
      return;
    }
    const pending = this.pending;
    if (!pending || pending.revision !== token.revision || !pending.connected) {
      if (acknowledge && this.route.owns(token, "active")) {
        this.requestRecovery(token.revision);
      }
      return;
    }
    pending.activationToken = token;
    try {
      if (!pending.subscriber.activate()) {
        await disconnectSubscriber(pending.subscriber);
        this.handleFailure(pending);
        return;
      }
      pending.activated = true;
    } catch {
      await disconnectSubscriber(pending.subscriber);
      this.handleFailure(pending);
    }
  }

  private handleStream(slot: ViewerSubscriberSlot, stream: MediaStream): void {
    if (this.closed || slot.failed || !slot.activated) {
      return;
    }
    if (this.active === slot) {
      const assignment = this.route.getMediaAssignment();
      if (assignment?.upstream.kind === "sfu") {
        const recovered = !slot.mediaAvailable;
        slot.mediaAvailable = true;
        this.events.onSfuStream(stream, assignment, false);
        if (recovered) {
          this.ready(slot.revision, "active");
        }
      }
      return;
    }
    const token = slot.activationToken;
    const assignment = this.route.getActiveAssignment();
    if (
      this.pending !== slot ||
      !token ||
      !this.route.owns(token, "active") ||
      assignment?.upstream.kind !== "sfu"
    ) {
      return;
    }

    this.pending = null;
    const previous = this.active;
    this.active = slot;
    if (!this.route.markMediaActive(token)) {
      this.active = previous;
      void disconnectSubscriber(slot.subscriber);
      return;
    }
    this.recovery = null;
    slot.mediaAvailable = true;
    this.events.onSfuStream(stream, assignment, true);
    if (previous && previous !== slot) {
      try {
        previous.subscriber.deactivate();
      } catch {
        // Disconnect remains the fail-closed cleanup path.
      }
      void disconnectSubscriber(previous.subscriber);
    }
    this.ready(token.revision, "active");
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
    const changed = slot.mediaAvailable !== available;
    slot.mediaAvailable = available;
    this.events.onSfuVideoAvailability?.(available);
    if (!changed) {
      return;
    }
    if (available) {
      this.ready(slot.revision, "active");
    } else {
      this.events.send({
        type: "route-media-unavailable",
        revision: slot.revision,
      });
    }
  }

  private commitMedia(token: RouteOperationToken, acknowledge: boolean): void {
    if (!this.route.markMediaActive(token)) {
      return;
    }
    this.recovery = null;
    const assignment = this.route.getMediaAssignment();
    if (
      acknowledge &&
      (assignment?.upstream.kind !== "sfu" || this.active?.mediaAvailable === true)
    ) {
      this.ready(token.revision, "active");
    }
  }

  private clearPending(): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    void disconnectSubscriber(pending.subscriber);
  }

  private async retireActive(): Promise<void> {
    if (!this.active) {
      return;
    }
    const active = this.active;
    this.active = null;
    this.events.onSfuUpdate?.(null);
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
    slot.failed = true;
    if (this.pending === slot) {
      this.pending = null;
    }
    if (wasActive) {
      this.active = null;
      this.events.onSfuUpdate?.(null);
    }

    const assignment = this.route.getPlannedAssignment();
    const revision = this.route.getRevision();
    const phase = this.route.getPhase();
    const matchesPlannedRoute =
      revision === slot.revision && assignment?.upstream.kind === "sfu";
    if (revision === null || phase === null) {
      return;
    }
    if (phase === "prepare") {
      if (matchesPlannedRoute || wasActive) {
        this.routeFailed(revision, "prepare");
      }
      return;
    }
    if (!matchesPlannedRoute) {
      return;
    }
    this.requestRecovery(revision);
  }

  private requestRecovery(revision: number): void {
    if (!this.recovery || this.recovery.revision !== revision) {
      this.recovery = { revision, refreshed: false };
    }
    if (!this.recovery.refreshed) {
      this.recovery.refreshed = true;
      if (this.events.send({ type: "refresh-sfu", revision })) {
        return;
      }
    }
    this.routeFailed(revision, "active");
  }

  private routeFailed(revision: number, phase: MediaRoutePhase): void {
    this.events.send({
      type: "route-failed",
      revision,
      phase,
      connectionId: null,
    });
  }

  private ready(revision: number, phase: MediaRoutePhase): void {
    this.events.send({ type: "route-ready", revision, phase });
  }
}

async function disconnectSubscriber(
  subscriber: ViewerSubscriberTransport,
): Promise<void> {
  await subscriber.disconnect().catch(() => undefined);
}
