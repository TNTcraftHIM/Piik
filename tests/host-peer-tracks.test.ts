import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUALITY_PROFILES,
  type QualityProfile,
} from "../src/client/media/quality.ts";
import { HostProvisionalChild } from "../src/client/media/host-provisional-child.ts";
import type { PeerSnapshot } from "../src/client/types.ts";
import { HostPeer } from "../src/client/webrtc/host-peer.ts";
import {
  automaticVideoCodecPreference,
  manualVideoCodecPreference,
  type BrowserVideoCodecPreference,
  VP8_ONLY_VIDEO_CODEC,
} from "../src/client/webrtc/video-codec.ts";
import { ViewerRelay } from "../src/client/webrtc/viewer-relay.ts";
import type {
  IceConfig,
  ParticipantRouteAssignment,
} from "../src/shared/protocol.ts";

const codecPreflight = vi.hoisted(() => ({
  probe: vi.fn(async (): Promise<"h264" | "vp8"> => "vp8"),
}));

vi.mock("../src/client/webrtc/video-codec-preflight.ts", () => ({
  preferredVideoCodecForTrack: codecPreflight.probe,
}));

const statsCallbacks: Array<() => void> = [];

class FakeSender {
  failNextReplace = false;
  deferReplaceCall: number | null = null;
  failNextSetParameters = false;
  deferNextSetParameters = false;
  readonly appliedMaxBitrates: Array<number | undefined> = [];
  private parameters = { encodings: [{}] } as RTCRtpSendParameters;
  private replaceCallCount = 0;
  private releaseReplaceTrack: (() => void) | null = null;
  private releaseSetParameters: (() => void) | null = null;
  readonly setParameters = vi.fn(
    async (parameters: RTCRtpSendParameters) => {
      if (this.failNextSetParameters) {
        this.failNextSetParameters = false;
        throw new Error("setParameters failed");
      }
      if (this.deferNextSetParameters) {
        this.deferNextSetParameters = false;
        await new Promise<void>((resolve) => {
          this.releaseSetParameters = resolve;
        });
      }
      this.appliedMaxBitrates.push(parameters.encodings[0]?.maxBitrate);
      this.parameters = parameters;
    },
  );
  readonly replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    this.replaceCallCount += 1;
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("replaceTrack failed");
    }
    if (this.deferReplaceCall === this.replaceCallCount) {
      this.deferReplaceCall = null;
      await new Promise<void>((resolve) => {
        this.releaseReplaceTrack = resolve;
      });
    }
    this.track = track;
  });

  constructor(public track: MediaStreamTrack | null) {}

  getParameters(): RTCRtpSendParameters {
    return this.parameters;
  }

  releaseDeferredSetParameters(): void {
    this.releaseSetParameters?.();
    this.releaseSetParameters = null;
  }

  releaseDeferredReplaceTrack(): void {
    this.releaseReplaceTrack?.();
    this.releaseReplaceTrack = null;
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  static instances: FakePeerConnection[] = [];
  static activeCount = 0;
  static peakActiveCount = 0;
  static offersFailing = 0;
  static omitCodecPreferenceSetter = false;
  static codecPreferenceCallsFailing = 0;

  readonly configurations: RTCConfiguration[] = [];
  readonly senders: FakeSender[] = [];
  readonly transceiverInputs: Array<{
    trackOrKind: MediaStreamTrack | string;
    init?: RTCRtpTransceiverInit;
  }> = [];
  readonly codecPreferenceCalls: RTCRtpCodec[][] = [];
  createOfferCallCount = 0;
  remoteDescriptionCallCount = 0;
  deferRemoteDescriptionCall: number | null = null;
  private releaseRemoteDescription: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly addedIceCandidates: Array<RTCIceCandidateInit | null> = [];
  readonly statsReports: Array<RTCStatsReport | Promise<RTCStatsReport>> = [];
  private readonly eventListeners = new Map<string, Array<() => void>>();

  constructor(configuration?: RTCConfiguration) {
    FakePeerConnection.latest = this;
    FakePeerConnection.instances.push(this);
    FakePeerConnection.activeCount += 1;
    FakePeerConnection.peakActiveCount = Math.max(
      FakePeerConnection.peakActiveCount,
      FakePeerConnection.activeCount,
    );
    if (configuration) {
      this.configurations.push(configuration);
    }
  }

  readonly setConfiguration = vi.fn((configuration: RTCConfiguration) => {
    this.configurations.push(configuration);
  });

  readonly restartIce = vi.fn();

  addTransceiver(
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver {
    const sender = new FakeSender(
      typeof trackOrKind === "string" ? null : trackOrKind,
    );
    this.senders.push(sender);
    this.transceiverInputs.push({ trackOrKind, init });
    return {
      sender,
      ...(FakePeerConnection.omitCodecPreferenceSetter
        ? {}
        : {
            setCodecPreferences: (codecs: RTCRtpCodec[]) => {
              if (FakePeerConnection.codecPreferenceCallsFailing > 0) {
                FakePeerConnection.codecPreferenceCallsFailing -= 1;
                throw new Error("setCodecPreferences failed");
              }
              this.codecPreferenceCalls.push([...codecs]);
            },
          }),
    } as unknown as RTCRtpTransceiver;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(listener);
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.eventListeners.get(event.type) ?? []) {
      listener();
    }
    return true;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.createOfferCallCount += 1;
    if (FakePeerConnection.offersFailing > 0) {
      FakePeerConnection.offersFailing -= 1;
      throw new Error("createOffer failed");
    }
    return { type: "offer", sdp: "test-offer" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    if (description.type === "rollback") {
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescriptionCallCount += 1;
    if (this.deferRemoteDescriptionCall === this.remoteDescriptionCallCount) {
      this.deferRemoteDescriptionCall = null;
      await new Promise<void>((resolve) => {
        this.releaseRemoteDescription = resolve;
      });
    }
    this.remoteDescription = description as RTCSessionDescription;
  }

  releaseDeferredRemoteDescription(): void {
    this.releaseRemoteDescription?.();
    this.releaseRemoteDescription = null;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  readonly getStats = vi.fn(async (): Promise<RTCStatsReport> =>
    await (this.statsReports.shift() ?? emptyStatsReport())
  );

  close(): void {
    if (this.connectionState !== "closed") {
      FakePeerConnection.activeCount -= 1;
    }
    this.connectionState = "closed";
  }
}

function emptyStatsReport(): RTCStatsReport {
  return new Map() as unknown as RTCStatsReport;
}

function sendStatsReport({
  bytesSent,
  framesEncoded,
  timestamp,
  totalEncodeTime,
  qualityLimitationReason,
  trackIdentifier = "video",
}: {
  bytesSent: number;
  framesEncoded: number;
  timestamp: number;
  totalEncodeTime?: number;
  qualityLimitationReason: string;
  trackIdentifier?: string;
}): RTCStatsReport {
  return new Map<string, Record<string, unknown>>([
    [
      "transport",
      {
        id: "transport",
        type: "transport",
        timestamp,
        selectedCandidatePairId: "pair",
      },
    ],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        timestamp,
        transportId: "transport",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.02,
        availableOutgoingBitrate: 6_000_000,
      },
    ],
    [
      "local",
      {
        id: "local",
        type: "local-candidate",
        timestamp,
        candidateType: "host",
        protocol: "udp",
      },
    ],
    [
      "remote",
      {
        id: "remote",
        type: "remote-candidate",
        timestamp,
        candidateType: "host",
        protocol: "udp",
      },
    ],
    [
      "outbound-video",
      {
        id: "outbound-video",
        type: "outbound-rtp",
        timestamp,
        kind: "video",
        transportId: "transport",
        mediaSourceId: "video-source",
        bytesSent,
        framesEncoded,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        totalEncodeTime: totalEncodeTime ?? framesEncoded * 0.005,
        qualityLimitationReason,
        encoderImplementation: "test-encoder",
        codecId: "codec",
      },
    ],
    [
      "video-source",
      {
        id: "video-source",
        type: "media-source",
        timestamp,
        kind: "video",
        trackIdentifier,
      },
    ],
    [
      "codec",
      {
        id: "codec",
        type: "codec",
        timestamp,
        transportId: "transport",
        mimeType: "video/VP8",
      },
    ],
  ]) as unknown as RTCStatsReport;
}

function withOutboundAudio(
  report: RTCStatsReport,
  tracks: readonly {
    id: string;
    trackIdentifier: string;
    bytesSent: number;
  }[],
): RTCStatsReport {
  const merged = new Map(
    report as unknown as Map<string, Record<string, unknown>>,
  );
  for (const [index, track] of tracks.entries()) {
    const sourceId = `${track.id}-source`;
    merged.set(track.id, {
      id: track.id,
      type: "outbound-rtp",
      timestamp: Number(merged.get("outbound-video")?.timestamp),
      kind: "audio",
      ssrc: index + 1,
      mediaSourceId: sourceId,
      bytesSent: track.bytesSent,
    });
    merged.set(sourceId, {
      id: sourceId,
      type: "media-source",
      timestamp: Number(merged.get("outbound-video")?.timestamp),
      kind: "audio",
      trackIdentifier: track.trackIdentifier,
    });
  }
  return merged as unknown as RTCStatsReport;
}

function createTrack(kind: "video" | "audio", id: string): MediaStreamTrack {
  const track = Object.assign(new EventTarget(), {
    id,
    kind,
    contentHint: "",
    enabled: true,
    getSettings: () => ({}),
    applyConstraints: vi.fn(async () => undefined),
    stop: vi.fn(),
  }) as unknown as MediaStreamTrack;
  track.clone = vi.fn(() => {
    const clone = createTrack(kind, id);
    clone.getSettings = track.getSettings.bind(track);
    return clone;
  });
  return track;
}

function createConfiguredVideoTrack(
  id: string,
  width: number,
  height: number,
  frameRate: number,
): MediaStreamTrack {
  const track = createTrack("video", id);
  track.getSettings = () => ({ width, height, frameRate });
  track.clone = vi.fn(() =>
    createConfiguredVideoTrack(id, width, height, frameRate),
  );
  return track;
}

function createStream(
  videoTrack: MediaStreamTrack,
  audioTrack: MediaStreamTrack | null,
): MediaStream {
  const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => (audioTrack ? [audioTrack] : []),
  } as unknown as MediaStream;
}

