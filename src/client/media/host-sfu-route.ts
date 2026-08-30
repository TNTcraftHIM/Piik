import { say, type CopyKey } from "../ui/copy";
import type {
  ClientMessage,
  MediaRoutePhase,
  ParticipantRouteAssignment,
  ServerMessage,
} from "../../shared/protocol";
import {
  SfuPublisher,
  type SfuConnectionConfig,
  type SfuPublisherFailureStage,
} from "../sfu/publisher";
import type { ConnectionMetrics } from "../types";
import type { BrowserVideoCodec } from "../webrtc/video-codec";
import type { QualityProfile } from "./quality";
import { qualitySettingsEqual } from "./quality";
import {
  MediaRouteTransition,
  type RouteOperationToken,
  type RouteUpdateInput,
  type RouteUpdateResult,
} from "./route-transition";

interface HostPublisherTransport {
  connect(config: SfuConnectionConfig): Promise<boolean>;
  activate(
    stream: MediaStream,
    profile: QualityProfile,
    videoCodec?: BrowserVideoCodec,
  ): Promise<boolean>;
  deactivate(): Promise<boolean>;
  replaceStream(stream: MediaStream): Promise<boolean>;
  updateProfile(profile: QualityProfile): Promise<boolean>;
  setPaused(paused: boolean): void;
  getQualityWarning?(): string | null;
  getFailureStage?(): SfuPublisherFailureStage | null;
  disconnect(): Promise<void>;
}

interface HostPublisherSlot {
  revision: number;
  publicationGeneration: string;
  publisher: HostPublisherTransport;
  connected: boolean;
  active: boolean;
  failed: boolean;
}

interface HostSfuRouteEvents {
  getStream: () => MediaStream | null;
  getProfile: () => QualityProfile;
  getVideoCodec: () => BrowserVideoCodec;
  reconcileChildren: (childPeerIds: string[]) => void;
  send: (message: ClientMessage) => boolean;
  onSenderUpdate?: (
    metrics: ConnectionMetrics,
    revision: number,
    publicationGeneration: string,
  ) => void;
  createPublisher?: (
    onDisconnected: () => void,
    onStats: (metrics: ConnectionMetrics | null) => void,
  ) => HostPublisherTransport;
}

export class HostSfuRoute {
  private readonly route = new MediaRouteTransition();
  private pending: HostPublisherSlot | null = null;
  private active: HostPublisherSlot | null = null;
  private recovery: { revision: number; refreshed: boolean } | null = null;
  private lastFailureStage: SfuPublisherFailureStage | null = null;
  private transitionTail: Promise<void> = Promise.resolve();
  private resyncGeneration = 0;
  private resyncing = false;
  private paused = false;
  private closed = false;

  constructor(private readonly events: HostSfuRouteEvents) {}

  accept(update: RouteUpdateInput): RouteUpdateResult {
    if (this.closed) {
      return "stale";
    }
    const previousRevision = this.route.getRevision();
    const result = this.route.accept(update);
    if (result === "stale") {
      return result;
    }
    const pausedActiveReconciliation =
      this.paused && update.phase === "active" && result !== "duplicate";
    const retiredActive = pausedActiveReconciliation
      ? this.detachUnreferencedActive(
          update.assignment.sfuPublicationGeneration,
        )
      : null;
    if (pausedActiveReconciliation) {
      this.events.reconcileChildren(update.assignment.childPeerIds);
    }
    if (this.paused && update.phase === "prepare") {
      this.clearPending();
      return result;
    }
    if (previousRevision !== update.revision) {
      this.recovery = null;
      this.lastFailureStage = null;
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
        if (this.route.getMediaAssignment()?.sfuPublicationGeneration) {
          this.events.reconcileChildren(update.assignment.childPeerIds);
        }
      }
      return result;
    }

