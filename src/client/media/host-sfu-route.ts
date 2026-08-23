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
  getFailureStage?(): SfuPublisherFailureStage | null;
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
  connectionId: string;
  selectedEdgeTurn: boolean;
}

export interface HostSfuPublisherSnapshot {
  metrics: ConnectionMetrics;
  senderParameters: VideoSenderParameterReadback | null;
}

interface HostSfuRouteEvents {
  getStream: () => MediaStream | null;
  getProfile: () => QualityProfile;
  reconcileChildren: (childPeerIds: string[]) => void;
  send: (message: ClientMessage) => boolean;
  onPublisherUpdate?: (snapshot: HostSfuPublisherSnapshot | null) => void;
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
  private lastConfig: Extract<ServerMessage, { type: "sfu-config" }> | null =
    null;
  private selectedEdgeTurn: Extract<
    ServerMessage,
    { type: "selected-edge-turn"; edgeKind: "host-sfu-ingress" }
  > | null = null;

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
    if (this.paused) {
      this.clearPending();
      return result;
    }
    if (previousRevision !== update.revision) {
      this.recovery = null;
      this.lastFailureStage = null;
      this.lastConfig = null;
      this.selectedEdgeTurn = null;
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
    if (token && !this.resyncing) {
      void this.queueActivation(token);
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
    this.events.onPublisherUpdate?.(null);
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
    if (this.closed || this.paused || !this.route.acceptsConfig(message.revision)) {
      return;
    }
    const token = this.route.token();
    const assignment = this.route.getPlannedAssignment();
    const phase = this.route.getPhase();
    const publicationGeneration = assignment?.sfuPublicationGeneration;
    if (!token || !phase || !assignment || !publicationGeneration) {
      return;
    }
    this.lastConfig = message;

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
        () => this.handleFailure(slot),
        (metrics) => this.handlePublisherStats(slot, metrics),
      ) ??
      new SfuPublisher({
        onDisconnected: () => this.handleFailure(slot),
        onStats: (metrics) => this.handlePublisherStats(slot, metrics),
      });
    const selectedEdgeTurn =
      this.selectedEdgeTurn?.revision === message.revision &&
      this.selectedEdgeTurn.publicationGeneration === publicationGeneration &&
      this.selectedEdgeTurn.oldConnectionId === publicationGeneration
        ? this.selectedEdgeTurn
        : null;
    this.selectedEdgeTurn = null;
    slot = {
      revision: message.revision,
      publicationGeneration,
      publisher,
      connected: false,
      active: false,
      failed: false,
      connectionId: selectedEdgeTurn?.newConnectionId ?? publicationGeneration,
      selectedEdgeTurn: selectedEdgeTurn !== null,
    };
    this.pending = slot;
    try {
      const connected = await publisher.connect({
        url: message.url,
        token: message.token,
        ...(selectedEdgeTurn
          ? {
              rtcConfig: {
                iceServers: [selectedEdgeTurn.iceServer],
                iceTransportPolicy: "relay",
              },
            }
          : {}),
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
      if (!(await this.preparePublisher(slot))) {
        return;
      }
      if (phase === "active" && !this.resyncing) {
        await this.queueActivation(token);
      }
    } catch {
      await disconnectPublisher(publisher);
      this.handleFailure(slot);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.clearPending();
      this.selectedEdgeTurn = null;
    }
  }

  /** Apply one controller-selected TURN grant to the next SFU publisher PC. */
  startSelectedEdgeTurn(
    message: Extract<
      ServerMessage,
      { type: "selected-edge-turn"; edgeKind: "host-sfu-ingress" }
    >,
  ): boolean {
    if (
      this.closed ||
      !this.route.acceptsConfig(message.revision) ||
      this.route.getPhase() !== "prepare" ||
      Date.parse(message.expiresAt) <= Date.now()
    ) {
      return false;
    }
    const assignment = this.route.getPlannedAssignment();
    const publicationGeneration = assignment?.sfuPublicationGeneration;
    const pending = this.pending;
    if (
      !publicationGeneration ||
      publicationGeneration !== message.publicationGeneration ||
      (pending !== null &&
        (pending.revision !== message.revision ||
          pending.publicationGeneration !== publicationGeneration))
    ) {
      return false;
    }
    if (pending?.connectionId === message.newConnectionId) {
      return !pending.failed;
    }
    if (
      (pending?.connectionId ?? publicationGeneration) !==
      message.oldConnectionId
    ) {
      return false;
    }
    this.clearPending();
    this.selectedEdgeTurn = message;
    if (this.lastConfig?.revision === message.revision) {
      void this.acceptConfig(this.lastConfig);
    }
    return true;
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    const slots = this.publishingSlots();
    return slots.length === 0
      ? Promise.resolve(true)
      : Promise.all(
          slots.map((slot) =>
            slot.publisher.updateProfile(profile).catch(() => false),
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

  getSenderParameters(): VideoSenderParameterReadback | null {
    return this.active?.active
      ? (this.active.publisher.getSenderParameters?.() ?? null)
      : null;
  }

  replaceStream(stream: MediaStream): Promise<boolean> {
    const slots = this.publishingSlots();
    return slots.length === 0
      ? Promise.resolve(true)
      : Promise.all(
          slots.map((slot) =>
            slot.publisher.replaceStream(stream).catch(() => false),
          ),
        ).then((results) => results.every(Boolean));
  }

  private publishingSlots(): HostPublisherSlot[] {
    return [...new Set([this.active, this.pending])].filter(
      (slot): slot is HostPublisherSlot =>
        slot !== null && slot.active && !slot.failed,
    );
  }

  async failActivePublisher(): Promise<void> {
    await this.queueTransition(async () => {
      const slot = this.active;
      if (!slot) {
        return;
      }
      this.events.onPublisherUpdate?.(null);
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
    this.lastConfig = null;
    this.selectedEdgeTurn = null;
    await this.queueTransition(async () => {
      const pending = this.pending;
      const active = this.active;
      this.pending = null;
      this.active = null;
      this.events.onPublisherUpdate?.(null);
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

  private queueActivation(token: RouteOperationToken): Promise<void> {
    return this.queueTransition(async () => {
      if (this.closed || this.resyncing || !this.route.owns(token, "active")) {
        return;
      }
      const assignment = this.route.getActiveAssignment();
      if (assignment) {
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
      await disconnectPublisher(pending.publisher);
      return;
    }
    this.lastFailureStage = null;
    this.recovery = null;
    if (previous && previous !== pending) {
      if (previous.active) {
        await previous.publisher.deactivate().catch(() => false);
      }
      await disconnectPublisher(previous.publisher);
    }
  }

  private async preparePublisher(slot: HostPublisherSlot): Promise<boolean> {
    const stream = this.events.getStream();
    const profile = this.events.getProfile();
    if (!stream) {
      this.handleFailure(slot);
      return false;
    }
    try {
      if (!(await slot.publisher.activate(stream, profile))) {
        this.handleFailure(slot);
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
        this.handleFailure(slot);
        await disconnectPublisher(slot.publisher);
        return false;
      }
      const latestProfile = this.events.getProfile();
      if (
        latestProfile !== profile &&
        !(await slot.publisher.updateProfile(latestProfile))
      ) {
        this.handleFailure(slot);
        await disconnectPublisher(slot.publisher);
        return false;
      }
      return this.pending === slot && this.ownsPublisherSlot(slot);
    } catch {
      this.handleFailure(slot);
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
    void disconnectPublisher(pending.publisher);
  }

  private async retireActive(except?: HostPublisherSlot): Promise<void> {
    if (!this.active || this.active === except) {
      return;
    }
    const active = this.active;
    this.events.onPublisherUpdate?.(null);
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
    this.lastFailureStage = slot.publisher.getFailureStage?.() ?? "transport";
    slot.failed = true;
    if (this.pending === slot) {
      this.pending = null;
    }
    if (wasActive) {
      this.events.onPublisherUpdate?.(null);
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
        this.routeFailed(
          revision,
          "prepare",
          slot.selectedEdgeTurn ? slot.connectionId : null,
        );
      }
      return;
    }
    if (!matchesPlannedRoute) {
      return;
    }
    this.requestRecovery(revision, slot);
  }

  private requestRecovery(
    revision: number,
    failedSlot?: HostPublisherSlot,
  ): void {
    if (!this.recovery || this.recovery.revision !== revision) {
      this.recovery = { revision, refreshed: false };
    }
    if (!this.recovery.refreshed) {
      this.recovery.refreshed = true;
      if (this.events.send({ type: "refresh-sfu", revision })) {
        return;
      }
    }
    this.routeFailed(
      revision,
      "active",
      failedSlot?.selectedEdgeTurn ? failedSlot.connectionId : null,
    );
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
      metrics === null ||
      this.closed ||
      slot.failed ||
      !slot.active ||
      this.active !== slot ||
      !this.currentActiveToken(slot)
    ) {
      if (metrics === null && this.active === slot) {
        this.events.onPublisherUpdate?.(null);
      }
      return;
    }
    this.events.onPublisherUpdate?.({
      metrics: { ...metrics },
      senderParameters: slot.publisher.getSenderParameters?.() ?? null,
    });
  }
}

async function disconnectPublisher(
  publisher: HostPublisherTransport,
): Promise<void> {
  await publisher.disconnect().catch(() => undefined);
}

function sfuFailureWarning(stage: SfuPublisherFailureStage): string {
  const label: Record<SfuPublisherFailureStage, string> = {
    connect: "连接",
    source: "分享源",
    "video-publish": "视频发布",
    "sender-config": "视频参数配置",
    "audio-publish": "音频发布",
    transport: "传输",
  };
  return `SFU ${label[stage]}失败，已启动自动恢复`;
}