function createPeer(
  stream: MediaStream,
  onUpdate: (snapshot: PeerSnapshot) => void = () => undefined,
  iceConfig: IceConfig = { iceServers: [] },
  profile: QualityProfile = QUALITY_PROFILES["720p30"],
  videoCodec: BrowserVideoCodecPreference = VP8_ONLY_VIDEO_CODEC,
): HostPeer {
  return new HostPeer(
    "viewer-peer",
    iceConfig,
    stream,
    profile,
    {
      sendSignal: () => true,
      onUpdate,
    },
    videoCodec,
  );
}

async function acceptPeerAnswer(peer: HostPeer): Promise<void> {
  const connection = FakePeerConnection.latest!;
  await peer.acceptSignal({
    kind: "description",
    connectionId: peer.connectionId,
    description: { type: "answer", sdp: "test-answer" },
  });
  connection.connectionState = "connected";
  connection.dispatchEvent(new Event("connectionstatechange"));
  await completeVideoStartup(connection);
}

async function completeVideoStartup(
  connection: FakePeerConnection,
  framesEncoded = 5,
): Promise<void> {
  const statsCalls = connection.getStats.mock.calls.length;
  connection.statsReports.push(
    sendStatsReport({
      bytesSent: 10_000,
      framesEncoded,
      timestamp: 1_000,
      qualityLimitationReason: "none",
      trackIdentifier: connection.senders[0]?.track?.id ?? "video",
    }),
  );
  statsCallbacks.at(-1)!();
  await vi.waitFor(() =>
    expect(connection.getStats).toHaveBeenCalledTimes(statsCalls + 1),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  codecPreflight.probe.mockReset();
  codecPreflight.probe.mockResolvedValue("vp8");
  FakePeerConnection.latest = null;
  FakePeerConnection.instances = [];
  FakePeerConnection.activeCount = 0;
  FakePeerConnection.peakActiveCount = 0;
  FakePeerConnection.offersFailing = 0;
  FakePeerConnection.omitCodecPreferenceSetter = false;
  FakePeerConnection.codecPreferenceCallsFailing = 0;
  statsCallbacks.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: () => ({
      codecs: [
        { mimeType: "video/VP8", clockRate: 90_000 },
        { mimeType: "video/H264", clockRate: 90_000 },
      ],
      headerExtensions: [],
    }),
  });
  vi.stubGlobal("window", {
    setInterval: vi.fn((callback: () => void) => {
      statsCallbacks.push(callback);
      return statsCallbacks.length;
    }),
    clearInterval: vi.fn(),
    setTimeout: (callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
      globalThis.clearTimeout(timer),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HostPeer source replacement", () => {
  it("does not expose WebRTC exception text in connection errors", async () => {
    const updates: PeerSnapshot[] = [];
    FakePeerConnection.offersFailing = 1;
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );

    await expect(peer.start()).resolves.toBe(false);

    expect(updates.at(-1)?.error).toBe("创建连接失败");
    expect(updates.at(-1)?.error).not.toContain("createOffer failed");
  });

  it("offers only advertised VP8 and repair codecs", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          { mimeType: "video/H264", clockRate: 90_000 },
          { mimeType: "video/rtx", clockRate: 90_000 },
          { mimeType: "video/VP9", clockRate: 90_000 },
          { mimeType: "video/RED", clockRate: 90_000 },
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/ulpfec", clockRate: 90_000 },
          { mimeType: "video/AV1", clockRate: 90_000 },
          { mimeType: "video/flexfec-03", clockRate: 90_000 },
        ],
        headerExtensions: [],
      }),
    });
    const peer = createPeer(createStream(createTrack("video", "video"), null));

    await expect(peer.start()).resolves.toBe(true);

    const connection = FakePeerConnection.latest!;
    expect(
      connection.codecPreferenceCalls[0]?.map(({ mimeType }) =>
        mimeType.toLowerCase(),
      ),
    ).toEqual([
      "video/vp8",
      "video/rtx",
      "video/red",
      "video/ulpfec",
      "video/flexfec-03",
    ]);
    expect(connection.createOfferCallCount).toBe(1);
  });

  it("prefers native H264 mode 1 and retains VP8 fallback", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          {
            mimeType: "video/H264",
            clockRate: 90_000,
            sdpFmtpLine: "packetization-mode=0;profile-level-id=42001f",
          },
          {
            mimeType: "video/H264",
            clockRate: 90_000,
            sdpFmtpLine: "packetization-mode=1;profile-level-id=42001f",
          },
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/rtx", clockRate: 90_000 },
          { mimeType: "video/RED", clockRate: 90_000 },
        ],
        headerExtensions: [],
      }),
    });
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      () => undefined,
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      automaticVideoCodecPreference("h264"),
    );

    await expect(peer.start()).resolves.toBe(true);

    expect(
      FakePeerConnection.latest!.codecPreferenceCalls[0]?.map((codec) => [
        codec.mimeType.toLowerCase(),
        codec.sdpFmtpLine ?? null,
      ]),
    ).toEqual([
      ["video/h264", "packetization-mode=1;profile-level-id=42001f"],
      ["video/vp8", null],
      ["video/rtx", null],
      ["video/red", null],
    ]);
  });

  it("keeps a manual H264 selection strict", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          {
            mimeType: "video/H264",
            clockRate: 90_000,
            sdpFmtpLine: "packetization-mode=1;profile-level-id=42001f",
          },
          { mimeType: "video/VP8", clockRate: 90_000 },
          { mimeType: "video/rtx", clockRate: 90_000 },
        ],
        headerExtensions: [],
      }),
    });
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      () => undefined,
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      manualVideoCodecPreference("h264"),
    );

    await expect(peer.start()).resolves.toBe(true);

    expect(
      FakePeerConnection.latest!.codecPreferenceCalls[0]?.map(({ mimeType }) =>
        mimeType.toLowerCase(),
      ),
    ).toEqual(["video/h264", "video/rtx"]);
  });

  it("fails before creating an offer when codec preferences are unavailable", async () => {
    FakePeerConnection.omitCodecPreferenceSetter = true;
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );

    await expect(peer.start()).resolves.toBe(false);

    expect(FakePeerConnection.latest!.createOfferCallCount).toBe(0);
    expect(FakePeerConnection.latest!.localDescription).toBeNull();
    expect(updates.at(-1)?.error).toBe("当前浏览器无法使用支持的视频编码");
  });

  it("fails before creating an offer when VP8 is unavailable", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [
          { mimeType: "video/H264", clockRate: 90_000 },
          { mimeType: "video/rtx", clockRate: 90_000 },
        ],
        headerExtensions: [],
      }),
    });
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );

    await expect(peer.start()).resolves.toBe(false);

    expect(FakePeerConnection.latest!.createOfferCallCount).toBe(0);
    expect(FakePeerConnection.latest!.localDescription).toBeNull();
    expect(updates.at(-1)?.error).toBe("当前浏览器无法使用支持的视频编码");
  });

  it("fails before creating an offer when codec preference setup fails", async () => {
    FakePeerConnection.codecPreferenceCallsFailing = 1;
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );

    await expect(peer.start()).resolves.toBe(false);

    expect(FakePeerConnection.latest!.createOfferCallCount).toBe(0);
    expect(FakePeerConnection.latest!.localDescription).toBeNull();
    expect(updates.at(-1)?.error).toBe("当前浏览器无法使用支持的视频编码");
  });

  it("applies STUN-only ICE configuration at creation and update", () => {
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      () => undefined,
      { iceServers: [{ urls: ["stun:stun-a.example.test:3478"] }] },
    );
    const connection = FakePeerConnection.latest!;

    peer.updateIceConfig({
      iceServers: [{ urls: ["stun:stun-b.example.test:3478"] }],
    });

    expect(connection.configurations).toEqual([
      { iceServers: [{ urls: ["stun:stun-a.example.test:3478"] }] },
      { iceServers: [{ urls: ["stun:stun-b.example.test:3478"] }] },
    ]);
    expect(connection.setConfiguration).toHaveBeenCalledOnce();
    for (const configuration of connection.configurations) {
      expect(
        configuration.iceServers?.every(
          (server) =>
            !Reflect.has(server, "username") &&
            !Reflect.has(server, "credential") &&
            (typeof server.urls === "string"
              ? server.urls.startsWith("stun:")
              : server.urls.every((url) => url.startsWith("stun:"))),
        ),
      ).toBe(true);
    }
  });

  it("reserves send-only video and audio senders and replaces both tracks", async () => {
    const oldVideo = createTrack("video", "old-video");
    const oldAudio = createTrack("audio", "old-audio");
    const peer = createPeer(
      createStream(oldVideo, oldAudio),
      () => undefined,
      { iceServers: [] },
      {
        ...QUALITY_PROFILES["720p30"],
        screenAudioQuality: "very-high",
      },
    );

    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const connection = FakePeerConnection.latest!;
    const oldSenderVideo = connection.senders[0]!.track!;
    expect(oldSenderVideo).not.toBe(oldVideo);
    expect(connection.transceiverInputs).toHaveLength(2);
    expect(connection.transceiverInputs.map(({ init }) => init?.direction)).toEqual([
      "sendonly",
      "sendonly",
    ]);

    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(createStream(nextVideo, nextAudio)),
    ).resolves.toBe(true);

    const nextSenderVideo = connection.senders[0]?.track;
    expect(nextSenderVideo).not.toBe(nextVideo);
    expect(nextSenderVideo?.id).toBe(nextVideo.id);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(oldSenderVideo.stop).toHaveBeenCalledOnce();
    expect(connection.transceiverInputs).toHaveLength(2);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(3);
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([
      192_000,
      192_000,
    ]);
    peer.dispose();
    expect(nextVideo.stop).not.toHaveBeenCalled();
    expect(nextSenderVideo?.stop).toHaveBeenCalledOnce();
  });

  it("keeps capture controls on the sender-owned video clone", async () => {
    const sourceVideo = createConfiguredVideoTrack(
      "capture-video",
      1920,
      1080,
      30,
    );
    sourceVideo.contentHint = "motion";
    const sourceAudio = createTrack("audio", "capture-audio");
    const peer = createPeer(createStream(sourceVideo, sourceAudio));

    await expect(peer.start()).resolves.toBe(true);
    const senderVideo = FakePeerConnection.latest!.senders[0]!.track!;
    expect(senderVideo).not.toBe(sourceVideo);
    expect(senderVideo.contentHint).toBe("motion");

    peer.setPaused(true);
    expect(senderVideo.enabled).toBe(false);
    expect(sourceVideo.enabled).toBe(true);
    peer.setPaused(false);
    expect(senderVideo.enabled).toBe(true);

    await expect(
      peer.updateCaptureProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);
    expect(senderVideo.applyConstraints).toHaveBeenLastCalledWith({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(sourceVideo.applyConstraints).not.toHaveBeenCalled();

    peer.dispose();
    expect(senderVideo.stop).toHaveBeenCalledOnce();
    expect(sourceVideo.stop).not.toHaveBeenCalled();
  });

  it("fills a pre-negotiated audio sender that started without a track", async () => {
    const peer = createPeer(
      createStream(createTrack("video", "old-video"), null),
    );

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    expect(connection.transceiverInputs[1]?.trackOrKind).toBe("audio");
    expect(connection.senders[1]?.track).toBeNull();
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([]);

    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(
        createStream(createTrack("video", "next-video"), nextAudio),
      ),
    ).resolves.toBe(true);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([128_000]);
  });

  it("stops sending audio without renegotiating when the new source has none", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "old-video"),
        createTrack("audio", "old-audio"),
      ),
    );

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    await expect(
      peer.replaceStream(
        createStream(createTrack("video", "next-video"), null),
      ),
    ).resolves.toBe(true);

    expect(connection.senders[1]?.track).toBeNull();
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([128_000]);
  });

  it("updates quality parameters without replacing media tracks", async () => {
    const video = createTrack("video", "video");
    const audio = createTrack("audio", "audio");
    const peer = createPeer(createStream(video, audio));

    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const connection = FakePeerConnection.latest!;
    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);

    expect(connection.senders[0]?.replaceTrack).not.toHaveBeenCalled();
    expect(connection.senders[1]?.replaceTrack).not.toHaveBeenCalled();
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(3);
    expect(
      connection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 8_000_000, maxFramerate: 60 }],
    });
    expect(connection.senders[1]?.setParameters).toHaveBeenCalledOnce();

    await expect(
      peer.updateProfile({
        ...QUALITY_PROFILES["1080p60"],
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(3);
    expect(connection.senders[1]?.setParameters).toHaveBeenCalledTimes(2);
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([
      128_000,
      192_000,
    ]);
    expect(peer.getSnapshot().audioSenderParameters).toEqual({
      requestedMaxBitrate: 192_000,
      appliedMaxBitrate: 192_000,
      mismatch: false,
    });
  });

  it("keeps media and prior audio readback when a live ceiling fails", async () => {
    const video = createTrack("video", "video");
    const audio = createTrack("audio", "audio");
    const peer = createPeer(createStream(video, audio));

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const audioSender = connection.senders[1]!;
    audioSender.failNextSetParameters = true;

    await expect(
      peer.updateProfile({
        ...QUALITY_PROFILES["720p30"],
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(false);

    expect(audioSender.track).toBe(audio);
    expect(audioSender.getParameters().encodings[0]?.maxBitrate).toBe(128_000);
    expect(peer.getSnapshot().audioSenderParameters?.appliedMaxBitrate).toBe(
      128_000,
    );
    expect(peer.getSnapshot().qualityWarning).toContain(
      "应用音频发送参数失败",
    );

    await expect(
      peer.updateProfile({
        ...QUALITY_PROFILES["720p30"],
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    expect(audioSender.getParameters().encodings[0]?.maxBitrate).toBe(192_000);
    expect(peer.getSnapshot().qualityWarning).toBeNull();
  });

  it("keeps rapid audio ceiling changes last-wins", async () => {
    const peer = createPeer(
      createStream(createTrack("video", "video"), createTrack("audio", "audio")),
    );
    await expect(peer.start()).resolves.toBe(true);
    const audioSender = FakePeerConnection.latest!.senders[1]!;
    audioSender.deferNextSetParameters = true;

    const saver = peer.updateProfile({
      ...QUALITY_PROFILES["720p30"],
      screenAudioQuality: "saver",
    });
    await vi.waitFor(() =>
      expect(audioSender.setParameters).toHaveBeenCalledTimes(2),
    );
    const veryHigh = peer.updateProfile({
      ...QUALITY_PROFILES["720p30"],
      screenAudioQuality: "very-high",
    });
    audioSender.releaseDeferredSetParameters();

    await expect(saver).resolves.toBe(false);
    await expect(veryHigh).resolves.toBe(true);
    expect(audioSender.appliedMaxBitrates).toEqual([
      128_000,
      64_000,
      192_000,
    ]);
    expect(peer.getSnapshot().audioSenderParameters?.appliedMaxBitrate).toBe(
      192_000,
    );
  });

  it("enables the selected balanced profile after startup frames", async () => {
    const video = createTrack("video", "video");
    const peer = createPeer(createStream(video, createTrack("audio", "audio")));

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledOnce();
    expect(
      connection.senders[0]?.setParameters.mock.calls[0]?.[0],
    ).toMatchObject({ degradationPreference: "maintain-resolution" });
    const pendingCandidate = { candidate: "candidate-before-answer" };
    await peer.acceptSignal({
      kind: "candidate",
      connectionId: peer.connectionId,
      candidate: pendingCandidate,
    });
    expect(connection.addedIceCandidates).toEqual([]);
    await peer.acceptSignal({
      kind: "description",
      connectionId: peer.connectionId,
      description: { type: "answer", sdp: "test-answer" },
    });

    expect(connection.remoteDescription?.type).toBe("answer");
    expect(connection.addedIceCandidates).toEqual([pendingCandidate]);
    expect(connection.senders[0]?.track).not.toBe(video);
    expect(connection.senders[0]?.track?.id).toBe(video.id);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledOnce();

    connection.connectionState = "connected";
    connection.dispatchEvent(new Event("connectionstatechange"));
    await Promise.resolve();
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledOnce();

    await completeVideoStartup(connection, 4);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledOnce();

    await completeVideoStartup(connection, 5);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(2);
    expect(
      connection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 3_000_000, maxFramerate: 30 }],
    });
    expect(connection.senders[1]?.setParameters).toHaveBeenCalledOnce();
  });

  it("applies the latest pre-answer profile once negotiation completes", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    await expect(peer.start()).resolves.toBe(true);
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    expect(videoSender.setParameters).toHaveBeenCalledOnce();

    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);
    expect(videoSender.setParameters).toHaveBeenCalledOnce();

    await acceptPeerAnswer(peer);
    await vi.waitFor(() =>
      expect(videoSender.setParameters).toHaveBeenCalledTimes(2),
    );
    expect(videoSender.appliedMaxBitrates).toEqual([3_000_000, 8_000_000]);
  });

  it("replays the desired profile only after a connected peer reconnects", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const connection = FakePeerConnection.latest!;
    const videoSender = connection.senders[0]!;
    const audioSender = connection.senders[1]!;
    const videoCalls = videoSender.setParameters.mock.calls.length;
    const audioCalls = audioSender.setParameters.mock.calls.length;

    connection.dispatchEvent(new Event("connectionstatechange"));
    await Promise.resolve();
    expect(videoSender.setParameters).toHaveBeenCalledTimes(videoCalls);
    expect(audioSender.setParameters).toHaveBeenCalledTimes(audioCalls);

    connection.connectionState = "disconnected";
    connection.dispatchEvent(new Event("connectionstatechange"));
    connection.connectionState = "connected";
    connection.dispatchEvent(new Event("connectionstatechange"));

    await vi.waitFor(() =>
      expect(videoSender.setParameters).toHaveBeenCalledTimes(videoCalls + 1),
    );
    expect(audioSender.setParameters).toHaveBeenCalledTimes(audioCalls + 1);
  });

  it("continues queued profile updates after initial configuration rejects", async () => {
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
      (snapshot) => updates.push(snapshot),
    );

    const starting = peer.start();
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    videoSender.failNextSetParameters = true;
    await expect(starting).resolves.toBe(true);
    await acceptPeerAnswer(peer);

    const failureWarning = updates.find((snapshot) =>
      snapshot.qualityWarning?.startsWith("应用发送参数失败"),
    )?.qualityWarning;
    expect(failureWarning).toBe("应用发送参数失败");
    expect(failureWarning).not.toContain("setParameters failed");
    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);
    expect(videoSender.setParameters).toHaveBeenCalledTimes(3);
    expect(videoSender.appliedMaxBitrates).toEqual([3_000_000, 8_000_000]);
  });

  it("can retry the selected quality after a sender update fails", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    videoSender.failNextSetParameters = true;

    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(false);
    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);

    expect(videoSender.setParameters).toHaveBeenCalledTimes(4);
    expect(videoSender.setParameters.mock.calls.at(-1)?.[0]).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 8_000_000, maxFramerate: 60 }],
    });
  });

  it("discards an in-flight stats sample after a profile reset", async () => {
    let resolveOldStats!: (report: RTCStatsReport) => void;
    const oldStats = new Promise<RTCStatsReport>((resolve) => {
      resolveOldStats = resolve;
    });
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );

    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const connection = FakePeerConnection.latest!;
    connection.statsReports.push(oldStats);
    statsCallbacks[0]!();
    await vi.waitFor(() => expect(connection.statsReports).toHaveLength(0));
    statsCallbacks[0]!();
    expect(connection.getStats).toHaveBeenCalledTimes(2);

    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);
    resolveOldStats(
      sendStatsReport({
        bytesSent: 1_000_000,
        framesEncoded: 30,
        timestamp: 1_000,
        totalEncodeTime: 0.15,
        qualityLimitationReason: "cpu",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      updates.some(
        ({ metrics }) => metrics.qualityLimitationReason === "cpu",
      ),
    ).toBe(false);

    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 2_000_000,
        framesEncoded: 60,
        timestamp: 2_000,
        totalEncodeTime: 0.3,
        qualityLimitationReason: "bandwidth",
      }),
      sendStatsReport({
        bytesSent: 2_500_000,
        framesEncoded: 90,
        timestamp: 3_000,
        totalEncodeTime: 0.9,
        qualityLimitationReason: "bandwidth",
      }),
    );
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.qualityLimitationReason).toBe(
        "bandwidth",
      ),
    );
    expect(updates.at(-1)?.metrics.intervalEncodeMs).toBeNull();

    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.intervalEncodeMs).toBeCloseTo(20),
    );
    expect(
      updates.some(
        ({ metrics }) => metrics.qualityLimitationReason === "cpu",
      ),
    ).toBe(false);
  });

  it("publishes capture settings with outbound evidence from the same stats tick", async () => {
    const getSettings = vi.fn(() => ({
      width: 1920,
      height: 1080,
      frameRate: 59.94,
    }));
    const videoTrack = createTrack("video", "capture-video");
    videoTrack.getSettings = getSettings;
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(videoTrack, null),
      (snapshot) => updates.push(snapshot),
    );
    await expect(peer.start()).resolves.toBe(true);
    getSettings.mockClear();
    const connection = FakePeerConnection.latest!;
    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 1_000_000,
        framesEncoded: 30,
        timestamp: 1_234,
        qualityLimitationReason: "none",
        trackIdentifier: "capture-video",
      }),
    );

    expect(getSettings).not.toHaveBeenCalled();
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(1_234),
    );

    expect(connection.getStats).toHaveBeenCalledOnce();
    expect(getSettings).toHaveBeenCalledOnce();
    expect(updates.at(-1)?.metrics).toMatchObject({
      sampleTimestampMs: 1_234,
      rtpStatsId: "outbound-video",
      resolution: "1280x720",
      captureWidth: 1920,
      captureHeight: 1080,
      captureFramesPerSecond: 59.94,
    });
  });

  it("samples only the current audio sender and excludes old audio after removal", async () => {
    const video = createConfiguredVideoTrack("capture-video", 1920, 1080, 60);
    const audio = createTrack("audio", "current-audio");
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(video, audio),
      (snapshot) => updates.push(snapshot),
    );
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const report = (timestamp: number, currentBytes: number, oldBytes: number) =>
      withOutboundAudio(
        sendStatsReport({
          bytesSent: timestamp * 1_000,
          framesEncoded: timestamp / 20,
          timestamp,
          qualityLimitationReason: "none",
          trackIdentifier: video.id,
        }),
        [
          {
            id: "current-audio-out",
            trackIdentifier: audio.id,
            bytesSent: currentBytes,
          },
          {
            id: "old-audio-out",
            trackIdentifier: "old-audio",
            bytesSent: oldBytes,
          },
        ],
      );
    connection.statsReports.push(
      report(1_000, 10_000, 100_000),
      report(3_000, 50_000, 300_000),
    );

    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(1_000),
    );
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.audioBitrateKbps).toBe(160),
    );

    const nextVideo = createConfiguredVideoTrack("next-video", 1280, 720, 30);
    await expect(
      peer.replaceStream(createStream(nextVideo, null)),
    ).resolves.toBe(true);
    connection.statsReports.push(
      withOutboundAudio(
        sendStatsReport({
          bytesSent: 4_000_000,
          framesEncoded: 200,
          timestamp: 4_000,
          qualityLimitationReason: "none",
          trackIdentifier: nextVideo.id,
        }),
        [
          {
            id: "old-audio-out",
            trackIdentifier: audio.id,
            bytesSent: 400_000,
          },
        ],
      ),
    );
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(4_000),
    );
    expect(updates.at(-1)?.metrics).toMatchObject({
      trackIdentifier: nextVideo.id,
      audioBitrateKbps: null,
      audioCodec: null,
    });
  });

  it.each([
    {
      outcome: "succeeds",
      rollback: false,
      deferredCall: 1,
      result: true,
      committed: "next" as const,
    },
    {
      outcome: "rolls back",
      rollback: true,
      deferredCall: 2,
      result: false,
      committed: "old" as const,
    },
  ])("blocks stale stats while replacement $outcome", async ({
    rollback,
    deferredCall,
    result,
    committed,
  }) => {
    const scenario = rollback ? "rollback" : "success";
    let resolveOldStats!: (report: RTCStatsReport) => void;
    const oldStats = new Promise<RTCStatsReport>((resolve) => {
      resolveOldStats = resolve;
    });
    const oldVideo = createConfiguredVideoTrack(
      `${scenario}-old-capture`,
      1280,
      720,
      30,
    );
    const nextVideo = createConfiguredVideoTrack(
      `${scenario}-next-capture`,
      1920,
      1080,
      60,
    );
    const oldAudio = rollback ? createTrack("audio", "old-audio") : null;
    const nextAudio = rollback ? createTrack("audio", "next-audio") : null;
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(oldVideo, oldAudio),
      (snapshot) => updates.push(snapshot),
    );
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const videoSender = connection.senders[0]!;
    const audioSender = connection.senders[1]!;
    const initialSenderVideo = videoSender.track;
    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 500_000,
        framesEncoded: 15,
        timestamp: 500,
        qualityLimitationReason: "none",
        trackIdentifier: oldVideo.id,
      }),
    );
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(500),
    );
    connection.statsReports.push(oldStats);
    statsCallbacks[0]!();
    await vi.waitFor(() => expect(connection.getStats).toHaveBeenCalledTimes(2));

    videoSender.deferReplaceCall = deferredCall;
    audioSender.failNextReplace = rollback;
    const replacing = peer.replaceStream(
      createStream(nextVideo, nextAudio),
    );
    await vi.waitFor(() =>
      expect(videoSender.replaceTrack).toHaveBeenCalledTimes(deferredCall),
    );

    resolveOldStats(
      sendStatsReport({
        bytesSent: 1_000_000,
        framesEncoded: 30,
        timestamp: 1_000,
        qualityLimitationReason: "none",
        trackIdentifier: oldVideo.id,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      updates.some(({ metrics }) => metrics.sampleTimestampMs === 1_000),
    ).toBe(false);
    statsCallbacks[0]!();
    expect(connection.getStats).toHaveBeenCalledTimes(2);

    videoSender.releaseDeferredReplaceTrack();
    await expect(replacing).resolves.toBe(result);
    const committedVideo = committed === "old" ? oldVideo : nextVideo;
    if (committed === "old") {
      expect(videoSender.track).toBe(initialSenderVideo);
    } else {
      expect(videoSender.track).not.toBe(nextVideo);
      expect(videoSender.track?.id).toBe(nextVideo.id);
    }
    expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(
      committed === "old" ? 500 : null,
    );

    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 2_000_000,
        framesEncoded: 60,
        timestamp: 2_000,
        qualityLimitationReason: "none",
        trackIdentifier: committedVideo.id,
      }),
    );
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(updates.at(-1)?.metrics.sampleTimestampMs).toBe(2_000),
    );
    expect(updates.at(-1)?.metrics).toMatchObject({
      trackIdentifier: committedVideo.id,
      captureWidth: committed === "old" ? 1280 : 1920,
      captureHeight: committed === "old" ? 720 : 1080,
      captureFramesPerSecond: committed === "old" ? 30 : 60,
    });
  });

  it("explains a sustained browser quality limitation without changing settings", async () => {
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );
    await expect(peer.start()).resolves.toBe(true);
    await acceptPeerAnswer(peer);
    const connection = FakePeerConnection.latest!;
    const sender = connection.senders[0]!;
    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 1_000_000,
        framesEncoded: 30,
        timestamp: 1_000,
        qualityLimitationReason: "bandwidth",
      }),
      sendStatsReport({
        bytesSent: 1_500_000,
        framesEncoded: 60,
        timestamp: 2_000,
        qualityLimitationReason: "bandwidth",
      }),
      sendStatsReport({
        bytesSent: 2_000_000,
        framesEncoded: 90,
        timestamp: 3_000,
        qualityLimitationReason: "bandwidth",
      }),
      sendStatsReport({
        bytesSent: 2_500_000,
        framesEncoded: 120,
        timestamp: 4_000,
        qualityLimitationReason: "none",
      }),
    );

    const sample = async (): Promise<void> => {
      const updateCount = updates.length;
      statsCallbacks[0]!();
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updateCount));
    };
    await sample();
    await sample();
    expect(updates.at(-1)?.qualityWarning).toBeNull();
    await sample();
    expect(updates.at(-1)?.qualityWarning).toBe(
      "当前连接带宽受限，画质已自动降低",
    );
    expect(sender.setParameters).toHaveBeenCalledTimes(2);

    await sample();
    expect(updates.at(-1)?.qualityWarning).toBeNull();
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
  });

  it("does not expose an unknown browser quality-limitation value", async () => {
    const updates: PeerSnapshot[] = [];
    const peer = createPeer(
      createStream(createTrack("video", "video"), null),
      (snapshot) => updates.push(snapshot),
    );
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    for (const timestamp of [1_000, 2_000, 3_000]) {
      connection.statsReports.push(
        sendStatsReport({
          bytesSent: timestamp * 1_000,
          framesEncoded: timestamp / 10,
          timestamp,
          qualityLimitationReason: "browser-internal-sentinel",
        }),
      );
    }

    for (let index = 0; index < 3; index += 1) {
      const updateCount = updates.length;
      statsCallbacks[0]!();
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(updateCount));
    }

    expect(updates.at(-1)?.qualityWarning).toBe(
      "浏览器持续报告未分类的画质限制",
    );
  });

  it("rolls the first sender back when the second replacement fails", async () => {
    const oldVideo = createTrack("video", "old-video");
    const oldAudio = createTrack("audio", "old-audio");
    const peer = createPeer(createStream(oldVideo, oldAudio));
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const videoSender = connection.senders[0]!;
    const audioSender = connection.senders[1]!;
    const oldSenderVideo = videoSender.track;
    audioSender.failNextReplace = true;

    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(createStream(nextVideo, nextAudio)),
    ).resolves.toBe(false);

    const nextSenderVideo = videoSender.replaceTrack.mock.calls[0]?.[0];
    expect(nextSenderVideo).not.toBe(nextVideo);
    expect(nextSenderVideo?.id).toBe(nextVideo.id);
    expect(videoSender.replaceTrack).toHaveBeenNthCalledWith(2, oldSenderVideo);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(1, nextAudio);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(2, oldAudio);
    expect(videoSender.track).toBe(oldSenderVideo);
    expect(nextSenderVideo?.stop).toHaveBeenCalledOnce();
    expect(oldSenderVideo?.stop).not.toHaveBeenCalled();
    expect(oldVideo.stop).not.toHaveBeenCalled();
    expect(audioSender.track).toBe(oldAudio);
  });
});

