import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUALITY_PROFILES } from "../src/client/media/quality.ts";
import { HostPeer } from "../src/client/webrtc/host-peer.ts";

class FakeSender {
  failNextReplace = false;
  failNextSetParameters = false;
  readonly setParameters = vi.fn(
    async (_parameters: RTCRtpSendParameters) => {
      if (this.failNextSetParameters) {
        this.failNextSetParameters = false;
        throw new Error("setParameters failed");
      }
    },
  );
  readonly replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => {
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("replaceTrack failed");
    }
    this.track = track;
  });

  constructor(public track: MediaStreamTrack | null) {}

  getParameters(): RTCRtpSendParameters {
    return { encodings: [{}] } as RTCRtpSendParameters;
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;

  readonly senders: FakeSender[] = [];
  readonly transceiverInputs: Array<{
    trackOrKind: MediaStreamTrack | string;
    init?: RTCRtpTransceiverInit;
  }> = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;

  constructor() {
    FakePeerConnection.latest = this;
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver {
    const sender = new FakeSender(
      typeof trackOrKind === "string" ? null : trackOrKind,
    );
    this.senders.push(sender);
    this.transceiverInputs.push({ trackOrKind, init });
    return { sender } as unknown as RTCRtpTransceiver;
  }

  addEventListener(): void {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "test-offer" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function createTrack(kind: "video" | "audio", id: string): MediaStreamTrack {
  return { id, kind } as MediaStreamTrack;
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

function createPeer(stream: MediaStream): HostPeer {
  return new HostPeer(
    "viewer-peer",
    { iceServers: [], expiresAt: null, relayAvailable: false },
    stream,
    QUALITY_PROFILES["720p30"],
    {
      sendSignal: () => true,
      onUpdate: () => undefined,
    },
  );
}

beforeEach(() => {
  FakePeerConnection.latest = null;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HostPeer source replacement", () => {
  it("reserves send-only video and audio senders and replaces both tracks", async () => {
    const oldVideo = createTrack("video", "old-video");
    const oldAudio = createTrack("audio", "old-audio");
    const peer = createPeer(createStream(oldVideo, oldAudio));

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
      peer.replaceStream(
        createStream(nextVideo, nextAudio),
        QUALITY_PROFILES["1080p60"],
      ),
    ).resolves.toBe(true);

    expect(connection.senders[0]?.track).toBe(nextVideo);
    expect(connection.senders[1]?.track).toBe(nextAudio);
    expect(connection.senders[0]?.setParameters).toHaveBeenCalledTimes(2);
  });

  it("fills a pre-negotiated audio sender that started without a track", async () => {
    const peer = createPeer(
      createStream(createTrack("video", "old-video"), null),
    );

    await expect(peer.start()).resolves.toBe(true);
    const connection = FakePeerConnection.latest!;
    expect(connection.transceiverInputs[1]?.trackOrKind).toBe("audio");
    expect(connection.senders[1]?.track).toBeNull();

    const nextAudio = createTrack("audio", "next-audio");
    await expect(
      peer.replaceStream(
        createStream(createTrack("video", "next-video"), nextAudio),
        QUALITY_PROFILES["1080p30"],
      ),
    ).resolves.toBe(true);
    expect(connection.senders[1]?.track).toBe(nextAudio);
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
        QUALITY_PROFILES["720p30"],
      ),
    ).resolves.toBe(true);

    expect(connection.senders[1]?.track).toBeNull();
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
      peer.replaceStream(
        createStream(nextVideo, nextAudio),
        QUALITY_PROFILES["1080p60"],
      ),
    ).resolves.toBe(false);

    expect(videoSender.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo);
    expect(videoSender.replaceTrack).toHaveBeenNthCalledWith(2, oldVideo);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(1, nextAudio);
    expect(audioSender.replaceTrack).toHaveBeenNthCalledWith(2, oldAudio);
    expect(videoSender.track).toBe(oldVideo);
    expect(audioSender.track).toBe(oldAudio);
  });
});
