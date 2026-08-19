import type {
  ClientMessage,
  MediaRoutePhase,
  ParticipantRouteAssignment,
  ServerMessage,
} from "../../shared/protocol";
import { SfuPublisher, type SfuConnectionConfig } from "../sfu/publisher";
import type {
  QualityProfile,
  VideoSenderParameterReadback,
} from "./quality";
import {
  MediaRouteTransition,
  type RouteOperationToken,
  type RouteUpdateInput,
  type RouteUpdateResult,
} from "./route-transition";

interface HostPublisherTransport {
  connect(config: SfuConnectionConfig): Promise<boolean>;
  activate(stream: MediaStream, profile: QualityProfile): Promise<boolean>;
  deactivate(): Promise<boolean>;
  replaceStream(stream: MediaStream): Promise<boolean>;
  updateProfile(profile: QualityProfile): Promise<boolean>;
  getQualityWarning?(): string | null;
  getSenderParameters?(): VideoSenderParameterReadback | null;
  disconnect(): Promise<void>;
}

interface HostPublisherSlot {
  revision: number;
  publicationGeneration: string;
  publisher: HostPublisherTransport;
  connected: boolean;
  active: boolean;
  failed: boolean;
  acknowledgeActive: boolean;
}

interface HostSfuRouteEvents {
  getStream: () => MediaStream | null;
  getProfile: () => QualityProfile;
  reconcileChildren: (childPeerIds: string[]) => void;
  send: (message: ClientMessage) => boolean;
  createPublisher?: (onDisconnected: () => void) => HostPublisherTransport;
}

export class HostSfuRoute {
  private readonly route = new MediaRouteTransition();
  private pending: HostPublisherSlot | null = null;
  private active: HostPublisherSlot | null = null;
  private recovery: { revision: number; refreshed: boolean } | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private resyncGeneration = 0;
  private resyncing = false;
  private closed = false;

  constructor(private readonly events: HostSfuRouteEvents) {}

  accept(update: RouteUpdateInput, acknowledge = true): RouteUpdateResult {
    if (this.closed) {
      return "stale";
    }
    const previousRevision = this.route.getRevision();
    const result = this.route.accept(update);
    if (result === "stale") {
      return result;
    }
    if (previousRevision !== update.revision) {
      this.recovery = null;
    }
    if (update.phase === "prepare") {
      if (
        this.pending &&
        (this.pending.revision !== update.revision ||
          this.pending.publicationGeneration !==
            update.assignment.sfuPublicationGeneration)
      ) {
        this.clearPending();
      }
      if (update.assignment.sfuPublicationGeneration === null) {
        this.clearPending();
      }
      return result;
    }

    const token = this.route.token();
    if (token && !this.resyncing) {
      void this.queueActivation(token, acknowledge);
    }
    return result;
  }

  async acceptAndWait(
    update: RouteUpdateInput,
    acknowledge = true,
  ): Promise<RouteUpdateResult> {
    const result = this.accept(update, acknowledge);
    await this.transitionTail;
    return result;
  }