function hostAssignment(
  childPeerIds: string[],
  publicationGeneration: string | null = null,
): ParticipantRouteAssignment {
  return {
    upstream: { kind: "none" },
    childPeerIds,
    sfuPublicationGeneration: publicationGeneration,
  };
}

function hostProvisionalInput(
  revision: number,
  childPeerIds: string[],
  stream: MediaStream,
  overrides: {
    activeChildPeerIds?: string[];
    publicationGeneration?: string | null;
  } = {},
) {
  return {
    revision,
    candidate: {
      childPeerId: childPeerIds.at(-1) ?? "candidate-child",
      connectionId: `candidate-connection-${revision}`,
      transport: "direct" as const,
      qualityProbe: false,
    },
    assignment: hostAssignment(
      childPeerIds,
      overrides.publicationGeneration ?? null,
    ),
    activeChildPeerIds: overrides.activeChildPeerIds ?? [],
    maxMediaEdges: 2,
    iceConfig: { iceServers: [] },
    stream,
    profile: QUALITY_PROFILES["720p30"],
    videoCodec: VP8_ONLY_VIDEO_CODEC,
  };
}

describe("Host provisional child runtime ownership", () => {
  it("accepts only the exact connection and promotes the same peer", async () => {
    const signals: Array<{ peerId: string; connectionId: string }> = [];
    const promotedUpdates = vi.fn();
    const owner = new HostProvisionalChild({
      sendSignal: (peerId, payload) => {
        signals.push({ peerId, connectionId: payload.connectionId });
        return true;
      },
      onPromotedUpdate: promotedUpdates,
    });
    const stream = createStream(createTrack("video", "host-probe-video"), null);
    const input = hostProvisionalInput(7, ["probe-child"], stream);

    expect(owner.prepare(input)).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    expect(FakePeerConnection.activeCount).toBe(1);

    expect(owner.acceptSignal("wrong-child", {
      kind: "description",
      connectionId: preparedConnectionId,
      description: { type: "answer", sdp: "wrong-peer" },
    })).toBe(false);
    expect(owner.acceptSignal("probe-child", {
      kind: "description",
      connectionId: "wrong-connection",
      description: { type: "answer", sdp: "wrong-connection" },
    })).toBe(false);
    expect(owner.acceptSignal("probe-child", {
      kind: "candidate",
      connectionId: preparedConnectionId,
      candidate: { candidate: "host-probe-candidate" },
    })).toBe(true);
    expect(owner.acceptSignal("probe-child", {
      kind: "description",
      connectionId: preparedConnectionId,
      description: { type: "answer", sdp: "right-answer" },
    })).toBe(true);
    await vi.waitFor(() =>
      expect(preparedConnection.remoteDescription?.sdp).toBe("right-answer"),
    );
    expect(preparedConnection.addedIceCandidates).toEqual([
      { candidate: "host-probe-candidate" },
    ]);

    const activation = owner.activate(input);
    expect(activation.kind).toBe("promote");
    if (activation.kind !== "promote") {
      throw new Error("expected the prepared Host child to promote");
    }
    expect(activation.peer.connectionId).toBe(preparedConnectionId);
    expect(FakePeerConnection.latest).toBe(preparedConnection);
    expect(FakePeerConnection.activeCount).toBe(1);
    await expect(activation.peer.restartIce()).resolves.toBe(true);
    expect(signals).toEqual([
      { peerId: "probe-child", connectionId: preparedConnectionId },
      { peerId: "probe-child", connectionId: preparedConnectionId },
    ]);
    expect(promotedUpdates).toHaveBeenCalledWith(
      activation.peer,
      expect.objectContaining({ connectionId: preparedConnectionId }),
    );
    activation.peer.dispose();
  });

  it("disposes stale prepares on replacement, rollback, and auth reset", async () => {
    const owner = new HostProvisionalChild({ sendSignal: () => true });
    const stream = createStream(createTrack("video", "host-cleanup-video"), null);

    expect(owner.prepare(hostProvisionalInput(7, ["first-probe"], stream))).toBe(true);
    const first = FakePeerConnection.latest!;
    expect(owner.prepare(hostProvisionalInput(8, ["second-probe"], stream))).toBe(true);
    const second = FakePeerConnection.latest!;
    expect(first.connectionState).toBe("closed");

    expect(owner.activate({
      revision: 9,
      assignment: hostAssignment([]),
      activeChildPeerIds: [],
      maxMediaEdges: 2,
    })).toEqual({ kind: "ordinary" });
    expect(second.connectionState).toBe("closed");

    expect(owner.prepare(hostProvisionalInput(10, ["auth-probe"], stream))).toBe(true);
    const authProbe = FakePeerConnection.latest!;
    owner.discard();
    expect(authProbe.connectionState).toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(0);
  });

  it("updates the prepared stream before promotion", async () => {
    const owner = new HostProvisionalChild({ sendSignal: () => true });
    const initial = createStream(createTrack("video", "initial-video"), null);
    const replacement = createTrack("video", "replacement-video");
    const input = hostProvisionalInput(12, ["stream-child"], initial);

    expect(owner.prepare(input)).toBe(true);
    const connection = FakePeerConnection.latest!;
    await expect(
      owner.replaceStream(createStream(replacement, null)),
    ).resolves.toBe(true);
    expect(connection.senders[0]!.track).not.toBe(replacement);
    expect(connection.senders[0]!.track?.id).toBe(replacement.id);

    const activation = owner.activate({
      revision: input.revision,
      assignment: input.assignment,
      activeChildPeerIds: [],
      maxMediaEdges: 2,
    });
    expect(activation.kind).toBe("promote");
    if (activation.kind === "promote") {
      activation.peer.dispose();
    }
  });

});

