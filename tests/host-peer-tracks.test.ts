import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUALITY_PROFILES,
  type QualityProfile,
} from "../src/client/media/quality.ts";
import { HostProvisionalChild } from "../src/client/media/host-provisional-child.ts";
import type { PeerSnapshot } from "../src/client/types.ts";
import { HostPeer } from "../src/client/webrtc/host-peer.ts";
import { ViewerRelay } from "../src/client/webrtc/viewer-relay.ts";
import type {
  IceConfig,
  ParticipantRouteAssignment,
} from "../src/shared/protocol.ts";

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

  readonly configurations: RTCConfiguration[] = [];
  readonly senders: FakeSender[] = [];
  readonly transceiverInputs: Array<{
    trackOrKind: MediaStreamTrack | string;
    init?: RTCRtpTransceiverInit;
  }> = [];
  readonly codecPreferenceCalls: RTCRtpCodec[][] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly addedIceCandidates: Array<RTCIceCandidateInit | null> = [];
  readonly statsReports: Array<RTCStatsReport | Promise<RTCStatsReport>> = [];

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
      setCodecPreferences: (codecs: RTCRtpCodec[]) => {
        this.codecPreferenceCalls.push([...codecs]);
      },
    } as unknown as RTCRtpTransceiver;
  }

  addEventListener(): void {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (FakePeerConnection.offersFailing > 0) {
      FakePeerConnection.offersFailing -= 1;
      throw new Error("createOffer failed");
    }
    return { type: "offer", sdp: "test-offer" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
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

function createTrack(kind: "video" | "audio", id: string): MediaStreamTrack {
  return { id, kind } as MediaStreamTrack;
}

function createConfiguredVideoTrack(
  id: string,
  width: number,
  height: number,
  frameRate: number,
): MediaStreamTrack {
  return {
    id,
    kind: "video",
    getSettings: () => ({ width, height, frameRate }),
  } as unknown as MediaStreamTrack;
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

const selectedTurnIceServer = {
  urls: ["turn:turn.example.test:3478?transport=udp"],
  username: "1787230000:opaque_identity_12345678",
  credential: "short-lived-credential",
};

function selectedEdgeTurn(
  viewerPeerId: string,
  oldConnectionId: string,
  newConnectionId: string,
) {
  return {
    type: "selected-edge-turn" as const,
    edgeKind: "peer-selected" as const,
    revision: 7,
    parentPeerId: "selected-parent",
    viewerPeerId,
    oldConnectionId,
    newConnectionId,
    expiresAt: "2099-08-20T12:00:00.000Z",
    iceServer: selectedTurnIceServer,
  };
}

function createPeer(
  stream: MediaStream,
  onUpdate: (snapshot: PeerSnapshot) => void = () => undefined,
  iceConfig: IceConfig = { iceServers: [] },
  profile: QualityProfile = QUALITY_PROFILES["720p30"],
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
  );
}

beforeEach(() => {
  FakePeerConnection.latest = null;
  FakePeerConnection.instances = [];
  FakePeerConnection.activeCount = 0;
  FakePeerConnection.peakActiveCount = 0;
  FakePeerConnection.offersFailing = 0;
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
  it("leaves browser codec ordering unchanged", async () => {
    const peer = createPeer(createStream(createTrack("video", "video"), null));

    await expect(peer.start()).resolves.toBe(true);

    expect(FakePeerConnection.latest!.codecPreferenceCalls).toEqual([]);
  });

  it.each(["h264", "vp8"] as const)(
    "prefers %s before the first offer while retaining fallback codecs",
    async (videoCodec) => {
      vi.stubGlobal("RTCRtpSender", {
        getCapabilities: () => ({
          codecs: [
            { mimeType: "video/VP8", clockRate: 90_000 },
            { mimeType: "video/rtx", clockRate: 90_000 },
            {
              mimeType: "video/H264",
              clockRate: 90_000,
              sdpFmtpLine: "packetization-mode=1;profile-level-id=42001f",
            },
            { mimeType: "video/rtx", clockRate: 90_000 },
          ],
          headerExtensions: [],
        }),
      });
      const peer = createPeer(
        createStream(createTrack("video", "video"), null),
        () => undefined,
        { iceServers: [] },
        { ...QUALITY_PROFILES["720p30"], videoCodec },
      );

      await expect(peer.start()).resolves.toBe(true);

      const preferences = FakePeerConnection.latest!.codecPreferenceCalls[0]!;
      expect(preferences[0]?.mimeType.toLowerCase()).toBe(`video/${videoCodec}`);
      expect(preferences.map(({ mimeType }) => mimeType.toLowerCase())).toEqual(
        expect.arrayContaining(["video/h264", "video/vp8", "video/rtx"]),
      );
    },
  );

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
    const connection = FakePeerConnection.latest!;
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

    expect(connection.senders[0]?.track).toBe(nextVideo);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(connection.transceiverInputs).toHaveLength(2);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(2);
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([
      256_000,
      256_000,
    ]);
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
    const connection = FakePeerConnection.latest!;
    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);

    expect(connection.senders[0]?.replaceTrack).not.toHaveBeenCalled();
    expect(connection.senders[1]?.replaceTrack).not.toHaveBeenCalled();
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(2);
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
    ).resolves.toBe(false);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(2);
    expect(connection.senders[1]?.setParameters).toHaveBeenCalledOnce();
  });

  it("accepts an answer without reapplying the selected profile", async () => {
    const video = createTrack("video", "video");
    const peer = createPeer(createStream(video, createTrack("audio", "audio")));

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
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
    expect(connection.senders[0]?.track).toBe(video);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledOnce();
    expect(connection.senders[1]?.setParameters).toHaveBeenCalledOnce();
  });

  it("serializes initial sender configuration with a live profile update", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    const starting = peer.start();
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    videoSender.deferNextSetParameters = true;
    await vi.waitFor(() =>
      expect(videoSender.setParameters).toHaveBeenCalledTimes(1),
    );

    const updating = peer.updateProfile(QUALITY_PROFILES["1080p60"]);
    await Promise.resolve();
    expect(videoSender.setParameters).toHaveBeenCalledTimes(1);

    videoSender.releaseDeferredSetParameters();
    await expect(starting).resolves.toBe(true);
    await expect(updating).resolves.toBe(true);
    expect(videoSender.appliedMaxBitrates).toEqual([3_000_000, 8_000_000]);
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
    const updating = peer.updateProfile(QUALITY_PROFILES["1080p60"]);

    await expect(starting).resolves.toBe(true);
    expect(
      updates.some((snapshot) =>
        snapshot.qualityWarning?.startsWith("应用发送参数失败"),
      ),
    ).toBe(true);
    await expect(updating).resolves.toBe(true);
    expect(videoSender.setParameters).toHaveBeenCalledTimes(2);
    expect(videoSender.appliedMaxBitrates).toEqual([8_000_000]);
  });

  it("can retry the selected quality after a sender update fails", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    await expect(peer.start()).resolves.toBe(true);
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    videoSender.failNextSetParameters = true;

    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(false);
    await expect(
      peer.updateProfile(QUALITY_PROFILES["1080p60"]),
    ).resolves.toBe(true);

    expect(videoSender.setParameters).toHaveBeenCalledTimes(3);
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
    const connection = FakePeerConnection.latest!;
    connection.statsReports.push(oldStats);
    statsCallbacks[0]!();
    await vi.waitFor(() => expect(connection.statsReports).toHaveLength(0));
    statsCallbacks[0]!();
    expect(connection.getStats).toHaveBeenCalledOnce();

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
    const videoTrack = {
      id: "capture-video",
      kind: "video",
      getSettings,
    } as unknown as MediaStreamTrack;
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
    expect(videoSender.track).toBe(committedVideo);
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
    expect(updates.at(-1)?.qualityWarning).toContain("持续受带宽限制");
    expect(sender.setParameters).toHaveBeenCalledOnce();

    await sample();
    expect(updates.at(-1)?.qualityWarning).toBeNull();
    expect(sender.setParameters).toHaveBeenCalledOnce();
  });

  it("rolls the first sender back when the second replacement fails", async () => {
    const oldVideo = createTrack("video", "old-video");
    const oldAudio = createTrack("audio", "old-audio");
    const peer = createPeer(createStream(oldVideo, oldAudio));
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const videoSender = connection.senders[0]!;
    const audioSender = connection.senders[1]!;
    audioSender.failNextReplace = true;

    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(createStream(nextVideo, nextAudio)),
    ).resolves.toBe(false);

    expect(videoSender.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo);
    expect(videoSender.replaceTrack).toHaveBeenNthCalledWith(2, oldVideo);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(1, nextAudio);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(2, oldAudio);
    expect(videoSender.track).toBe(oldVideo);
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
    selectedPeerIds?: readonly string[];
  } = {},
) {
  return {
    revision,
    assignment: hostAssignment(
      childPeerIds,
      overrides.publicationGeneration ?? null,
    ),
    activeChildPeerIds: overrides.activeChildPeerIds ?? [],
    selectedPeerIds: overrides.selectedPeerIds ?? [],
    maxMediaEdges: 2,
    iceConfig: { iceServers: [] },
    stream,
    profile: QUALITY_PROFILES["720p30"],
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
      selectedPeerIds: [],
      maxMediaEdges: 2,
    })).toEqual({ kind: "ordinary" });
    expect(second.connectionState).toBe("closed");

    expect(owner.prepare(hostProvisionalInput(10, ["auth-probe"], stream))).toBe(true);
    const authProbe = FakePeerConnection.latest!;
    owner.discard();
    expect(authProbe.connectionState).toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(0);
  });

  it("retains failed connection identity until authoritative activation", async () => {
    const signals: Array<{ connectionId: string }> = [];
    const owner = new HostProvisionalChild({
      sendSignal: (_peerId, payload) => {
        signals.push({ connectionId: payload.connectionId });
        return false;
      },
    });
    const stream = createStream(createTrack("video", "host-failed-video"), null);
    const input = hostProvisionalInput(11, ["failed-probe"], stream);

    expect(owner.prepare(input)).toBe(true);
    await vi.waitFor(() => expect(FakePeerConnection.activeCount).toBe(0));
    expect(signals).toHaveLength(1);
    const instanceCount = FakePeerConnection.instances.length;
    expect(owner.prepare(input)).toBe(false);
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);

    expect(owner.activate(input)).toEqual({
      kind: "failed",
      peerId: "failed-probe",
      connectionId: signals[0]!.connectionId,
    });
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
  });

  it("replaces the prepared stream in place and tombstones a failed replacement", async () => {
    const signals: Array<{ connectionId: string }> = [];
    const owner = new HostProvisionalChild({
      sendSignal: (_peerId, payload) => {
        signals.push({ connectionId: payload.connectionId });
        return true;
      },
    });
    const initial = createStream(createTrack("video", "host-initial-video"), null);
    const input = hostProvisionalInput(12, ["stream-probe"], initial);
    expect(owner.prepare(input)).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    const instanceCount = FakePeerConnection.instances.length;

    const replacementVideo = createTrack("video", "host-replacement-video");
    await expect(
      owner.replaceStream(createStream(replacementVideo, null)),
    ).resolves.toBe(true);
    expect(preparedConnection.senders[0]!.track).toBe(replacementVideo);
    const activation = owner.activate(input);
    expect(activation.kind).toBe("promote");
    if (activation.kind !== "promote") {
      throw new Error("expected stream-updated Host probe to promote");
    }
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    expect(FakePeerConnection.latest).toBe(preparedConnection);
    expect(activation.peer.connectionId).toBe(preparedConnectionId);
    activation.peer.dispose();

    const failedSignals: Array<{ connectionId: string }> = [];
    const failedOwner = new HostProvisionalChild({
      sendSignal: (_peerId, payload) => {
        failedSignals.push({ connectionId: payload.connectionId });
        return true;
      },
    });
    const failedInput = hostProvisionalInput(
      13,
      ["failed-stream-probe"],
      initial,
    );
    expect(failedOwner.prepare(failedInput)).toBe(true);
    await vi.waitFor(() => expect(failedSignals).toHaveLength(1));
    const failedConnection = FakePeerConnection.latest!;
    const failedConnectionId = failedSignals[0]!.connectionId;
    const failedInstanceCount = FakePeerConnection.instances.length;
    failedConnection.senders[0]!.failNextReplace = true;
    await expect(
      failedOwner.replaceStream(
        createStream(createTrack("video", "host-failed-replacement"), null),
      ),
    ).resolves.toBe(false);
    expect(failedConnection.connectionState).toBe("closed");
    const failedActivation = failedOwner.activate(failedInput);
    expect(failedActivation).toMatchObject({
      kind: "failed",
      peerId: "failed-stream-probe",
      connectionId: failedConnectionId,
    });
    expect(FakePeerConnection.instances).toHaveLength(failedInstanceCount);

    const promotedFailure = vi.fn();
    const racingSignals: string[] = [];
    const racingOwner = new HostProvisionalChild({
      sendSignal: (_peerId, payload) => {
        racingSignals.push(payload.connectionId);
        return true;
      },
      onPromotedStreamFailure: promotedFailure,
    });
    const racingInput = hostProvisionalInput(
      14,
      ["racing-stream-probe"],
      initial,
    );
    expect(racingOwner.prepare(racingInput)).toBe(true);
    await vi.waitFor(() => expect(racingSignals).toHaveLength(1));
    const racingConnection = FakePeerConnection.latest!;
    racingConnection.senders[0]!.failNextReplace = true;
    const racingReplacement = racingOwner.replaceStream(
      createStream(createTrack("video", "host-racing-replacement"), null),
    );
    const racingActivation = racingOwner.activate(racingInput);
    expect(racingActivation.kind).toBe("promote");
    if (racingActivation.kind !== "promote") {
      throw new Error("expected racing Host probe to promote");
    }
    await expect(racingReplacement).resolves.toBe(false);
    expect(promotedFailure).toHaveBeenCalledWith(racingActivation.peer);
    racingActivation.peer.dispose();
  });
});