    const token = this.route.token();
    if (retiredActive) {
      void this.queueTransition(() =>
        this.disconnectRetiredPublisher(retiredActive),
      );
    }
    if (token && !this.resyncing) {
      void this.queueActivation(token, this.paused);
    }
    return result;
  }

  async acceptAndWait(
    update: RouteUpdateInput,
  ): Promise<RouteUpdateResult> {
    const result = this.accept(update);
    await this.transitionTail;
    return result;
  }

  async resyncAuthoritative(
    update: RouteUpdateInput,
  ): Promise<RouteUpdateResult> {
    this.lastFailureStage = null;
    const result = this.accept(update);
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
      await this.queueActivation(token);
    }
    return accepted;
  }

  async acceptConfig(
    message: Extract<ServerMessage, { type: "sfu-config" }>,
  ): Promise<void> {
    if (
      this.closed ||
      !this.route.acceptsConfig(message.revision) ||
      this.paused
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
      !assignment ||
      !publicationGeneration ||
      (phase === "prepare" && candidate?.transport !== "sfu")
    ) {
      return;
    }
    if (this.active?.publicationGeneration === publicationGeneration) {
      this.active.revision = message.revision;
      if (phase === "active" && this.active.active) {
        await this.queueActivation(token);
      }
      return;
    }
    if (
      this.pending?.revision === message.revision &&
      this.pending.publicationGeneration === publicationGeneration &&
      !this.pending.failed
    ) {
      return;
    }

    this.clearPending();
    let slot: HostPublisherSlot;
    const publisher =
      this.events.createPublisher?.(
        () => this.failPublisherSlot(slot),
        (metrics) => this.handlePublisherStats(slot, metrics),
      ) ??
      new SfuPublisher({
        onDisconnected: () => this.failPublisherSlot(slot),
        onStats: (metrics) => this.handlePublisherStats(slot, metrics),
      });
    slot = {
      revision: message.revision,
      publicationGeneration,
      publisher,
      connected: false,
      active: false,
      failed: false,
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
        } else {
          if (this.pending === slot) {
            this.pending = null;
          }
          slot.failed = true;
        }
        await disconnectPublisher(publisher);
        return;
      }
      if (this.pending !== slot || !this.route.owns(token)) {
        if (this.pending === slot) {
          this.pending = null;
        }
        slot.failed = true;
        await disconnectPublisher(publisher);
        return;
      }
      slot.connected = true;
      let prepared = false;
      await this.queueTransition(async () => {
        if (this.pending !== slot || !this.route.owns(token)) {
          if (this.pending === slot) {
            this.pending = null;
          }
          slot.failed = true;
          await disconnectPublisher(publisher);
          return;
        }
        prepared = await this.preparePublisher(slot);
      });
      if (!prepared) {
        return;
      }
      if (phase === "active" && !this.resyncing) {
        await this.queueActivation(token);
      }
    } catch {
      this.failPublisherSlot(slot);
      await disconnectPublisher(publisher);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const slot of this.publishingSlots()) {
      slot.publisher.setPaused(paused);
    }
    if (paused) {
      this.clearPending();
    }
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    const slots = this.publishingSlots();
    return slots.length === 0
      ? Promise.resolve(true)
      : Promise.all(
          slots.map((slot) =>
            slot.publisher
              .updateProfile(profile)
              .catch(() => false),
          ),
        ).then((results) => results.every(Boolean));
  }

  getQualityWarning(): string | null {
    if (this.active?.active) {
      return this.active.publisher.getQualityWarning?.() ?? null;
    }
    return this.lastFailureStage
      ? sfuFailureWarning(this.lastFailureStage)
      : null;
  }

  async replaceStream(stream: MediaStream): Promise<boolean> {
    const slots = this.publishingSlots();
    const initialActive = this.active;
    if (slots.length === 0) {
      return true;
    }

    const results = await Promise.all(
      slots.map((slot) => slot.publisher.replaceStream(stream).catch(() => false)),
    );
    let replaced = true;
    await this.queueTransition(async () => {
      const currentActive = this.active;
      if (currentActive) {
        const activeIndex = slots.indexOf(currentActive);
        replaced = activeIndex < 0 || results[activeIndex] === true;
      } else if (initialActive) {
        const activeIndex = slots.indexOf(initialActive);
        const stillPlanned =
          this.route.getPlannedAssignment()?.sfuPublicationGeneration ===
          initialActive.publicationGeneration;
        replaced =
          activeIndex < 0 || results[activeIndex] === true || !stillPlanned;
      }

      for (const [index, slot] of slots.entries()) {
        if (results[index] === false) {
          this.failPublisherSlot(slot);
          await disconnectPublisher(slot.publisher);
        }
      }
    });
    return replaced;
  }

  private publishingSlots(): HostPublisherSlot[] {
    return [...new Set([this.active, this.pending])].filter(
      (slot): slot is HostPublisherSlot =>
        slot !== null && slot.active && !slot.failed,
    );
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
      if (pending) {
        pending.failed = true;
      }
      if (active) {
        active.failed = true;
      }
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
    retireUnreferenced = false,
  ): Promise<void> {
    return this.queueTransition(async () => {
      if (this.closed || this.resyncing || !this.route.owns(token, "active")) {
        return;
      }
      const assignment = this.route.getActiveAssignment();
      if (assignment) {
        if (
          retireUnreferenced &&
          this.active?.publicationGeneration !==
            assignment.sfuPublicationGeneration
        ) {
          await this.retireActive();
          if (!this.route.owns(token, "active")) {
            return;
          }
        }
        await this.activate(assignment, token);
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
  ): Promise<void> {
    const publicationGeneration = assignment.sfuPublicationGeneration;
    if (publicationGeneration === null) {
      this.clearPending();
      await this.retireActive();
      if (!this.route.owns(token, "active")) {
        return;
      }
      this.events.reconcileChildren(assignment.childPeerIds);
      this.commitMedia(token);
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
        this.commitMedia(token);
      }
      return;
    }

    const pending = this.pending;
    if (
      !pending ||
      pending.revision !== token.revision ||
      pending.publicationGeneration !== publicationGeneration ||
      !pending.connected ||
      !pending.active
    ) {
      if (this.route.owns(token, "active")) {
        this.requestRecovery(token.revision);
      }
      return;
    }

    this.pending = null;
    const previous = this.active;
    this.active = pending;
    if (!this.route.markMediaActive(token)) {
      this.active = previous;
      pending.failed = true;
      await disconnectPublisher(pending.publisher);
      return;
    }
    this.lastFailureStage = null;
    this.recovery = null;
    if (previous && previous !== pending) {
      previous.failed = true;
      if (previous.active) {
        await previous.publisher.deactivate().catch(() => false);
      }
      await disconnectPublisher(previous.publisher);
    }
  }

  private async preparePublisher(slot: HostPublisherSlot): Promise<boolean> {
    const stream = this.events.getStream();
    const profile = this.events.getProfile();
    const videoCodec = this.events.getVideoCodec();
    if (!stream) {
      this.failPublisherSlot(slot);
      return false;
    }
    try {
      if (!(await slot.publisher.activate(stream, profile, videoCodec))) {
        this.failPublisherSlot(slot);
        await disconnectPublisher(slot.publisher);
        return false;
      }
      if (this.pending !== slot || !this.ownsPublisherSlot(slot)) {
        await disconnectPublisher(slot.publisher);
        return false;
      }
      slot.active = true;
      const latestStream = this.events.getStream();
      if (
        latestStream &&
        latestStream !== stream &&
        !(await slot.publisher.replaceStream(latestStream))
      ) {
        this.failPublisherSlot(slot);
        await disconnectPublisher(slot.publisher);
        return false;
      }
      const latestProfile = this.events.getProfile();
      if (
        !qualitySettingsEqual(latestProfile, profile) &&
        !(await slot.publisher.updateProfile(latestProfile))
      ) {
        this.failPublisherSlot(slot);
        await disconnectPublisher(slot.publisher);
        return false;
      }
      return this.pending === slot && this.ownsPublisherSlot(slot);
    } catch {
      this.failPublisherSlot(slot);
      await disconnectPublisher(slot.publisher);
      return false;
    }
  }

  private ownsPublisherSlot(slot: HostPublisherSlot): boolean {
    return (
      this.route.getRevision() === slot.revision &&
      this.route.getPlannedAssignment()?.sfuPublicationGeneration ===
        slot.publicationGeneration
    );
  }

  private commitMedia(token: RouteOperationToken): void {
    if (!this.route.markMediaActive(token)) {
      return;
    }
    this.lastFailureStage = null;
    this.recovery = null;
  }

  private clearPending(expected?: HostPublisherSlot): void {
    if (!this.pending || (expected && this.pending !== expected)) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    pending.failed = true;
    void disconnectPublisher(pending.publisher);
  }

  private async retireActive(except?: HostPublisherSlot): Promise<void> {
    if (!this.active || this.active === except) {
      return;
    }
    const active = this.active;
    this.active = null;
    active.failed = true;
    await this.disconnectRetiredPublisher(active);
  }

  private detachUnreferencedActive(
    publicationGeneration: string | null,
  ): HostPublisherSlot | null {
    if (
      !this.active ||
      this.active.publicationGeneration === publicationGeneration
    ) {
      return null;
    }
    const active = this.active;
    this.active = null;
    active.failed = true;
    return active;
  }

  private async disconnectRetiredPublisher(
    active: HostPublisherSlot,
  ): Promise<void> {
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
    const wasPending = this.pending === slot;
    if (!wasActive && !wasPending) {
      slot.failed = true;
      return;
    }
    const assignment = this.route.getPlannedAssignment();
    const revision = this.route.getRevision();
    const phase = this.route.getPhase();
    const matchesPlannedRoute =
      revision === slot.revision &&
      assignment?.sfuPublicationGeneration === slot.publicationGeneration;
    this.lastFailureStage = slot.publisher.getFailureStage?.() ?? "transport";
    slot.failed = true;
    if (wasPending) {
      this.pending = null;
    }
    if (wasActive) {
      this.active = null;
    }

    if (revision === null || phase === null) {
      return;
    }
    if (phase === "prepare") {
      if (matchesPlannedRoute || wasActive) {
        this.routeFailed(revision, "prepare", null);
      }
      return;
    }
    if (!matchesPlannedRoute) {
      return;
    }
    this.requestRecovery(revision);
  }

  private failPublisherSlot(slot: HostPublisherSlot): void {
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
      this.recovery.refreshed = true;
      if (this.events.send({ type: "refresh-sfu", revision })) {
        return;
      }
    }
    this.routeFailed(revision, "active", null);
  }

  private routeFailed(
    revision: number,
    phase: MediaRoutePhase,
    connectionId: string | null,
  ): void {
    this.events.send({
      type: "route-failed",
      revision,
      phase,
      connectionId,
    });
  }

  private handlePublisherStats(
    slot: HostPublisherSlot,
    metrics: ConnectionMetrics | null,
  ): void {
    if (
      metrics !== null &&
      !this.closed &&
      !slot.failed &&
      slot.active &&
      (this.pending === slot || this.active === slot) &&
      this.ownsPublisherSlot(slot)
    ) {
      this.events.onSenderUpdate?.(
        metrics,
        slot.revision,
        slot.publicationGeneration,
      );
    }
  }
}

async function disconnectPublisher(
  publisher: HostPublisherTransport,
): Promise<void> {
  await publisher.disconnect().catch(() => undefined);
}

function sfuFailureWarning(stage: SfuPublisherFailureStage): string {
  const stageKey: Record<SfuPublisherFailureStage, CopyKey> = {
    connect: "host.warn.sfuStage.connect",
    source: "host.warn.sfuStage.source",
    "video-publish": "host.warn.sfuStage.videoPublish",
    "sender-config": "host.warn.sfuStage.senderConfig",
    "audio-publish": "host.warn.sfuStage.audioPublish",
    transport: "host.warn.sfuStage.transport",
  };
  return say("host.warn.sfuRecover", { stage: say(stageKey[stage]) });
}