describe("ViewerRelay downstream ownership", () => {
  it("gives each downstream sender its own video clone", async () => {
    const sourceVideo = createTrack("video", "relay-source");
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );

    relay.setChildren(["child-one", "child-two"]);
    relay.setStream(createStream(sourceVideo, null));
    await vi.waitFor(() =>
      expect(FakePeerConnection.instances).toHaveLength(2),
    );
    const [firstTrack, secondTrack] = FakePeerConnection.instances.map(
      (connection) => connection.senders[0]!.track!,
    );
    expect(firstTrack).not.toBe(sourceVideo);
    expect(secondTrack).not.toBe(sourceVideo);
    expect(firstTrack).not.toBe(secondTrack);
    expect(firstTrack.contentHint).toBe("motion");
    expect(secondTrack.contentHint).toBe("motion");

    relay.stop();
    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(sourceVideo.stop).not.toHaveBeenCalled();
  });

  const routeCandidate = (
    revision: number,
    childPeerId: string,
  ) => ({
    childPeerId,
    connectionId: `relay-candidate-${revision}`,
    transport: "direct" as const,
    qualityProbe: false,
  });

  it("keeps a completed H264 decision across source replacement", async () => {
    codecPreflight.probe.mockResolvedValueOnce("h264");
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setStream(createStream(createTrack("video", "h264-source"), null));
    await vi.waitFor(() => expect(codecPreflight.probe).toHaveBeenCalledOnce());
    await Promise.resolve();
    relay.setStream(
      createStream(createTrack("video", "replacement-source"), null),
    );
    expect(codecPreflight.probe).toHaveBeenCalledOnce();
    relay.setChildren(["h264-child"]);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest?.codecPreferenceCalls).toHaveLength(1),
    );

    expect(
      FakePeerConnection.latest!.codecPreferenceCalls[0]?.map(({ mimeType }) =>
        mimeType.toLowerCase(),
      ),
    ).toEqual(["video/h264", "video/vp8"]);
    relay.dispose();
  });

  it("promotes the exact prepared child connection within the current Viewer cap", async () => {
    const signals: Array<{ peerId: string; connectionId: string }> = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (peerId, payload) => {
          signals.push({ peerId, connectionId: payload.connectionId });
          return true;
        },
      },
    );
    relay.setStream(createStream(createTrack("video", "prepared-video"), null));
    expect(relay.prepareChild(7, routeCandidate(7, "prepared-child"), ["prepared-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    expect(relay.getSnapshot("prepared-child")).toBeNull();
    expect(FakePeerConnection.activeCount).toBe(1);

    await expect(
      relay.acceptSignal("prepared-child", {
        kind: "description",
        connectionId: "wrong-connection",
        description: { type: "answer", sdp: "wrong-answer" },
      }, 7),
    ).resolves.toBe(false);
    await expect(
      relay.acceptSignal("prepared-child", {
        kind: "description",
        connectionId: preparedConnectionId,
        description: { type: "answer", sdp: "right-answer" },
      }, 6),
    ).resolves.toBe(false);
    const preparedRevision = relay.getSignalRouteRevision(
      "prepared-child",
      preparedConnectionId,
      6,
    );
    expect(preparedRevision).toBe(7);
    const candidate = { candidate: "prepared-candidate" };
    await expect(
      relay.acceptSignal("prepared-child", {
        kind: "candidate",
        connectionId: preparedConnectionId,
        candidate,
      }, preparedRevision),
    ).resolves.toBe(true);
    expect(preparedConnection.addedIceCandidates).toEqual([]);
    await expect(
      relay.acceptSignal("prepared-child", {
        kind: "description",
        connectionId: preparedConnectionId,
        description: { type: "answer", sdp: "right-answer" },
      }, preparedRevision),
    ).resolves.toBe(true);
    expect(preparedConnection.remoteDescription?.sdp).toBe("right-answer");
    expect(preparedConnection.addedIceCandidates).toEqual([candidate]);

    preparedConnection.connectionState = "connected";
    relay.activateChildren(7, ["prepared-child"]);
    expect(FakePeerConnection.latest).toBe(preparedConnection);
    expect(FakePeerConnection.activeCount).toBe(1);
    expect(relay.getSnapshot("prepared-child")?.connectionId).toBe(
      preparedConnectionId,
    );
    relay.dispose();
  });

  it("cleans prepared children on failure, replacement, rollback, session reset, and share stop", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setStream(createStream(createTrack("video", "rollback-video"), null));
    expect(relay.prepareChild(7, routeCandidate(7, "first-probe"), ["first-probe"])).toBe(true);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    const firstProbe = FakePeerConnection.latest!;
    expect(relay.prepareChild(8, routeCandidate(8, "second-probe"), ["second-probe"])).toBe(true);
    const secondProbe = FakePeerConnection.latest!;
    expect(firstProbe.connectionState).toBe("closed");
    relay.activateChildren(9, []);
    expect(secondProbe.connectionState).toBe("closed");

    FakePeerConnection.offersFailing = 1;
    const instancesBeforeFailure = FakePeerConnection.instances.length;
    expect(relay.prepareChild(10, routeCandidate(10, "failed-probe"), ["failed-probe"])).toBe(true);
    const failedProbe = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(failedProbe.connectionState).toBe("closed"));
    expect(FakePeerConnection.instances).toHaveLength(instancesBeforeFailure + 1);

    expect(relay.prepareChild(11, routeCandidate(11, "session-probe"), ["session-probe"])).toBe(true);
    const sessionProbe = FakePeerConnection.latest!;
    relay.discardPreparedChild();
    expect(sessionProbe.connectionState).toBe("closed");

    expect(relay.prepareChild(12, routeCandidate(12, "stopped-probe"), ["stopped-probe"])).toBe(true);
    const stoppedProbe = FakePeerConnection.latest!;
    relay.stop();
    expect(stoppedProbe.connectionState).toBe("closed");
    relay.dispose();
  });

  it("keeps the prepared connection when its stream replacement succeeds", async () => {
    const signals: Array<{ peerId: string; connectionId: string }> = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (peerId, payload) => {
          signals.push({ peerId, connectionId: payload.connectionId });
          return true;
        },
      },
    );
    relay.setStream(createStream(createTrack("video", "initial-video"), null));
    expect(relay.prepareChild(7, routeCandidate(7, "prepared-child"), ["prepared-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    const instanceCount = FakePeerConnection.instances.length;

    const replacementVideo = createTrack("video", "replacement-video");
    relay.setStream(createStream(replacementVideo, null));
    await vi.waitFor(() =>
      expect(preparedConnection.senders[0]!.track?.id).toBe(replacementVideo.id),
    );
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    preparedConnection.connectionState = "connected";
    relay.activateChildren(7, ["prepared-child"]);
    expect(relay.getSnapshot("prepared-child")?.connectionId).toBe(
      preparedConnectionId,
    );
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    relay.dispose();
  });

  it("syncs same-stream audio changes into the prepared connection", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    const video = createTrack("video", "persistent-video");
    let audio: MediaStreamTrack | null = null;
    const persistentStream = {
      getTracks: () => (audio ? [video, audio] : [video]),
      getVideoTracks: () => [video],
      getAudioTracks: () => (audio ? [audio] : []),
    } as unknown as MediaStream;

    relay.setStream(persistentStream);
    expect(
      relay.prepareChild(
        7,
        routeCandidate(7, "prepared-child"),
        ["prepared-child"],
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    const preparedConnection = FakePeerConnection.latest!;
    expect(preparedConnection.senders[1]?.track).toBeNull();

    audio = createTrack("audio", "late-audio");
    relay.setStream(persistentStream);
    await vi.waitFor(() =>
      expect(preparedConnection.senders[1]?.track).toBe(audio),
    );

    audio = null;
    relay.setStream(persistentStream);
    await vi.waitFor(() =>
      expect(preparedConnection.senders[1]?.track).toBeNull(),
    );
    expect(FakePeerConnection.latest).toBe(preparedConnection);
    relay.dispose();
  });

  it("admits provisional children until endpoint cap three is full", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setStream(createStream(createTrack("video", "cap-video"), null));
    expect(relay.prepareChild(1, routeCandidate(1, "child-0"), ["child-0"])).toBe(true);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    const preparedConnection = FakePeerConnection.latest!;
    preparedConnection.connectionState = "connected";
    relay.activateChildren(1, ["child-0"]);
    expect(FakePeerConnection.activeCount).toBe(1);
    expect(relay.prepareChild(2, routeCandidate(2, "child-1"), ["child-0", "child-1"])).toBe(true);
    FakePeerConnection.latest!.connectionState = "connected";
    relay.activateChildren(2, ["child-0", "child-1"]);
    expect(relay.prepareChild(3, routeCandidate(3, "child-2"), ["child-0", "child-1", "child-2"])).toBe(
      true,
    );
    FakePeerConnection.latest!.connectionState = "connected";
    relay.activateChildren(3, ["child-0", "child-1", "child-2"]);
    expect(
      relay.prepareChild(4, routeCandidate(4, "child-3"), ["child-0", "child-1", "child-2", "child-3"]),
    ).toBe(false);
    expect(FakePeerConnection.activeCount).toBe(3);
    relay.dispose();
  });

  it("reconciles a reauthenticated endpoint cap without rebuilding retained children", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
      3,
    );
    relay.setStream(createStream(createTrack("video", "cap-update-video"), null));
    relay.setChildren(["child-0", "child-1", "child-2"]);
    await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(3));
    const retained = FakePeerConnection.instances.slice(0, 2);
    const removed = FakePeerConnection.instances[2]!;
    retained.forEach((connection) => {
      connection.connectionState = "connected";
    });

    relay.updateCapacity(2);

    expect(FakePeerConnection.instances.slice(0, 2)).toEqual(retained);
    expect(removed.connectionState).toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(2);
    relay.dispose();
  });

  it("exposes a defensive snapshot of current downstream send metrics", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setChildren(["metrics-child"]);
    relay.setStream(
      createStream(createTrack("video", "metrics-video"), null),
    );

    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("metrics-child"),
    );
    const connection = FakePeerConnection.latest!;
    connection.statsReports.push(
      sendStatsReport({
        bytesSent: 1_000_000,
        framesEncoded: 30,
        timestamp: 1_000,
        totalEncodeTime: 0.15,
        qualityLimitationReason: "cpu",
        trackIdentifier: "metrics-video",
      }),
      sendStatsReport({
        bytesSent: 1_500_000,
        framesEncoded: 60,
        timestamp: 2_000,
        totalEncodeTime: 0.75,
        qualityLimitationReason: "bandwidth",
        trackIdentifier: "metrics-video",
      }),
    );

    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.metrics.qualityLimitationReason).toBe("cpu"),
    );
    expect(relay.getSnapshot()?.metrics.intervalEncodeMs).toBeNull();
    statsCallbacks[0]!();
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.metrics.intervalEncodeMs).toBe(20),
    );

    const snapshot = relay.getSnapshot()!;
    expect(snapshot.metrics).toMatchObject({
      intervalEncodeMs: 20,
      bitrateKbps: 4_000,
      encoderImplementation: "test-encoder",
      qualityLimitationReason: "bandwidth",
    });
    snapshot.metrics.qualityLimitationReason = "mutated";
    expect(relay.getSnapshot()?.metrics.qualityLimitationReason).toBe(
      "bandwidth",
    );
  });

  it("clears snapshots across child replacement, stop, and dispose", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    const stream = createStream(createTrack("video", "relay-video"), null);
    relay.setChildren(["first-child"]);
    relay.setStream(stream);
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("first-child"),
    );

    relay.setChildren(["second-child"]);
    expect(relay.getSnapshot()).toBeNull();
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("second-child"),
    );

    relay.stop();
    expect(relay.getSnapshot()).toBeNull();
    relay.setStream(stream);
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("second-child"),
    );

    relay.dispose();
    expect(relay.getSnapshot()).toBeNull();
    relay.setStream(stream);
    expect(relay.getSnapshot()).toBeNull();
  });

  it("does not publish a stale stats result after replacing its child", async () => {
    let resolveOldStats!: (report: RTCStatsReport) => void;
    const pendingOldStats = new Promise<RTCStatsReport>((resolve) => {
      resolveOldStats = resolve;
    });
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setChildren(["old-child"]);
    relay.setStream(
      createStream(createTrack("video", "relay-video"), null),
    );
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("old-child"),
    );
    FakePeerConnection.latest!.statsReports.push(pendingOldStats);
    statsCallbacks[0]!();

    relay.setChildren(["current-child"]);
    await vi.waitFor(() =>
      expect(relay.getSnapshot()?.peerId).toBe("current-child"),
    );
    resolveOldStats(
      sendStatsReport({
        bytesSent: 999_999,
        framesEncoded: 30,
        timestamp: 1_000,
        qualityLimitationReason: "old-peer",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(relay.getSnapshot()).toMatchObject({
      peerId: "current-child",
      metrics: { qualityLimitationReason: null },
    });
  });

  it("creates a downstream peer without secure-context randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });
    const targets: string[] = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (peerId) => {
          targets.push(peerId);
          return true;
        },
      },
    );

    relay.setChildren(["lan-child-peer"]);
    relay.setStream(
      createStream(createTrack("video", "lan-video"), null),
    );

    await vi.waitFor(() => expect(targets).toEqual(["lan-child-peer"]));
    expect(FakePeerConnection.latest?.connectionState).toBe("new");
  });

  it("retries a missing peer when the same assignment is reconciled", async () => {
    vi.useFakeTimers();
    try {
      FakePeerConnection.offersFailing = 2;
      const targets: string[] = [];
      const relay = new ViewerRelay(
        { iceServers: [] },
        QUALITY_PROFILES["720p30"],
        {
          sendSignal: (peerId) => {
            targets.push(peerId);
            return true;
          },
        },
      );
      const stream = createStream(createTrack("video", "relay-video"), null);
      relay.setChildren(["same-child-peer"]);
      relay.setStream(stream);

      await vi.runAllTimersAsync();
      const failedPeer = FakePeerConnection.latest;
      expect(targets).toEqual([]);

      relay.setChildren(["same-child-peer"]);
      await vi.runAllTimersAsync();

      expect(FakePeerConnection.latest).not.toBe(failedPeer);
      expect(targets).toEqual(["same-child-peer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds a stalled peer but preserves a connected peer on reconciliation", async () => {
    const targets: string[] = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (peerId) => {
          targets.push(peerId);
          return true;
        },
      },
    );
    relay.setChildren(["reconciled-child"]);
    relay.setStream(
      createStream(createTrack("video", "reconciled-video"), null),
    );
    await vi.waitFor(() => expect(targets).toEqual(["reconciled-child"]));
    const stalledConnection = FakePeerConnection.latest!;

    relay.setChildren(["reconciled-child"]);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest).not.toBe(stalledConnection),
    );
    const connectedConnection = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(targets).toHaveLength(2));
    connectedConnection.connectionState = "connected";

    relay.setChildren(["reconciled-child"]);
    expect(FakePeerConnection.latest).toBe(connectedConnection);
    expect(targets).toHaveLength(2);
  });

  it("keeps one downstream connection across upstream stream replacement", async () => {
    const targets: string[] = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["1080p60"],
      {
        sendSignal: (peerId) => {
          targets.push(peerId);
          return true;
        },
      },
    );
    const firstStream = createStream(
      createTrack("video", "first-video"),
      createTrack("audio", "first-audio"),
    );

    relay.setChildren(["child-peer-one"]);
    relay.setStream(firstStream);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    const connection = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(targets).toEqual(["child-peer-one"]));

    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    relay.setStream(createStream(nextVideo, nextAudio));
    await vi.waitFor(() =>
      expect(connection.senders[0]?.track?.id).toBe(nextVideo.id),
    );
    expect(connection.senders[0]?.track).not.toBe(nextVideo);

    expect(FakePeerConnection.latest).toBe(connection);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(connection.transceiverInputs).toHaveLength(2);

    relay.setChildren(["child-peer-two"]);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBe(connection));
    expect(connection.connectionState).toBe("closed");
    await vi.waitFor(() => expect(targets.at(-1)).toBe("child-peer-two"));
  });

  it("applies the latest profile to the current and future child", async () => {
    const customSettings = {
      resolution: "1440p",
      maxFramerate: 45,
      maxBitrate: 10_500_000,
      degradationPreference: "balanced",
    } as const;
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["1080p60"],
      { sendSignal: () => true },
    );
    relay.setChildren(["first-profile-child"]);
    relay.setStream(createStream(createTrack("video", "profile-video"), null));
    await vi.waitFor(() =>
      expect(relay.getSnapshot("first-profile-child")).not.toBeNull(),
    );
    const firstConnectionId = relay.getSnapshot("first-profile-child")!.connectionId;
    const firstConnection = FakePeerConnection.latest!;
    await expect(
      relay.acceptSignal(
        "first-profile-child",
        {
          kind: "description",
          connectionId: firstConnectionId,
          description: { type: "answer", sdp: "first-answer" },
        },
        0,
      ),
    ).resolves.toBe(true);
    firstConnection.connectionState = "connected";
    firstConnection.dispatchEvent(new Event("connectionstatechange"));
    await completeVideoStartup(firstConnection);

    await expect(
      relay.updateProfile(customSettings),
    ).resolves.toBe(true);
    expect(
      firstConnection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 10_500_000, maxFramerate: 45 }],
    });

    relay.setChildren(["second-profile-child"]);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest).not.toBe(firstConnection),
    );
    const secondConnection = FakePeerConnection.latest!;
    await vi.waitFor(() =>
      expect(secondConnection.localDescription?.type).toBe("offer"),
    );
    await vi.waitFor(() =>
      expect(relay.getSnapshot("second-profile-child")).not.toBeNull(),
    );
    const secondConnectionId = relay.getSnapshot("second-profile-child")!.connectionId;
    await expect(
      relay.acceptSignal(
        "second-profile-child",
        {
          kind: "description",
          connectionId: secondConnectionId,
          description: { type: "answer", sdp: "second-answer" },
        },
        0,
      ),
    ).resolves.toBe(true);
    secondConnection.connectionState = "connected";
    secondConnection.dispatchEvent(new Event("connectionstatechange"));
    await completeVideoStartup(secondConnection);
    expect(
      secondConnection.senders[0]?.setParameters.mock.calls[0]?.[0],
    ).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 10_500_000, maxFramerate: 45 }],
    });
  });

  it("applies the latest audio ceiling to current and future children", async () => {
    const initialProfile = {
      ...QUALITY_PROFILES["1080p60"],
      screenAudioQuality: "saver",
    } as const;
    const relay = new ViewerRelay(
      { iceServers: [] },
      initialProfile,
      { sendSignal: () => true },
    );
    relay.setChildren(["first-audio-child"]);
    relay.setStream(
      createStream(
        createTrack("video", "relay-video"),
        createTrack("audio", "relay-audio"),
      ),
    );
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest?.senders[1]?.appliedMaxBitrates).toEqual([
        64_000,
      ]),
    );
    const firstConnection = FakePeerConnection.latest!;

    await expect(
      relay.updateProfile({
        ...initialProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    expect(firstConnection.senders[1]?.appliedMaxBitrates).toEqual([
      64_000,
      192_000,
    ]);

    relay.setChildren(["second-audio-child"]);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest).not.toBe(firstConnection),
    );
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest?.senders[1]?.appliedMaxBitrates).toEqual([
        192_000,
      ]),
    );
  });
});
