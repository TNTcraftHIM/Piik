import type { IceConfig, SfuSignalMessage } from "../../shared/protocol";
import type { HostPublisherTransport } from "../media/host-sfu-route";
import type {
  SfuConnectionConfig,
  SfuPublisherFailureStage,
} from "../sfu/publisher";
import type { NativeClient } from "./client";
import type { NativeClientEvent } from "./wire";
import { EMPTY_METRICS, type ConnectionMetrics } from "../types";

type PublicationControl = Pick<
  NativeClient,
  | "preparePublication"
  | "publicationMedia"
  | "acceptPublicationSignal"
  | "closePublication"
  | "onEvent"
>;

// The page owns room signaling. The App publishes its existing encoded source.
export class NativeSfuPublisher implements HostPublisherTransport {
  private config: SfuConnectionConfig | null = null;
  private pending: Array<
    Pick<SfuSignalMessage, "kind" | "description" | "candidate" | "media">
  > = [];
  private unsubscribe: (() => void) | null = null;
  private prepared = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private failure: SfuPublisherFailureStage | null = null;

  constructor(
    private readonly client: PublicationControl,
    private readonly shareId: string,
    private readonly iceConfig: IceConfig,
    private readonly events: {
      send: (message: SfuSignalMessage) => boolean;
      onDisconnected: () => void;
      onStats?: (metrics: ConnectionMetrics | null) => void;
    },
  ) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.config || this.closed) return false;
    this.config = config;
    return true;
  }

  updateConfig(config: SfuConnectionConfig): void {
    if (
      this.config?.connectionId !== config.connectionId ||
      this.config.publicationGeneration !== config.publicationGeneration
    )
      return;
    this.config = config;
    this.flush();
  }

  async activate(): Promise<boolean> {
    const config = this.config;
    if (!config || this.prepared || this.closed) {
      await this.closing?.catch(() => undefined);
      return false;
    }
    // Activation runs after the route's retirement barrier. Subscribing in
    // connect would let an old same-key publication reach this new instance.
    this.unsubscribe = this.client.onEvent((event) => this.onEvent(event));
    try {
      const result = await this.client.preparePublication(
        this.shareId,
        config.publicationGeneration,
        config.connectionId,
        this.iceConfig,
      );
      if (this.closed) {
        await this.disconnect();
        return false;
      }
      this.pending.unshift({ kind: "description", ...result });
      this.prepared = true;
      this.flush();
      return !this.closed;
    } catch {
      await this.fail("video-publish");
      return false;
    }
  }

  async acceptSignal(message: SfuSignalMessage): Promise<void> {
    if (
      this.closed ||
      message.connectionId !== this.config?.connectionId ||
      message.publicationGeneration !== this.config.publicationGeneration
    )
      return;
    try {
      await this.client.acceptPublicationSignal(this.shareId, message);
    } catch {
      await this.fail("transport");
    }
  }

  async updateProfile(): Promise<boolean> {
    const config = this.config;
    if (!config || !this.prepared || this.closed) {
      await this.closing?.catch(() => undefined);
      return false;
    }
    try {
      const media = await this.client.publicationMedia(
        this.shareId,
        config.publicationGeneration,
        config.connectionId,
      );
      if (this.closed) {
        await this.closing?.catch(() => undefined);
        return false;
      }
      this.pending = this.pending.filter(({ kind }) => kind !== "media");
      this.pending.push({ kind: "media", media });
      this.flush();
      return !this.closed;
    } catch {
      await this.fail("source");
      return false;
    }
  }

  replaceStream(): Promise<boolean> {
    return this.updateProfile();
  }
  setPaused(): void {} // The shared Native capture owner applies pause to every path.
  getFailureStage(): SfuPublisherFailureStage | null {
    return this.failure;
  }
  async deactivate(): Promise<boolean> {
    await this.disconnect();
    return true;
  }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending = [];
    const config = this.config;
    this.closing = config ? this.client.closePublication(
        this.shareId,
        config.publicationGeneration,
        config.connectionId,
      ) : Promise.resolve();
    return this.closing;
  }

  private onEvent(event: NativeClientEvent): void {
    if (
      this.closed ||
      event.shareId !== this.shareId ||
      !("publicationGeneration" in event) ||
      event.publicationGeneration !== this.config?.publicationGeneration ||
      event.connectionId !== this.config.connectionId
    )
      return;
    if (event.type === "publication-quality") {
      this.events.onStats?.({
        ...EMPTY_METRICS,
        sampleTimestampMs: event.sampleTimestampMs,
        sampleWindowMs: event.sampleWindowMs,
        rtpStatsId: event.rtpStatsId,
        trackIdentifier: event.trackIdentifier,
        rtpRid: event.rid || null,
        videoEncodingCount: event.videoEncodingCount,
        activeVideoEncodingCount: event.activeVideoEncodingCount,
        intervalFramesSent: event.intervalFramesSent,
        framesPerSecond: event.framesPerSecond,
        frameWidth: event.width || null,
        frameHeight: event.height || null,
        resolution:
          event.width && event.height ? `${event.width}x${event.height}` : null,
        bitrateKbps: event.bitrateKbps,
        audioBitrateKbps: event.audioBitrateKbps,
        availableOutgoingKbps: event.availableOutgoingKbps,
        codec: `video/${event.codec.toUpperCase()}`,
        nativeEdgeQualityState: event.state,
        qualityLimitationReason: event.reason,
      });
    } else if (event.type === "publication-candidate" && event.candidate) {
      if (this.pending.length >= 64) {
        void this.fail("transport");
        return;
      }
      this.pending.push({ kind: "candidate", candidate: event.candidate });
      this.flush();
    } else if (
      event.type === "publication-state" &&
      (event.state === "disconnected" ||
        event.state === "failed" ||
        event.state === "closed")
    ) {
      void this.fail("transport");
    }
  }

  private flush(): void {
    if (this.closed || !this.prepared || !this.config) return;
    while (this.pending[0]) {
      if (
        !this.events.send({
          type: "sfu-signal",
          revision: this.config.revision,
          publicationGeneration: this.config.publicationGeneration,
          connectionId: this.config.connectionId,
          ...this.pending[0],
        })
      )
        return;
      this.pending.shift();
    }
  }

  private async fail(stage: SfuPublisherFailureStage): Promise<void> {
    if (this.closed || this.failure) {
      await this.closing?.catch(() => undefined);
      return;
    }
    this.failure = stage;
    await this.disconnect().catch(() => undefined);
    this.events.onDisconnected();
  }
}