  async resyncAuthoritative(
    update: RouteUpdateInput,
  ): Promise<RouteUpdateResult> {
    const result = this.accept(update, false);
    if (result !== "stale" || this.closed) {
      await this.transitionTail;
      return result;
    }

    const resyncGeneration = ++this.resyncGeneration;
    this.resyncing = true;
    this.route.reset();
    this.recovery = null;
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
    this.events.reconcileChildren([]);

    await this.queueTransition(async () => {
      if (active?.active) {
        await active.publisher.deactivate().catch(() => false);
      }
      if (active) {
        await disconnectPublisher(active.publisher);
      }
      if (pending && pending !== active) {
        await disconnectPublisher(pending.publisher);
      }
    });

    if (this.closed || this.resyncGeneration !== resyncGeneration) {
      return "stale";
    }
    this.resyncing = false;
    const token = this.route.token();
    if (token && this.route.getPhase() === "active") {
      await this.queueActivation(token, false);
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
    const publicationGeneration = assignment?.sfuPublicationGeneration;
    if (!token || !phase || !assignment || !publicationGeneration) {
      return;
    }

    if (this.active?.publicationGeneration === publicationGeneration) {
      this.active.revision = message.revision;
      if (phase === "prepare" && this.active.connected) {
        this.ready(message.revision, "prepare");
      } else if (phase === "active" && this.active.active) {
        await this.queueActivation(token, true);
      }
      return;
    }
    if (
      this.pending?.revision === message.revision &&
      this.pending.publicationGeneration === publicationGeneration &&
      !this.pending.failed
    ) {
      if (this.pending.connected && phase === "prepare") {
        this.ready(message.revision, "prepare");
      }
      return;
    }

    this.clearPending();
    let slot: HostPublisherSlot;
    const publisher =
      this.events.createPublisher?.(() => this.handleFailure(slot)) ??
      new SfuPublisher({ onDisconnected: () => this.handleFailure(slot) });
    slot = {
      revision: message.revision,
      publicationGeneration,
      publisher,
      connected: false,
      active: false,
      failed: false,
      acknowledgeActive: false,
    };
    this.pending = slot;
    try {
      const connected = await publisher.connect({
        url: message.url,
        token: message.token,
      });
      if (!connected) {
        if (this.pending === slot && this.route.owns(token)) {
          this.handleFailure(slot);
        }
        await disconnectPublisher(publisher);
        return;
      }
      if (this.pending !== slot || !this.route.owns(token)) {
        await disconnectPublisher(publisher);
        return;
      }
      slot.connected = true;
      if (phase === "prepare") {
        this.ready(message.revision, "prepare");
      } else if (!this.resyncing) {
        await this.queueActivation(token, true);
      }
    } catch {
      await disconnectPublisher(publisher);
      this.handleFailure(slot);
    }
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    return this.active?.active
      ? this.active.publisher.updateProfile(profile).catch(() => false)
      : Promise.resolve(true);
  }

  getQualityWarning(): string | null {
    return this.active?.active
      ? (this.active.publisher.getQualityWarning?.() ?? null)
      : null;
  }

  getSenderParameters(): VideoSenderParameterReadback | null {
    return this.active?.active
      ? (this.active.publisher.getSenderParameters?.() ?? null)
      : null;
  }

  replaceStream(stream: MediaStream): Promise<boolean> {
    return this.active
      ? this.active.publisher.replaceStream(stream).catch(() => false)
      : Promise.resolve(true);
  }

  async failActivePublisher(): Promise<void> {
    await this.queueTransition(async () => {
      const slot = this.active;
      if (!slot) {
        return;
      }
      this.active = null;
      await disconnectPublisher(slot.publisher);
      this.handleFailure(slot);
    });
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
    await this.queueTransition(async () => {
      const pending = this.pending;
      const active = this.active;
      this.pending = null;
      this.active = null;
      if (active?.active) {
        await active.publisher.deactivate().catch(() => false);
      }
      await Promise.all([
        pending ? disconnectPublisher(pending.publisher) : undefined,
        active && active !== pending
          ? disconnectPublisher(active.publisher)
          : undefined,
      ]);
    });
  }

  private queueActivation(
    token: RouteOperationToken,
    acknowledge: boolean,
  ): Promise<void> {
    return this.queueTransition(async () => {
      if (this.closed || this.resyncing || !this.route.owns(token, "active")) {
        return;
      }
      const assignment = this.route.getActiveAssignment();
      if (assignment) {
        await this.activate(assignment, token, acknowledge);
      }
    });
  }

  private queueTransition(work: () => Promise<void>): Promise<void> {
    const next = this.transitionTail.then(work, work);
    this.transitionTail = next.catch(() => undefined);
    return this.transitionTail;
  }

  private async activate(
    assignment: ParticipantRouteAssignment,
    token: RouteOperationToken,
    acknowledge: boolean,
  ): Promise<void> {
    const publicationGeneration = assignment.sfuPublicationGeneration;
    if (publicationGeneration === null) {
      this.clearPending();
      await this.retireActive();
      if (!this.route.owns(token, "active")) {
        return;
      }
      this.events.reconcileChildren(assignment.childPeerIds);
      this.commitMedia(token, acknowledge);
      return;
    }

    this.events.reconcileChildren(assignment.childPeerIds);
    if (
      this.active &&
      !this.active.failed &&
      this.active.publicationGeneration === publicationGeneration
    ) {
      this.active.revision = token.revision;
      this.clearPending();
      if (this.active.active) {
        this.commitMedia(token, acknowledge);
      } else {
        this.active.acknowledgeActive ||= acknowledge;
      }
      return;
    }

    const pending = this.pending;
    if (
      !pending ||
      pending.revision !== token.revision ||
      pending.publicationGeneration !== publicationGeneration ||
      !pending.connected
    ) {
      await this.retireActive();
      if (acknowledge && this.route.owns(token, "active")) {
        this.requestRecovery(token.revision);
      }
      return;
    }

    await this.retireActive(pending);
    if (!this.route.owns(token, "active")) {
      this.clearPending(pending);
      return;
    }
    this.pending = null;
    this.active = pending;
    pending.acknowledgeActive ||= acknowledge;
    const publishedStream = this.events.getStream();
    const publishedProfile = this.events.getProfile();
    if (!publishedStream) {
      await disconnectPublisher(pending.publisher);
      this.handleFailure(pending);
      return;
    }

    try {
      const activated = await pending.publisher.activate(
        publishedStream,
        publishedProfile,
      );
      const activeToken = this.currentActiveToken(pending);
      if (!activated || !activeToken) {
        if (this.active === pending) {
          this.active = null;
        }
        await disconnectPublisher(pending.publisher);
        if (!activated && activeToken) {
          this.handleFailure(pending);
        }
        return;
      }
      pending.active = true;

      const latestStream = this.events.getStream();
      if (
        latestStream &&
        latestStream !== publishedStream &&
        !(await pending.publisher.replaceStream(latestStream))
      ) {
        await disconnectPublisher(pending.publisher);
        this.handleFailure(pending);
        return;
      }
      const latestProfile = this.events.getProfile();
      if (
        latestProfile !== publishedProfile &&
        !(await pending.publisher.updateProfile(latestProfile))
      ) {
        await disconnectPublisher(pending.publisher);
        this.handleFailure(pending);
        return;
      }
    } catch {
      await disconnectPublisher(pending.publisher);
      this.handleFailure(pending);
      return;
    }

    const activeToken = this.currentActiveToken(pending);
    if (!activeToken) {
      if (this.active === pending) {
        this.active = null;
      }
      await disconnectPublisher(pending.publisher);
      return;
    }
    if (!this.route.owns(token, "active")) {
      pending.acknowledgeActive = false;
      return;
    }
    const acknowledgeActive = pending.acknowledgeActive;
    pending.acknowledgeActive = false;
    this.commitMedia(activeToken, acknowledgeActive);
  }

  private currentActiveToken(
    slot: HostPublisherSlot,
  ): RouteOperationToken | null {
    const token = this.route.token();
    const assignment = this.route.getActiveAssignment();
    if (
      this.active !== slot ||
      !token ||
      this.route.getPhase() !== "active" ||
      assignment?.sfuPublicationGeneration !== slot.publicationGeneration
    ) {
      return null;
    }
    return token;
  }

  private commitMedia(token: RouteOperationToken, acknowledge: boolean): void {
    if (!this.route.markMediaActive(token)) {
      return;
    }
    this.recovery = null;
    if (acknowledge) {
      this.ready(token.revision, "active");
    }
  }

  private clearPending(expected?: HostPublisherSlot): void {
    if (!this.pending || (expected && this.pending !== expected)) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    void disconnectPublisher(pending.publisher);
  }

  private async retireActive(except?: HostPublisherSlot): Promise<void> {
    if (!this.active || this.active === except) {
      return;
    }
    const active = this.active;
    this.active = null;
    if (active.active) {
      await active.publisher.deactivate().catch(() => false);
    }
    await disconnectPublisher(active.publisher);
  }

  private handleFailure(slot: HostPublisherSlot): void {
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
    }

    const assignment = this.route.getPlannedAssignment();
    const revision = this.route.getRevision();
    const phase = this.route.getPhase();
    const matchesPlannedRoute =
      revision === slot.revision &&
      assignment?.sfuPublicationGeneration === slot.publicationGeneration;
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

async function disconnectPublisher(
  publisher: HostPublisherTransport,
): Promise<void> {
  await publisher.disconnect().catch(() => undefined);
}
