import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUALITY_PROFILES,
  type QualityProfile,
} from "../src/client/media/quality.ts";
import { HostProvisionalChild } from "../src/client/media/host-provisional-child.ts";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types.ts";
import { HostPeer, type HostMediaPeer } from "../src/client/webrtc/host-peer.ts";
import {
  automaticVideoCodecPreference,
  manualVideoCodecPreference,
  type BrowserVideoCodecPreference,
  VP8_ONLY_VIDEO_CODEC,
} from "../src/client/webrtc/video-codec.ts";
import {
  ViewerRelay,
  type ViewerRelayPeerEvents,
  type ViewerRelayPeerFactory,
} from "../src/client/webrtc/viewer-relay.ts";
import { setCopy } from "../src/client/ui/copy.ts";
import type {
  IceConfig,
  ParticipantRouteAssignment,
  SignalPayload,
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
  readonly transceivers: RTCRtpTransceiver[] = [];
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
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly addedIceCandidates: Array<RTCIceCandidateInit | null> = [];
  readonly statsReports: Array<RTCStatsReport | Promise<RTCStatsReport>> = [];
  private readonly eventListeners = new Map<
    string,
    Array<(event: Event) => void>
  >();

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
    const transceiver = {
      sender,
      direction: init?.direction ?? "sendrecv",
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
    this.transceivers.push(transceiver);
    return transceiver;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.eventListeners.get(type) ?? [];
    listeners.push(listener);
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.eventListeners.get(event.type) ?? []) {
      listener(event);
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
  natPredictionEnabled = false,
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
    undefined,
    natPredictionEnabled,
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
  setCopy({ lang: "zh", vis: false });
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
  vi.restoreAllMocks();
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

    // The snapshot carries a copy key, so raw WebRTC text cannot leak.
    expect(updates.at(-1)?.error).toEqual({ key: "host.err.createConnection" });
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
    expect(updates.at(-1)?.error).toEqual({ key: "host.err.codecUnsupported" });
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
    expect(updates.at(-1)?.error).toEqual({ key: "host.err.codecUnsupported" });
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
    expect(updates.at(-1)?.error).toEqual({ key: "host.err.codecUnsupported" });
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

  it("keeps ordinary candidates while opting into bounded NAT predictions", () => {
    const signals: SignalPayload[] = [];
    const peer = new HostPeer(
      "viewer-peer",
      {
        iceServers: [{ urls: "stun:share.example.test:3478" }],
        natPredictionStunUrls: [
          "stun:share.example.test:3479",
          "stun:share.example.test:3480",
        ],
      },
      createStream(createTrack("video", "video"), null),
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (_peerId, payload) => {
          signals.push(payload);
          return true;
        },
        onUpdate: () => undefined,
      },
      VP8_ONLY_VIDEO_CODEC,
      undefined,
      true,
    );
    const connection = FakePeerConnection.latest!;
    expect(connection.configurations[0]?.iceServers).toEqual([
      { urls: "stun:share.example.test:3478" },
      { urls: "stun:share.example.test:3479" },
      { urls: "stun:share.example.test:3480" },
    ]);

    const surveyUrls = [
      "stun:share.example.test:3478",
      "stun:share.example.test:3479",
      "stun:share.example.test:3480",
    ];
    const emitCandidate = (port: number | null, url?: string): void => {
      const event = new Event("icecandidate");
      Object.defineProperty(event, "candidate", {
        value:
          port === null
            ? null
            : {
                candidate:
                  `candidate:base 1 udp 2122260223 203.0.113.7 ${port} ` +
                  "typ srflx raddr 192.0.2.7 rport 50000 generation 0 ufrag test",
                sdpMid: "0",
                sdpMLineIndex: 0,
                usernameFragment: "test",
                url,
              },
      });
      connection.dispatchEvent(event);
    };
    emitCandidate(40_000, surveyUrls[0]);
    emitCandidate(40_003, surveyUrls[1]);
    emitCandidate(40_006, surveyUrls[2]);
    connection.iceGatheringState = "complete";
    connection.dispatchEvent(new Event("icegatheringstatechange"));
    emitCandidate(null);

    const candidateSignals = signals.filter(
      (signal): signal is Extract<SignalPayload, { kind: "candidate" }> =>
        signal.kind === "candidate",
    );
    const predictionIndex = candidateSignals.findIndex((signal) =>
      signal.candidate?.candidate.includes("candidate:s"),
    );
    const ordinaryIndex = candidateSignals.findIndex((signal) =>
      signal.candidate?.candidate.startsWith("candidate:base"),
    );
    expect(ordinaryIndex).toBe(0);
    expect(predictionIndex).toBeGreaterThanOrEqual(0);
    expect(predictionIndex).toBeGreaterThan(ordinaryIndex);
    expect(
      candidateSignals.filter((signal) =>
        signal.candidate?.candidate.startsWith("candidate:base"),
      ),
    ).toHaveLength(3);
    expect(candidateSignals.at(-1)?.candidate).toBeNull();
    expect(candidateSignals.filter((signal) => signal.candidate === null)).toHaveLength(1);
    peer.dispose();
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

  it("applies pause authority to a source replacement while it is in flight", async () => {
    const peer = createPeer(
      createStream(
        createTrack("video", "old-video"),
        createTrack("audio", "old-audio"),
      ),
    );
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const videoSender = connection.senders[0]!;
    const nextVideo = createTrack("video", "next-video");
    const nextAudio = createTrack("audio", "next-audio");
    videoSender.deferReplaceCall = 1;

    const replacing = peer.replaceStream(createStream(nextVideo, nextAudio));
    await vi.waitFor(() =>
      expect(videoSender.replaceTrack).toHaveBeenCalledOnce(),
    );
    const replacementVideo = videoSender.replaceTrack.mock.calls[0]![0]!;
    peer.setPaused(true);
    expect(replacementVideo.enabled).toBe(false);
    expect(nextAudio.enabled).toBe(false);

    videoSender.releaseDeferredReplaceTrack();
    await expect(replacing).resolves.toBe(true);
    expect(videoSender.track?.enabled).toBe(false);
    expect(connection.senders[1]!.track?.enabled).toBe(false);
    peer.setPaused(false);
    expect(videoSender.track?.enabled).toBe(true);
    expect(connection.senders[1]!.track?.enabled).toBe(true);
  });

  it("keeps a pre-negotiated audio sender inactive until a real track exists", async () => {
    const peer = createPeer(
      createStream(createTrack("video", "old-video"), null),
    );

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    expect(connection.transceiverInputs[1]?.trackOrKind).toBe("audio");
    expect(connection.senders[1]?.track).toBeNull();
    expect(connection.transceivers[1]?.direction).toBe("inactive");
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([]);

    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(
        createStream(createTrack("video", "next-video"), nextAudio),
      ),
    ).resolves.toBe(true);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(connection.transceivers[1]?.direction).toBe("sendonly");
    expect(connection.createOfferCallCount).toBe(2);
    expect(connection.senders[1]?.appliedMaxBitrates).toEqual([128_000]);
  });

  it("retires an absent audio track from the negotiated direction", async () => {
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
    expect(connection.transceivers[1]?.direction).toBe("inactive");
    expect(connection.createOfferCallCount).toBe(2);
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

    await expect(
      peer.updateProfile({
        ...QUALITY_PROFILES["720p30"],
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    expect(audioSender.getParameters().encodings[0]?.maxBitrate).toBe(192_000);
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

  it("retains restart candidates that arrive before the new answer", async () => {
    const peer = createPeer(createStream(createTrack("video", "video"), null));
    await peer.start();
    const connection = FakePeerConnection.latest!;
    await peer.acceptSignal({
      kind: "description", connectionId: peer.connectionId,
      description: { type: "answer", sdp: "previous-answer" },
    });
    await expect(peer.restartIce()).resolves.toBe(true);
    const nextCandidate = {
      candidate: "candidate:next 1 udp 2122260223 192.0.2.8 50001 typ host ufrag next",
      usernameFragment: "next", sdpMid: "0", sdpMLineIndex: 0,
    };
    await peer.acceptSignal({
      kind: "candidate", connectionId: peer.connectionId, candidate: nextCandidate,
    });
    // Native receiver events can precede the receive-offer RPC response.
    expect(connection.addedIceCandidates).toEqual([]);
    connection.deferRemoteDescriptionCall = 2;
    const answer = peer.acceptSignal({
      kind: "description", connectionId: peer.connectionId,
      description: { type: "answer", sdp: "next-answer" },
    });
    await vi.waitFor(() => expect(connection.remoteDescriptionCallCount).toBe(2));
    const end = peer.acceptSignal({
      kind: "candidate", connectionId: peer.connectionId, candidate: null,
    });
    connection.releaseDeferredRemoteDescription();
    await Promise.all([answer, end]);
    expect(connection.remoteDescription?.sdp).toBe("next-answer");
    expect(connection.addedIceCandidates).toEqual([nextCandidate, null]);
    peer.dispose();
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

  it.each([0, 250])("counts new source frames from a valid baseline of %s", async (baseline) => {
    const video = createTrack("video", "video");
    const peer = createPeer(createStream(video, createTrack("audio", "audio")));

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    await acceptPeerAnswer(peer);
    expect(
      connection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({ degradationPreference: "balanced" });

    const nextVideo = createTrack("video", "next-video");
    await expect(
      peer.replaceStream(createStream(nextVideo, null)),
    ).resolves.toBe(true);
    expect(
      connection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({ degradationPreference: "maintain-resolution" });
    const configureCalls =
      connection.senders[0]!.setParameters.mock.calls.length;

    const staleReport = sendStatsReport({
      bytesSent: 10_000,
      framesEncoded: 250,
      timestamp: 1_000,
      qualityLimitationReason: "none",
      trackIdentifier: video.id,
    });
    const missingCount = sendStatsReport({
      bytesSent: 10_000,
      framesEncoded: 0,
      timestamp: 1_000,
      qualityLimitationReason: "none",
      trackIdentifier: connection.senders[0]!.track!.id,
    });
    delete missingCount.get("outbound-video").framesEncoded;
    // Missing/currently unmatched stats cannot seed the new baseline as zero.
    for (const report of [emptyStatsReport(), staleReport, missingCount]) {
      connection.statsReports.push(report);
      statsCallbacks.at(-1)!();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // A valid zero is different from missing stats. An existing RTP stream may
    // instead retain a large cumulative count across replaceTrack.
    await completeVideoStartup(connection, baseline);
    expect(connection.senders[0]!.setParameters.mock.calls.length).toBe(
      configureCalls,
    );
    await completeVideoStartup(connection, baseline + 4);
    expect(connection.senders[0]!.setParameters.mock.calls.length).toBe(
      configureCalls,
    );
    await completeVideoStartup(connection, baseline + 5);
    expect(connection.senders[0]!.setParameters.mock.calls.length).toBe(
      configureCalls + 1,
    );
    expect(
      connection.senders[0]?.setParameters.mock.calls.at(-1)?.[0],
    ).toMatchObject({ degradationPreference: "balanced" });
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

  it.each([false, true])("applies connecting profile changes without canceling an in-flight constraint: %s", async (holdConstraints) => {
    const peer = createPeer(createStream(createTrack("video", "video"), createTrack("audio", "audio")));
    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    const sender = connection.senders[0]!;
    await peer.acceptSignal({
      kind: "description", connectionId: peer.connectionId,
      description: { type: "answer", sdp: "test-answer" },
    });
    await completeVideoStartup(connection, 5);
    const before = sender.setParameters.mock.calls.length;
    let release: (() => void) | undefined;
    if (holdConstraints) {
      vi.mocked(sender.track!.applyConstraints).mockImplementationOnce(() =>
        new Promise<void>((resolve) => { release = resolve; }),
      );
    }
    const changing = holdConstraints
      ? peer.updateCaptureProfile(QUALITY_PROFILES["1080p60"])
      : peer.updateProfile(QUALITY_PROFILES["1080p60"]);
    if (holdConstraints) {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    } else {
      await expect(changing).resolves.toBe(true);
    }
    expect(sender.setParameters).toHaveBeenCalledTimes(before);
    connection.connectionState = "connected";
    connection.dispatchEvent(new Event("connectionstatechange"));
    release?.();
    await expect(changing).resolves.toBe(true);
    await vi.waitFor(() => expect(sender.appliedMaxBitrates.at(-1)).toBe(8_000_000));
    expect(sender.setParameters).toHaveBeenCalledTimes(before + 1);
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
    const peer = createPeer(
      createStream(
        createTrack("video", "video"),
        createTrack("audio", "audio"),
      ),
    );

    const starting = peer.start();
    const videoSender = FakePeerConnection.latest!.senders[0]!;
    videoSender.failNextSetParameters = true;
    await expect(starting).resolves.toBe(true);
    await acceptPeerAnswer(peer);

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
    natPredictionEnabled: false,
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
    const onPreparedChildFailed = vi.fn();
    const owner = new HostProvisionalChild({ sendSignal: () => true, onPreparedChildFailed });
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
    expect(onPreparedChildFailed).not.toHaveBeenCalled();
  });

  it("reports failed Host preparation once and fences retired attempts", async () => {
    const onPreparedChildFailed = vi.fn();
    const owner = new HostProvisionalChild({ sendSignal: () => true, onPreparedChildFailed });
    const stream = createStream(createTrack("video", "host-failure-video"), null);
    FakePeerConnection.offersFailing = 1;
    owner.prepare(hostProvisionalInput(7, ["first"], stream));
    await vi.waitFor(() => expect(onPreparedChildFailed).toHaveBeenCalledExactlyOnceWith(7, "candidate-connection-7"));

    owner.prepare(hostProvisionalInput(8, ["second"], stream));
    const connection = FakePeerConnection.latest!;
    connection.connectionState = "failed";
    connection.dispatchEvent(new Event("connectionstatechange"));
    connection.dispatchEvent(new Event("connectionstatechange"));
    expect(onPreparedChildFailed).toHaveBeenCalledTimes(2);
    expect(onPreparedChildFailed).toHaveBeenLastCalledWith(8, "candidate-connection-8");
    owner.discard();
    connection.dispatchEvent(new Event("connectionstatechange"));
    expect(onPreparedChildFailed).toHaveBeenCalledTimes(2);
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
  it("applies the room NAT policy to downstream Peer connections", async () => {
    const relay = new ViewerRelay(
      {
        iceServers: [{ urls: "stun:share.example.test:3478" }],
        natPredictionStunUrls: [
          "stun:share.example.test:3479",
          "stun:share.example.test:3480",
        ],
      },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true },
      2,
      true,
    );

    relay.setChildren(["nat-child"]);
    relay.setStream(
      createStream(createTrack("video", "nat-relay-source"), null),
    );
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    expect(FakePeerConnection.latest!.configurations[0]?.iceServers).toEqual([
      { urls: "stun:share.example.test:3478" },
      { urls: "stun:share.example.test:3479" },
      { urls: "stun:share.example.test:3480" },
    ]);
    relay.dispose();
  });

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

  it("prepares against the current source and codec after an in-flight probe is replaced", async () => {
    let finishOld!: (codec: "vp8") => void;
    let finishCurrent!: (codec: "h264") => void;
    codecPreflight.probe
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishCurrent = resolve; }));
    const signals: SignalPayload[] = [];
    const relay = new ViewerRelay({ iceServers: [] }, QUALITY_PROFILES["720p30"], {
      sendSignal: (_peerId, payload) => { signals.push(payload); return true; },
    });
    const current = createTrack("video", "current-source");
    try {
      relay.setStream(createStream(createTrack("video", "old-source"), null));
      expect(relay.prepareChild(7, routeCandidate(7, "child"), ["child"])).toBe(true);
      relay.setStream(createStream(current, null));
      finishOld("vp8");
      await vi.waitFor(() => expect(codecPreflight.probe).toHaveBeenCalledTimes(2));
      expect(FakePeerConnection.instances).toHaveLength(0);
      finishCurrent("h264");
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]?.connectionId).toBe("relay-candidate-7");
      const connection = FakePeerConnection.latest!;
      expect(connection.senders[0]!.track!.id).toContain("current-source");
      expect(connection.codecPreferenceCalls[0]?.[0]?.mimeType.toLowerCase()).toBe("video/h264");
      expect(relay.prepareChild(7, routeCandidate(7, "child"), ["child"])).toBe(true);
      expect(FakePeerConnection.instances).toHaveLength(1);
    } finally {
      relay.dispose();
    }
  });

  it.each(["discard", "stop", "dispose"] as const)("does not resurrect preparation after %s during a codec probe", async (action) => {
    let finishProbe!: (codec: "vp8") => void;
    codecPreflight.probe.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }));
    const sendSignal = vi.fn(() => true);
    const relay = new ViewerRelay({ iceServers: [] }, QUALITY_PROFILES["720p30"], { sendSignal });
    relay.setStream(createStream(createTrack("video", "pending-source"), null));
    expect(relay.prepareChild(7, routeCandidate(7, "child"), ["child"])).toBe(true);
    if (action === "discard") relay.discardPreparedChild();
    else relay[action]();
    finishProbe("vp8");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(sendSignal).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("rebuilds a failed ICE restart from the source selected while it was pending", async () => {
    let finishRestart!: (result: boolean) => void;
    vi.spyOn(HostPeer.prototype, "restartIce").mockImplementationOnce(() =>
      new Promise((resolve) => { finishRestart = resolve; }));
    const signals: SignalPayload[] = [];
    const relay = new ViewerRelay({ iceServers: [] }, QUALITY_PROFILES["720p30"], {
      sendSignal: (_peerId, payload) => { signals.push(payload); return true; },
    });
    try {
      relay.setChildren(["child"]);
      relay.setStream(createStream(createTrack("video", "old-source"), null));
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      const original = FakePeerConnection.latest!;
      const recovery = relay.recover("child", signals[0]!.connectionId, false);
      relay.setStream(createStream(createTrack("video", "current-source"), null));
      await vi.waitFor(() => expect(original.senders[0]!.track!.id).toContain("current-source"));
      finishRestart(false);
      await recovery;
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      expect(original.connectionState).toBe("closed");
      expect(FakePeerConnection.latest!.senders[0]!.track!.id).toContain("current-source");
    } finally {
      relay.dispose();
    }
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

  it("binds native relay children so their signalling and snapshots stay owned", async () => {
    const stubs = new Map<
      string,
      { peer: HostMediaPeer; events: ViewerRelayPeerEvents }
    >();
    const nativeSnapshot = (peer: HostMediaPeer): PeerSnapshot => ({
      peerId: peer.peerId,
      connectionId: peer.connectionId,
      connectionState: "connected",
      iceConnectionState: "connected",
      metrics: { ...EMPTY_METRICS },
      error: null,
    });
    const peerFactory: ViewerRelayPeerFactory = {
      requiresStream: false,
      create: (childPeerId, connectionId, events) => {
        const edgeConnectionId = connectionId ?? `native-${childPeerId}`;
        const peer: HostMediaPeer = {
          peerId: childPeerId,
          connectionId: edgeConnectionId,
          start: async () =>
            events.sendSignal(childPeerId, {
              kind: "description",
              connectionId: edgeConnectionId,
              description: { type: "offer", sdp: "native-offer" },
            }),
          acceptSignal: async () => undefined,
          restartIce: async () => true,
          isConnected: () => true,
          getSnapshot: () => nativeSnapshot(peer),
          updateIceConfig: () => undefined,
          updateProfile: async () => true,
          updateCaptureProfile: async () => true,
          setPaused: () => undefined,
          replaceStream: async () => true,
          dispose: () => undefined,
        };
        stubs.set(childPeerId, { peer, events });
        return peer;
      },
    };
    const onSenderUpdate = vi.fn();
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true, onSenderUpdate },
      2,
      false,
      peerFactory,
    );

    relay.setChildren(["native-a"]);
    await vi.waitFor(() => expect(stubs.has("native-a")).toBe(true));
    expect(
      relay.prepareChild(7, routeCandidate(7, "native-b"), [
        "native-a",
        "native-b",
      ]),
    ).toBe(true);
    await vi.waitFor(() => expect(stubs.has("native-b")).toBe(true));
    const active = stubs.get("native-a")!;
    const prepared = stubs.get("native-b")!;

    expect(
      active.events.sendSignal("native-a", {
        kind: "candidate",
        connectionId: active.peer.connectionId,
        candidate: { candidate: "late-candidate" },
      }),
    ).toBe(true);
    prepared.events.onUpdate(nativeSnapshot(prepared.peer));
    expect(onSenderUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ peerId: "native-b" }),
      7,
    );

    relay.activateChildren(7, ["native-a", "native-b"]);
    prepared.events.onUpdate({
      ...nativeSnapshot(prepared.peer),
      error: { key: "host.err.serverError" },
    });
    expect(relay.getSnapshot("native-b")?.error).toEqual({
      key: "host.err.serverError",
    });
    relay.dispose();
  });

  it("replaces one active child with a same-parent prepared connection", async () => {
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
    relay.setStream(createStream(createTrack("video", "same-parent-video"), null));
    expect(relay.prepareChild(1, routeCandidate(1, "same-child"), ["same-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const firstConnection = FakePeerConnection.latest!;
    await relay.acceptSignal("same-child", {
      kind: "description",
      connectionId: signals[0]!.connectionId,
      description: { type: "answer", sdp: "first-answer" },
    }, 1);
    firstConnection.connectionState = "connected";
    relay.activateChildren(1, ["same-child"]);
    expect(relay.getSnapshot("same-child")?.connectionId).toBe(
      signals[0]!.connectionId,
    );

    expect(relay.prepareChild(2, routeCandidate(2, "same-child"), ["same-child"])).toBe(true);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const secondConnection = FakePeerConnection.latest!;
    expect(firstConnection.connectionState).toBe("connected");
    await relay.acceptSignal("same-child", {
      kind: "description",
      connectionId: signals[1]!.connectionId,
      description: { type: "answer", sdp: "second-answer" },
    }, 2);
    secondConnection.connectionState = "connected";
    relay.activateChildren(2, ["same-child"]);

    expect(firstConnection.connectionState).toBe("closed");
    expect(secondConnection.connectionState).toBe("connected");
    expect(relay.getSnapshot("same-child")?.connectionId).toBe(
      signals[1]!.connectionId,
    );
    relay.dispose();
  });

  it("cleans prepared children on failure, replacement, rollback, session reset, and share stop", async () => {
    const onPreparedChildFailed = vi.fn();
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true, onPreparedChildFailed },
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
    expect(onPreparedChildFailed).not.toHaveBeenCalled();

    FakePeerConnection.offersFailing = 1;
    const instancesBeforeFailure = FakePeerConnection.instances.length;
    expect(relay.prepareChild(10, routeCandidate(10, "failed-probe"), ["failed-probe"])).toBe(true);
    const failedProbe = FakePeerConnection.latest!;
    await vi.waitFor(() => expect(failedProbe.connectionState).toBe("closed"));
    expect(FakePeerConnection.instances).toHaveLength(instancesBeforeFailure + 1);
    expect(onPreparedChildFailed).toHaveBeenCalledExactlyOnceWith(10, "relay-candidate-10");

    expect(relay.prepareChild(11, routeCandidate(11, "session-probe"), ["session-probe"])).toBe(true);
    const sessionProbe = FakePeerConnection.latest!;
    relay.discardPreparedChild();
    expect(sessionProbe.connectionState).toBe("closed");

    expect(relay.prepareChild(12, routeCandidate(12, "stopped-probe"), ["stopped-probe"])).toBe(true);
    const stoppedProbe = FakePeerConnection.latest!;
    relay.stop();
    expect(stoppedProbe.connectionState).toBe("closed");
    relay.dispose();
    expect(onPreparedChildFailed).toHaveBeenCalledTimes(1);
  });

  it("reports a failed prepared transport once without blaming retained children", async () => {
    const onPreparedChildFailed = vi.fn();
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      { sendSignal: () => true, onPreparedChildFailed },
    );
    relay.setStream(createStream(createTrack("video", "failure-video"), null));
    relay.prepareChild(1, routeCandidate(1, "retained"), ["retained"]);
    await vi.waitFor(() => expect(FakePeerConnection.latest).not.toBeNull());
    const retained = FakePeerConnection.latest!;
    retained.connectionState = "connected";
    relay.activateChildren(1, ["retained"]);
    relay.prepareChild(2, routeCandidate(2, "candidate"), ["retained", "candidate"]);
    const candidate = FakePeerConnection.latest!;
    candidate.connectionState = "failed";
    candidate.dispatchEvent(new Event("connectionstatechange"));
    candidate.dispatchEvent(new Event("connectionstatechange"));
    expect(onPreparedChildFailed).toHaveBeenCalledExactlyOnceWith(2, "relay-candidate-2");
    expect(retained.connectionState).toBe("connected");
    relay.activateChildren(3, ["retained"]);
    candidate.dispatchEvent(new Event("connectionstatechange"));
    expect(onPreparedChildFailed).toHaveBeenCalledTimes(1);
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

  it("preserves a connecting replacement when topology reaffirms the same child", async () => {
    const connectionIds: string[] = [];
    const relay = new ViewerRelay(
      { iceServers: [] },
      QUALITY_PROFILES["720p30"],
      {
        sendSignal: (_peerId, payload) => {
          connectionIds.push(payload.connectionId);
          return true;
        },
      },
    );
    relay.setChildren(["reconciled-child"]);
    relay.setStream(
      createStream(createTrack("video", "reconciled-video"), null),
    );
    try {
      await vi.waitFor(() => expect(connectionIds).toHaveLength(1));
      const original = FakePeerConnection.latest!;
      original.connectionState = "connected";

      await relay.recover("reconciled-child", connectionIds[0]!, true);
      await vi.waitFor(() => expect(connectionIds).toHaveLength(2));
      const replacement = FakePeerConnection.latest!;
      expect(replacement).not.toBe(original);
      expect(original.connectionState).toBe("closed");
      replacement.connectionState = "connecting";

      relay.activateChildren(2, ["reconciled-child"]);
      relay.setChildren(["reconciled-child"]);
      relay.updateCapacity(1);

      await expect(relay.acceptSignal("reconciled-child", {
        kind: "description",
        connectionId: connectionIds[1]!,
        description: { type: "answer", sdp: "replacement-answer" },
      }, 2)).resolves.toBe(true);
      expect(FakePeerConnection.latest).toBe(replacement);
      expect(replacement.connectionState).toBe("connecting");
      expect(replacement.remoteDescription?.sdp).toBe("replacement-answer");
      expect(connectionIds).toHaveLength(2);
    } finally {
      relay.dispose();
    }
  });

  it("rebuilds only unfinished negotiations after signaling resynchronizes", async () => {
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
    const children = ["healthy-child", "unfinished-child"];
    relay.setChildren(children);
    relay.setStream(createStream(createTrack("video", "resync-video"), null));
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      const [healthy, unfinished] = FakePeerConnection.instances;
      healthy!.connectionState = "connected";
      unfinished!.connectionState = "connecting";
      const oldId = signals.find(({ peerId }) => peerId === "unfinished-child")!.connectionId;

      relay.resyncSignaling();
      relay.activateChildren(2, children);
      await vi.waitFor(() => expect(signals).toHaveLength(3));
      expect(healthy!.connectionState).toBe("connected");
      expect(unfinished!.connectionState).toBe("closed");
      expect(signals.filter(({ peerId }) => peerId === "healthy-child")).toHaveLength(1);
      const replacement = FakePeerConnection.latest!;
      const newId = signals[2]!.connectionId;
      expect(newId).not.toBe(oldId);
      await expect(relay.acceptSignal("unfinished-child", {
        kind: "description",
        connectionId: oldId,
        description: { type: "answer", sdp: "stale-answer" },
      }, 2)).resolves.toBe(false);
      await expect(relay.acceptSignal("unfinished-child", {
        kind: "description",
        connectionId: newId,
        description: { type: "answer", sdp: "resynced-answer" },
      }, 2)).resolves.toBe(true);
      expect(replacement.remoteDescription?.sdp).toBe("resynced-answer");
    } finally {
      relay.dispose();
    }
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