describe("ViewerRelay downstream ownership", () => {
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
    expect(relay.prepareChild(7, ["prepared-child"])).toBe(true);
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
    expect(relay.prepareChild(7, ["first-probe"])).toBe(true);
    const firstProbe = FakePeerConnection.latest!;
    expect(relay.prepareChild(8, ["second-probe"])).toBe(true);
    const secondProbe = FakePeerConnection.latest!;
    expect(firstProbe.connectionState).toBe("closed");
    relay.activateChildren(9, []);
    expect(secondProbe.connectionState).toBe("closed");

    FakePeerConnection.offersFailing = 1;
    const instancesBeforeFailure = FakePeerConnection.instances.length;
    expect(relay.prepareChild(10, ["failed-probe"])).toBe(true);
    const failedProbe = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(failedProbe.connectionState).toBe("closed"));
    expect(FakePeerConnection.instances).toHaveLength(instancesBeforeFailure + 1);

    expect(relay.prepareChild(11, ["session-probe"])).toBe(true);
    const sessionProbe = FakePeerConnection.latest!;
    relay.discardPreparedChild();
    expect(sessionProbe.connectionState).toBe("closed");

    expect(relay.prepareChild(12, ["stopped-probe"])).toBe(true);
    const stoppedProbe = FakePeerConnection.latest!;
    relay.stop();
    expect(stoppedProbe.connectionState).toBe("closed");
    relay.dispose();
  });

  it("fails closed when the committed prepared connection already failed", async () => {
    const signals: Array<{ peerId: string; connectionId: string }> = [];
    let rejectSignalsFor: string | null = null;
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (peerId, payload) => {
          signals.push({ peerId, connectionId: payload.connectionId });
          return peerId !== rejectSignalsFor;
        },
      },
    );
    relay.setStream(createStream(createTrack("video", "failed-active-video"), null));

    rejectSignalsFor = "failed-child";
    expect(relay.prepareChild(7, ["failed-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const failedConnectionId = signals[0]!.connectionId;
    const failedConnection = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(failedConnection.connectionState).toBe("closed"));
    const instanceCount = FakePeerConnection.instances.length;
    expect(relay.prepareChild(7, ["failed-child"])).toBe(false);
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);

    relay.setChildren(["failed-child"]);
    relay.activateChildren(7, ["failed-child"]);
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    expect(FakePeerConnection.activeCount).toBe(0);
    relay.setChildren(["failed-child"]);
    relay.activateChildren(7, ["failed-child"]);
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.connectionId).toBe(failedConnectionId);
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
    expect(relay.prepareChild(7, ["prepared-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    const instanceCount = FakePeerConnection.instances.length;

    const replacementVideo = createTrack("video", "replacement-video");
    relay.setStream(createStream(replacementVideo, null));
    await vi.waitFor(() =>
      expect(preparedConnection.senders[0]!.track).toBe(replacementVideo),
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

  it("retains failed replacement identity across repeated active updates", async () => {
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
    expect(relay.prepareChild(7, ["prepared-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const preparedConnection = FakePeerConnection.latest!;
    const preparedConnectionId = signals[0]!.connectionId;
    preparedConnection.senders[0]!.failNextReplace = true;
    const instanceCount = FakePeerConnection.instances.length;

    relay.setStream(createStream(createTrack("video", "failed-video"), null));
    await vi.waitFor(() => expect(preparedConnection.connectionState).toBe("closed"));
    relay.activateChildren(7, ["prepared-child"]);
    relay.activateChildren(7, ["prepared-child"]);
    expect(FakePeerConnection.instances).toHaveLength(instanceCount);
    expect(FakePeerConnection.activeCount).toBe(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.connectionId).toBe(preparedConnectionId);
    relay.dispose();
  });

  it("admits provisional children until endpoint cap three is full", async () => {
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
    );
    relay.setStream(createStream(createTrack("video", "cap-video"), null));
    expect(relay.prepareChild(1, ["child-0"])).toBe(true);
    const preparedConnection = FakePeerConnection.latest!;
    preparedConnection.connectionState = "connected";
    relay.activateChildren(1, ["child-0"]);
    expect(FakePeerConnection.activeCount).toBe(1);
    expect(relay.prepareChild(2, ["child-0", "child-1"])).toBe(true);
    FakePeerConnection.latest!.connectionState = "connected";
    relay.activateChildren(2, ["child-0", "child-1"]);
    expect(relay.prepareChild(3, ["child-0", "child-1", "child-2"])).toBe(
      true,
    );
    FakePeerConnection.latest!.connectionState = "connected";
    relay.activateChildren(3, ["child-0", "child-1", "child-2"]);
    expect(
      relay.prepareChild(4, ["child-0", "child-1", "child-2", "child-3"]),
    ).toBe(false);
    expect(FakePeerConnection.activeCount).toBe(3);
    relay.dispose();
  });

  it("clamps a malicious fourth child to three physical endpoint copies", async () => {
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
    const firstVideo = createTrack("video", "first-video");
    const firstAudio = createTrack("audio", "first-audio");
    relay.setChildren(["child-a", "child-b", "child-c", "ignored-fourth"]);
    relay.setStream(createStream(firstVideo, firstAudio));

    await vi.waitFor(() =>
      expect(targets).toEqual(["child-a", "child-b", "child-c"]),
    );
    const [childAConnection, childBConnection, childCConnection] =
      FakePeerConnection.instances;
    expect(childAConnection).toBeDefined();
    expect(childBConnection).toBeDefined();
    expect(childCConnection).toBeDefined();
    childAConnection!.connectionState = "connected";
    childBConnection!.connectionState = "connected";
    childCConnection!.connectionState = "connected";
    const retiredConnectionId = relay.getSnapshot("child-a")!.connectionId;

    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    relay.setStream(createStream(nextVideo, nextAudio));
    await vi.waitFor(() => {
      expect(childAConnection!.senders[0]?.track).toBe(nextVideo);
      expect(childAConnection!.senders[1]?.track).toBe(nextAudio);
    });

    relay.setChildren(["child-b", "child-c", "child-d"]);
    await vi.waitFor(() => expect(targets).toContain("child-d"));
    expect(childAConnection!.connectionState).toBe("closed");
    FakePeerConnection.latest!.connectionState = "connected";
    expect(targets).toEqual(["child-a", "child-b", "child-c", "child-d"]);
    expect(FakePeerConnection.activeCount).toBe(3);
    expect(FakePeerConnection.peakActiveCount).toBe(3);
    expect(targets).not.toContain("ignored-fourth");

    await relay.acceptSignal("stale-child", {
      kind: "description",
      connectionId: "stale-connection",
      description: { type: "answer", sdp: "stale-answer" },
    }, 7);
    await relay.recover("stale-child", "stale-connection", true);
    await relay.recover("child-b", "wrong-connection", true);
    expect(FakePeerConnection.activeCount).toBe(3);
    const childBConnectionId = relay.getSnapshot("child-b")!.connectionId;
    await relay.recover("child-b", childBConnectionId, true);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest).not.toBe(childBConnection),
    );
    expect(FakePeerConnection.activeCount).toBe(3);
    expect(FakePeerConnection.peakActiveCount).toBe(3);

    expect(
      relay.startSelectedEdgeTurn(
        selectedEdgeTurn(
          "child-a",
          retiredConnectionId,
          "selected-connection-overflow",
        ),
        "selected-parent",
        7,
      ),
    ).toBe(false);
    expect(FakePeerConnection.activeCount).toBe(3);
    expect(FakePeerConnection.peakActiveCount).toBe(3);
    relay.dispose();
  });

  it("rebuilds a retired child as one relay-only selected edge", async () => {
    const sendSignal = vi.fn(() => true);
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal },
    );
    relay.setChildren(["selected-child"]);
    relay.setStream(createStream(createTrack("video", "selected-video"), null));
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledOnce());
    const oldConnectionId = relay.getSnapshot()!.connectionId;
    FakePeerConnection.latest!.connectionState = "connected";
    relay.setChildren([]);
    sendSignal.mockClear();
    const selectedGrant = selectedEdgeTurn(
      "selected-child",
      oldConnectionId,
      "selected-connection-new",
    );
    expect(
      relay.startSelectedEdgeTurn(selectedGrant, "wrong-parent", 7),
    ).toBe(false);
    expect(
      relay.startSelectedEdgeTurn(selectedGrant, "selected-parent", 6),
    ).toBe(false);
    expect(
      relay.startSelectedEdgeTurn(
        selectedGrant,
        "selected-parent",
        7,
        Date.parse(selectedGrant.expiresAt),
      ),
    ).toBe(false);
    expect(
      relay.startSelectedEdgeTurn(
        selectedGrant,
        "selected-parent",
        7,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledOnce());
    expect(sendSignal).toHaveBeenCalledWith(
      "selected-child",
      expect.objectContaining({
        kind: "description",
        connectionId: "selected-connection-new",
        description: expect.objectContaining({ type: "offer" }),
      }),
    );
    expect(FakePeerConnection.latest?.configurations).toEqual([{
      iceServers: [selectedTurnIceServer],
      iceTransportPolicy: "relay",
    }]);
    const selectedConnection = FakePeerConnection.latest!;
    expect(
      relay.startSelectedEdgeTurn(
        { ...selectedGrant, revision: 8 },
        "selected-parent",
        7,
      ),
    ).toBe(true);
    expect(FakePeerConnection.latest).toBe(selectedConnection);
    expect(sendSignal).toHaveBeenCalledOnce();
    relay.acceptActiveRevision(8);
    relay.setChildren([]);
    expect(selectedConnection.connectionState).not.toBe("closed");
    expect(relay.getSnapshot("selected-child")?.connectionId).toBe(
      "selected-connection-new",
    );
    expect(FakePeerConnection.activeCount).toBe(1);
    expect(FakePeerConnection.peakActiveCount).toBe(1);
    const pendingCandidate = { candidate: "candidate-before-answer" };
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "candidate",
        connectionId: "selected-connection-new",
        candidate: pendingCandidate,
      }, 8),
    ).resolves.toBe(true);
    expect(selectedConnection.addedIceCandidates).toEqual([]);
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "description",
        connectionId: "selected-connection-new",
        description: { type: "answer", sdp: "selected-answer" },
      }, 8),
    ).resolves.toBe(true);
    expect(selectedConnection.remoteDescription?.type).toBe("answer");
    expect(selectedConnection.addedIceCandidates).toEqual([pendingCandidate]);
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "candidate",
        connectionId: "selected-connection-new",
        candidate: null,
      }, 8),
    ).resolves.toBe(true);
    expect(selectedConnection.addedIceCandidates).toEqual([
      pendingCandidate,
      null,
    ]);
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "candidate",
        connectionId: "selected-connection-new",
        candidate: null,
      }, 7),
    ).resolves.toBe(false);
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "candidate",
        connectionId: oldConnectionId,
        candidate: null,
      }, 8),
    ).resolves.toBe(false);
    expect(
      relay.startSelectedEdgeTurn(
        {
          ...selectedEdgeTurn(
            "selected-child",
            "selected-connection-new",
            "selected-connection-replacement",
          ),
          revision: 9,
        },
        "selected-parent",
        9,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledTimes(2));
    expect(selectedConnection.connectionState).toBe("closed");
    const replacementConnection = FakePeerConnection.latest!;
    expect(replacementConnection.connectionState).not.toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(1);
    expect(FakePeerConnection.peakActiveCount).toBe(1);
    relay.acceptActiveRevision(9);
    expect(replacementConnection.connectionState).toBe("closed");
    await expect(
      relay.acceptSignal("selected-child", {
        kind: "candidate",
        connectionId: "selected-connection-replacement",
        candidate: null,
      }, 9),
    ).resolves.toBe(false);
    expect(FakePeerConnection.activeCount).toBe(0);
    expect(FakePeerConnection.peakActiveCount).toBe(1);
    relay.dispose();
  });

  it("keeps concurrent selected children isolated across carry and failure", async () => {
    const sendSignal = vi.fn(() => true);
    const onSelectedEdgeFailed = vi.fn();
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal, onSelectedEdgeFailed },
    );
    relay.setChildren(["selected-a", "selected-b"]);
    relay.setStream(createStream(createTrack("video", "selected-video"), null));
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledTimes(2));
    const oldConnectionA = relay.getSnapshot("selected-a")!.connectionId;
    const oldConnectionB = relay.getSnapshot("selected-b")!.connectionId;
    relay.setChildren([]);
    expect(FakePeerConnection.activeCount).toBe(0);

    sendSignal.mockClear();
    const grantA = selectedEdgeTurn(
      "selected-a",
      oldConnectionA,
      "selected-connection-a",
    );
    const grantB = selectedEdgeTurn(
      "selected-b",
      oldConnectionB,
      "selected-connection-b",
    );
    expect(relay.startSelectedEdgeTurn(grantA, "selected-parent", 7)).toBe(true);
    expect(relay.startSelectedEdgeTurn(grantB, "selected-parent", 7)).toBe(true);
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledTimes(2));
    const [selectedConnectionA, selectedConnectionB] =
      FakePeerConnection.instances.slice(-2);
    expect(selectedConnectionA).toBeDefined();
    expect(selectedConnectionB).toBeDefined();
    expect(FakePeerConnection.activeCount).toBe(2);

    expect(
      relay.startSelectedEdgeTurn(
        { ...grantA, revision: 8 },
        "selected-parent",
        7,
      ),
    ).toBe(true);
    expect(
      relay.startSelectedEdgeTurn(
        { ...grantB, revision: 8 },
        "selected-parent",
        7,
      ),
    ).toBe(true);
    relay.acceptActiveRevision(8);
    relay.setChildren([]);
    expect(selectedConnectionA!.connectionState).not.toBe("closed");
    expect(selectedConnectionB!.connectionState).not.toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(2);

    await expect(
      relay.acceptSignal(
        "selected-a",
        {
          kind: "description",
          connectionId: "selected-connection-a",
          description: { type: "answer", sdp: "selected-answer-a" },
        },
        8,
      ),
    ).resolves.toBe(true);
    await expect(
      relay.acceptSignal(
        "selected-b",
        {
          kind: "description",
          connectionId: "selected-connection-b",
          description: { type: "answer", sdp: "selected-answer-b" },
        },
        8,
      ),
    ).resolves.toBe(true);
    expect(selectedConnectionA!.remoteDescription?.sdp).toBe(
      "selected-answer-a",
    );
    expect(selectedConnectionB!.remoteDescription?.sdp).toBe(
      "selected-answer-b",
    );

    FakePeerConnection.offersFailing = 1;
    expect(
      relay.startSelectedEdgeTurn(
        {
          ...selectedEdgeTurn(
            "selected-a",
            "selected-connection-a",
            "selected-connection-a-failed",
          ),
          revision: 8,
        },
        "selected-parent",
        8,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(onSelectedEdgeFailed).toHaveBeenCalledWith(
        "selected-a",
        "selected-connection-a-failed",
        8,
      ),
    );
    expect(selectedConnectionA!.connectionState).toBe("closed");
    expect(selectedConnectionB!.connectionState).not.toBe("closed");
    expect(relay.getSnapshot("selected-a")).toBeNull();
    expect(relay.getSnapshot("selected-b")?.connectionId).toBe(
      "selected-connection-b",
    );
    expect(FakePeerConnection.activeCount).toBe(1);
    await expect(
      relay.acceptSignal(
        "selected-a",
        {
          kind: "candidate",
          connectionId: "selected-connection-a-failed",
          candidate: null,
        },
        8,
      ),
    ).resolves.toBe(false);
    await expect(
      relay.acceptSignal(
        "selected-b",
        {
          kind: "candidate",
          connectionId: "selected-connection-b",
          candidate: null,
        },
        8,
      ),
    ).resolves.toBe(true);

    expect(
      relay.startSelectedEdgeTurn(
        { ...grantB, revision: 9 },
        "selected-parent",
        8,
      ),
    ).toBe(true);
    relay.acceptActiveRevision(9);
    expect(selectedConnectionB!.connectionState).not.toBe("closed");
    relay.clearSelectedEdgeTurn();
    expect(selectedConnectionB!.connectionState).toBe("closed");
    expect(FakePeerConnection.activeCount).toBe(0);
    relay.dispose();
  });

  it("reports a selected child whose relay-only offer fails", async () => {
    const onSelectedEdgeFailed = vi.fn();
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true, onSelectedEdgeFailed },
    );
    relay.setChildren(["selected-child"]);
    relay.setStream(createStream(createTrack("video", "selected-video"), null));
    await vi.waitFor(() => expect(relay.getSnapshot()).not.toBeNull());
    const oldConnectionId = relay.getSnapshot()!.connectionId;
    relay.setChildren([]);
    FakePeerConnection.offersFailing = 1;

    expect(
      relay.startSelectedEdgeTurn(
        selectedEdgeTurn(
          "selected-child",
          oldConnectionId,
          "selected-failed-connection",
        ),
        "selected-parent",
        7,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(onSelectedEdgeFailed).toHaveBeenCalledWith(
        "selected-child",
        "selected-failed-connection",
        7,
      ),
    );
    expect(relay.getSnapshot("selected-child")).toBeNull();
    expect(FakePeerConnection.latest?.connectionState).toBe("closed");
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
    await vi.waitFor(() => expect(connection.senders[0]?.track).toBe(nextVideo));

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
      expect(
        FakePeerConnection.latest?.senders[0]?.setParameters,
      ).toHaveBeenCalled(),
    );
    const firstConnection = FakePeerConnection.latest!;

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
      expect(secondConnection.senders[0]?.setParameters).toHaveBeenCalled(),
    );
    expect(
      secondConnection.senders[0]?.setParameters.mock.calls[0]?.[0],
    ).toMatchObject({
      degradationPreference: "balanced",
      encodings: [{ maxBitrate: 10_500_000, maxFramerate: 45 }],
    });
  });

  it("retains the locked audio preset for current and future children", async () => {
    const lockedProfile = {
      ...QUALITY_PROFILES["1080p60"],
      screenAudioQuality: "saver",
    } as const;
    const relay = new ViewerRelay(
      { iceServers: [] },
      lockedProfile,
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
        ...lockedProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(false);
    expect(firstConnection.senders[1]?.appliedMaxBitrates).toEqual([64_000]);

    relay.setChildren(["second-audio-child"]);
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest).not.toBe(firstConnection),
    );
    await vi.waitFor(() =>
      expect(FakePeerConnection.latest?.senders[1]?.appliedMaxBitrates).toEqual([
        64_000,
      ]),
    );
  });
});
