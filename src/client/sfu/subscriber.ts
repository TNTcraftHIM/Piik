import type {
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  Track,
} from "livekit-client";

import type { SfuConnectionConfig } from "./publisher";
import type { ConnectionMetrics } from "../types";
import {
  collectConnectionMetricsFromReport,
  createStatsAccumulator,
  decodedVideoFrames,
  mergeStatsReports,
  type StatsAccumulator,
} from "../webrtc/stats";
import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { sfuRoomConnectOptions } from "./connection-options";

interface SubscriberEvents {
  onStream: (stream: MediaStream | null) => void;
  onVideoAvailability?: (available: boolean) => void;
  onStats?: (metrics: ConnectionMetrics) => void;
  onDecodedFrameSample?: (framesDecodedDelta: number | null) => void;
  onFirstDecodedFrame?: () => boolean;
  onState?: (state: "connected" | "reconnecting") => void;
  onDisconnected?: () => void;
}

interface SubscribedTrack {
  sid: string;
  track: RemoteTrack;
  mediaStreamTrack: MediaStreamTrack;
  onEnded: () => void;
}

interface AudioStatsSample {
  track: SubscribedTrack;
  report: RTCStatsReport | null;
}

interface KnownHostPublication {
  publication: RemoteTrackPublication;
  participant: RemoteParticipant;
}

type SubscriberState =
  | "idle"
  | "connecting"
  | "prepared"
  | "active"
  | "disconnected";
type LiveKit = typeof import("livekit-client");

const HOST_IDENTITY = "host";
const STATS_INTERVAL_MS = 2_000;
const roomDisconnects = new WeakMap<Room, Promise<void>>();

export class SfuSubscriber {
  private room: Room | null = null;
  private sdk: LiveKit | null = null;
  private video: SubscribedTrack | null = null;
  private audio: SubscribedTrack | null = null;
  private readonly stream = new MediaStream();
  private streamEmitted = false;
  private readonly desiredTrackSids = new Set<string>();
  private readonly knownHostPublications = new Map<
    string,
    KnownHostPublication
  >();
  private state: SubscriberState = "idle";
  private statsAccumulator: StatsAccumulator = createStatsAccumulator();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsInFlight: StatsAccumulator | null = null;
  private audioStatsInFlight: SubscribedTrack | null = null;
  private decodedFrameProofMode: "fresh" | "progress" | null = null;
  private stopDecodedFrameObserver: (() => void) | null = null;
  private generation = 0;
  private terminalNotified = false;

  constructor(private readonly events: SubscriberEvents) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.state !== "idle") {
      throw new Error("SFU subscriber cannot be connected twice");
    }

    const generation = ++this.generation;
    this.state = "connecting";

    try {
      const sdk = await import("livekit-client");
      if (!this.ownsGeneration(generation)) {
        return false;
      }

      const room = new sdk.Room({ disconnectOnPageLeave: false });
      this.room = room;
      this.sdk = sdk;
      this.bindRoomEvents(room, sdk, generation);

      await room.connect(config.url, config.token, sfuRoomConnectOptions());
      if (!this.owns(room, generation)) {
        await safeDisconnect(room);
        return false;
      }

      this.state = "prepared";
      return true;
    } catch (error) {
      if (!this.ownsGeneration(generation)) {
        return false;
      }
      const room = this.invalidate(false);
      if (room) {
        await safeDisconnect(room);
      }
      throw error;
    }
  }

  activate(): boolean {
    if (this.state === "active") {
      return true;
    }
    if (this.state !== "prepared" || !this.room || !this.sdk) {
      throw new Error(`SFU subscriber is ${this.state}, expected prepared`);
    }

    const room = this.room;
    const generation = this.generation;
    this.state = "active";
    try {
      this.startStats();
      this.reconcileHostSubscriptions(room, this.sdk, generation);
      return true;
    } catch (error) {
      if (this.owns(room, generation)) {
        try {
          this.rollbackSubscriptions(room);
          this.state = "prepared";
          this.clearMedia(true);
        } catch {
          void this.failClosed(room, generation);
        }
      }
      throw error;
    }
  }

  deactivate(): boolean {
    if (this.state === "prepared") {
      return true;
    }
    if (this.state !== "active" || !this.room) {
      if (this.state === "disconnected") {
        return false;
      }
      throw new Error(`SFU subscriber is ${this.state}, expected active`);
    }

    const room = this.room;
    try {
      this.rollbackSubscriptions(room);
    } catch (error) {
      void this.failClosed(room, this.generation);
      throw error;
    }
    this.state = "prepared";
    this.clearMedia(true);
    return true;
  }

  armDecodedFrameProof(requireProgress = false): void {
    this.cancelDecodedFrameObserver();
    this.decodedFrameProofMode = requireProgress ? "progress" : "fresh";
    this.startDecodedFrameProof();
  }

  stopDecodedFrameProof(): void {
    this.decodedFrameProofMode = null;
    this.cancelDecodedFrameObserver();
  }

  async disconnect(): Promise<void> {
    const room = this.invalidate(true);
    if (room) {
      await safeDisconnect(room);
    }
  }

  private bindRoomEvents(
    room: Room,
    sdk: LiveKit,
    generation: number,
  ): void {
    room.on(
      sdk.RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!this.owns(room, generation)) {
          return;
        }
        try {
          this.rememberHostPublication(publication, participant, sdk);
        } catch {
          void this.failClosed(room, generation);
        }
      },
    );
    room.on(
      sdk.RoomEvent.ParticipantConnected,
      (participant: RemoteParticipant) => {
        if (!this.owns(room, generation)) {
          return;
        }
        try {
          this.rememberHostParticipant(participant, sdk);
        } catch {
          void this.failClosed(room, generation);
        }
      },
    );
    room.on(
      sdk.RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          this.state !== "active" ||
          !this.owns(room, generation) ||
          participant.identity !== HOST_IDENTITY ||
          !this.desiredTrackSids.has(publication.trackSid)
        ) {
          return;
        }
        this.addTrack(
          room,
          generation,
          publication.trackSid,
          publication.source,
          track,
          sdk.Track,
        );
      },
    );
    room.on(
      sdk.RoomEvent.TrackUnsubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          this.removeTrack(publication.trackSid, track.mediaStreamTrack);
        }
      },
    );
    room.on(
      sdk.RoomEvent.TrackUnpublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          this.knownHostPublications.delete(publication.trackSid);
          this.desiredTrackSids.delete(publication.trackSid);
          this.removeTrack(publication.trackSid);
        }
      },
    );
    room.on(
      sdk.RoomEvent.ParticipantDisconnected,
      (participant: RemoteParticipant) => {
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          for (const [sid, known] of this.knownHostPublications) {
            if (known.participant === participant) {
              this.knownHostPublications.delete(sid);
            }
          }
          this.desiredTrackSids.clear();
          // LiveKit full reconnect removes participants before it emits
          // Reconnecting. Keep any route-owned proof intent until the route is
          // deactivated or the subscriber terminates.
          this.clearMedia(true, true);
        }
      },
    );
    room.on(sdk.RoomEvent.Reconnecting, () => {
      if (this.owns(room, generation) && this.state === "active") {
        this.events.onState?.("reconnecting");
      }
    });
    room.on(sdk.RoomEvent.Reconnected, () => {
      if (this.owns(room, generation) && this.state === "active") {
        this.reconcileHostSubscriptions(room, sdk, generation);
        this.startDecodedFrameProof();
        this.events.onState?.("connected");
        void this.updateStats();
      }
    });
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (this.owns(room, generation)) {
        const notify = this.state !== "connecting";
        this.invalidate(true);
        if (notify) {
          this.notifyTerminalDisconnect();
        }
      }
    });
  }

  private subscribeIfAllowed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    sdk: LiveKit,
  ): void {
    if (
      participant.identity !== HOST_IDENTITY ||
      !isScreenSource(publication.source, sdk.Track)
    ) {
      return;
    }
    if (this.desiredTrackSids.has(publication.trackSid)) {
      return;
    }
    this.desiredTrackSids.add(publication.trackSid);
    publication.setSubscribed(true);
  }

  private rememberHostParticipant(
    participant: RemoteParticipant,
    sdk: LiveKit,
  ): void {
    if (participant.identity !== HOST_IDENTITY) {
      return;
    }
    for (const publication of participant.trackPublications.values()) {
      this.rememberHostPublication(publication, participant, sdk);
    }
  }

  private rememberHostPublication(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    sdk: LiveKit,
  ): void {
    if (
      participant.identity !== HOST_IDENTITY ||
      !isScreenSource(publication.source, sdk.Track)
    ) {
      return;
    }
    this.knownHostPublications.set(publication.trackSid, {
      publication,
      participant,
    });
    if (this.state === "active") {
      this.subscribeIfAllowed(publication, participant, sdk);
    }
  }

  private reconcileHostSubscriptions(
    room: Room,
    sdk: LiveKit,
    generation: number,
  ): void {
    if (!this.owns(room, generation) || this.state !== "active") {
      return;
    }
    const host = room.remoteParticipants.get(HOST_IDENTITY);
    if (host) {
      this.rememberHostParticipant(host, sdk);
    }
    for (const { publication, participant } of this.knownHostPublications.values()) {
      this.subscribeIfAllowed(publication, participant, sdk);
    }
  }

  private rollbackSubscriptions(room: Room): void {
    const host = room.remoteParticipants.get(HOST_IDENTITY);
    for (const publication of host?.trackPublications.values() ?? []) {
      if (this.desiredTrackSids.has(publication.trackSid)) {
        publication.setSubscribed(false);
      }
    }
    this.desiredTrackSids.clear();
  }

  private addTrack(
    room: Room,
    generation: number,
    sid: string,
    source: Track.Source,
    track: RemoteTrack,
    trackType: typeof Track,
  ): void {
    const isVideo = source === trackType.Source.ScreenShare;
    let previous: SubscribedTrack | null;
    if (isVideo) {
      previous = this.video;
    } else if (source === trackType.Source.ScreenShareAudio) {
      previous = this.audio;
    } else {
      return;
    }
    const mediaStreamTrack = track.mediaStreamTrack;
    if (previous?.sid === sid && previous.mediaStreamTrack === mediaStreamTrack) {
      return;
    }
    const hadVideo = this.video !== null;
    if (isVideo) {
      this.cancelDecodedFrameObserver();
    }
    if (previous) this.detachTrack(previous);
    const subscribed = {
      sid,
      track,
      mediaStreamTrack,
      onEnded: () => {
        if (this.state === "active" && this.owns(room, generation)) {
          this.removeTrack(sid, mediaStreamTrack);
        }
      },
    };
    mediaStreamTrack.addEventListener("ended", subscribed.onEnded, { once: true });
    this.stream.addTrack(mediaStreamTrack);
    if (isVideo) {
      this.video = subscribed;
      this.resetStatsAccumulator();
    } else {
      this.audio = subscribed;
      this.resetAudioStats();
    }
    this.emitStream();
    if (!hadVideo && this.video) {
      this.events.onVideoAvailability?.(true);
    }
    if (this.video) {
      this.startStats();
    }
    if (isVideo) {
      this.startDecodedFrameProof();
    }
  }

  private removeTrack(sid: string, track?: MediaStreamTrack): void {
    const previousVideo = this.video;
    const previousAudio = this.audio;
    if (this.video?.sid === sid && (!track || this.video.mediaStreamTrack === track)) {
      this.cancelDecodedFrameObserver();
      this.detachTrack(this.video);
      this.video = null;
    }
    if (this.audio?.sid === sid && (!track || this.audio.mediaStreamTrack === track)) {
      this.detachTrack(this.audio);
      this.audio = null;
      this.resetAudioStats();
    }
    if (this.video === previousVideo && this.audio === previousAudio) {
      return;
    }
    this.emitStream();
    if (!this.video && previousVideo) {
      this.resetStatsAccumulator();
      this.events.onVideoAvailability?.(false);
    }
  }

  private emitStream(): void {
    if (!this.video) {
      return;
    }
    this.streamEmitted = true;
    this.events.onStream(this.stream);
  }

  private detachTrack(track: SubscribedTrack): void {
    track.mediaStreamTrack.removeEventListener("ended", track.onEnded);
    this.stream.removeTrack(track.mediaStreamTrack);
  }

  private startStats(): void {
    if (this.statsTimer === null) {
      this.statsTimer = setInterval(() => {
        void this.updateStats();
      }, STATS_INTERVAL_MS);
    }
    void this.updateStats();
  }

  private startDecodedFrameProof(): void {
    const room = this.room;
    const video = this.video;
    const generation = this.generation;
    const mode = this.decodedFrameProofMode;
    if (!room || !video || !mode || this.state !== "active") {
      return;
    }
    this.cancelDecodedFrameObserver();
    this.stopDecodedFrameObserver = observeDecodedFrameProof({
      readFramesDecoded: async () => {
        const report = mergeStatsReports([
          await video.track.getRTCStatsReport(),
        ]);
        return report ? decodedVideoFrames(report) : null;
      },
      owns: () =>
        this.owns(room, generation) &&
        this.state === "active" &&
        this.video === video &&
        this.decodedFrameProofMode === mode,
      requireProgress: mode === "progress",
      onProof: () => {
        const accepted = this.events.onFirstDecodedFrame?.() ?? true;
        if (accepted) {
          this.decodedFrameProofMode = null;
          this.stopDecodedFrameObserver = null;
        }
        return accepted;
      },
    });
  }

  private cancelDecodedFrameObserver(): void {
    this.stopDecodedFrameObserver?.();
    this.stopDecodedFrameObserver = null;
  }

  private async updateStats(): Promise<void> {
    const room = this.room;
    const video = this.video;
    const generation = this.generation;
    const accumulator = this.statsAccumulator;
    if (!room || this.state !== "active") {
      return;
    }
    if (this.statsInFlight === accumulator || !video) {
      this.events.onDecodedFrameSample?.(null);
      return;
    }
    const ownsSample = (): boolean =>
      this.owns(room, generation) &&
      this.state === "active" &&
      this.video === video &&
      this.statsAccumulator === accumulator;
    const audioStatsSample: AudioStatsSample | null = this.audio
      ? { track: this.audio, report: null }
      : null;
    if (audioStatsSample) {
      void this.updateAudioStats(room, generation, audioStatsSample);
    }
    this.statsInFlight = accumulator;
    try {
      const videoReport = await video.track.getRTCStatsReport();
      if (!ownsSample()) {
        return;
      }
      const report = mergeStatsReports([
        videoReport,
        audioStatsSample?.track === this.audio
          ? (audioStatsSample.report ?? undefined)
          : undefined,
      ]);
      if (!report) {
        this.events.onDecodedFrameSample?.(null);
        return;
      }
      const metrics = collectConnectionMetricsFromReport(
        report,
        "receive",
        accumulator,
      );
      this.events.onDecodedFrameSample?.(metrics.intervalFramesDecoded);
      this.events.onStats?.(metrics);
    } catch {
      if (ownsSample()) {
        this.events.onDecodedFrameSample?.(null);
      }
    } finally {
      if (this.statsInFlight === accumulator) {
        this.statsInFlight = null;
      }
    }
  }

  private async updateAudioStats(
    room: Room,
    generation: number,
    sample: AudioStatsSample,
  ): Promise<void> {
    const audio = sample.track;
    if (this.audioStatsInFlight === audio) {
      return;
    }
    this.audioStatsInFlight = audio;
    try {
      const report = await audio.track.getRTCStatsReport();
      if (
        report &&
        this.owns(room, generation) &&
        this.state === "active" &&
        this.audio === audio
      ) {
        sample.report = report;
      }
    } catch {
      // Audio diagnostics must not affect video liveness.
    } finally {
      if (this.audioStatsInFlight === audio) {
        this.audioStatsInFlight = null;
      }
    }
  }

  private stopStats(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.resetStatsAccumulator();
  }

  private resetStatsAccumulator(): void {
    this.statsInFlight = null;
    this.statsAccumulator = createStatsAccumulator();
  }

  private resetAudioStats(): void {
    this.audioStatsInFlight = null;
  }

  private clearMedia(notify: boolean, preserveDecodedFrameProof = false): void {
    const hadStream = this.streamEmitted;
    const hadVideo = this.video !== null;
    if (preserveDecodedFrameProof) {
      this.cancelDecodedFrameObserver();
    } else {
      this.stopDecodedFrameProof();
    }
    if (this.state !== "active") {
      this.stopStats();
    }
    if (this.video) {
      this.detachTrack(this.video);
    }
    if (this.audio) {
      this.detachTrack(this.audio);
    }
    this.video = null;
    this.audio = null;
    this.resetAudioStats();
    if (this.state === "active") {
      this.resetStatsAccumulator();
    }
    this.streamEmitted = false;
    if (hadVideo) {
      this.events.onVideoAvailability?.(false);
    }
    if (notify && hadStream) {
      this.events.onStream(null);
    }
  }

  private ownsGeneration(generation: number): boolean {
    return this.generation === generation && this.state !== "disconnected";
  }

  private owns(room: Room, generation: number): boolean {
    return this.room === room && this.ownsGeneration(generation);
  }

  private invalidate(notifyStream: boolean): Room | null {
    if (this.state === "disconnected") {
      return null;
    }
    ++this.generation;
    this.state = "disconnected";
    const room = this.room;
    this.room = null;
    this.sdk = null;
    this.desiredTrackSids.clear();
    this.knownHostPublications.clear();
    this.clearMedia(notifyStream);
    return room;
  }

  private async failClosed(room: Room, generation: number): Promise<void> {
    if (!this.owns(room, generation)) {
      return;
    }
    this.invalidate(true);
    await safeDisconnect(room);
    this.notifyTerminalDisconnect();
  }

  private notifyTerminalDisconnect(): void {
    if (this.terminalNotified) {
      return;
    }
    this.terminalNotified = true;
    this.events.onDisconnected?.();
  }
}

function isScreenSource(source: Track.Source, trackType: typeof Track): boolean {
  return (
    source === trackType.Source.ScreenShare ||
    source === trackType.Source.ScreenShareAudio
  );
}

async function safeDisconnect(room: Room): Promise<void> {
  const existing = roomDisconnects.get(room);
  if (existing) {
    await existing;
    return;
  }
  const disconnecting = room.disconnect(false).catch(() => undefined);
  roomDisconnects.set(room, disconnecting);
  await disconnecting;
}
