import {
  DEFAULT_QUALITY_SETTINGS,
  type QualitySettings,
} from "../src/shared/protocol";
import { NativeClient } from "../src/client/native/client";
import { NativeMediaBridge } from "../src/client/native/media-bridge";
import { SfuPublisher } from "../src/client/sfu/publisher";

let hostResources: {
  client: NativeClient;
  bridge: NativeMediaBridge;
  publisher: SfuPublisher;
  shareId: string;
} | null = null;
let viewerRoom: import("livekit-client").Room | null = null;
let viewerVideo: HTMLVideoElement | null = null;

export async function startNativeSfuHost(input: {
  url: string;
  token: string;
  sourceTitle: string;
}): Promise<{ audio: boolean }> {
  if (hostResources) throw new Error("native SFU Host is already active");
  const client = await NativeClient.connect();
  if (!client) throw new Error("native Client is unavailable");
  const shareId = "native_sfu_share_123456";
  let bridge: NativeMediaBridge | null = null;
  let publisher: SfuPublisher | null = null;
  try {
    const adapters = await client.captureOptions();
    const adapter = adapters.find((candidate) => candidate.hardwareH264.length > 0);
    const encoder = adapter?.hardwareH264[0];
    const sources = await client.sources();
    const target = sources.find((candidate) =>
      candidate.kind === "window" &&
      candidate.title.includes(input.sourceTitle)
    );
    if (!adapter || !encoder || !target) {
      throw new Error("native capture path is unavailable");
    }
    const started = await client.startShare({
      codec: "h264",
      shareId,
      source: target,
      audio: true,
      adapterIndex: adapter.index,
      encoderIndex: encoder.index,
      edgeCapacity: 3,
      profile: DEFAULT_QUALITY_SETTINGS,
    });
    bridge = new NativeMediaBridge(
      shareId,
      client,
      () => undefined,
      started.audio,
    );
    const stream = await bridge.start();
    publisher = new SfuPublisher();
    if (!(await publisher.connect({ url: input.url, token: input.token }))) {
      throw new Error("native SFU publisher did not connect");
    }
    if (!(await publisher.activate(stream, DEFAULT_QUALITY_SETTINGS, "h264"))) {
      throw new Error("native SFU publisher did not activate");
    }
    hostResources = { client, bridge, publisher, shareId };
    return { audio: stream.getAudioTracks().length > 0 };
  } catch (error) {
    await publisher?.disconnect().catch(() => undefined);
    bridge?.dispose();
    await client.stopShare(shareId).catch(() => undefined);
    client.close();
    throw error;
  }
}

export async function startNativeSfuViewer(input: {
  url: string;
  token: string;
}): Promise<{ frames: number; width: number; height: number }> {
  if (viewerRoom) throw new Error("native SFU Viewer is already active");
  const sdk = await import("livekit-client");
  const room = new sdk.Room({
    adaptiveStream: false,
    disconnectOnPageLeave: false,
  });
  viewerRoom = room;
  const result = new Promise<{ frames: number; width: number; height: number }>(
    (resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("native SFU Viewer timed out")),
        20_000,
      );
      room.on(sdk.RoomEvent.TrackSubscribed, (track, publication) => {
        if (track.kind !== sdk.Track.Kind.Video) return;
        publication.setVideoQuality(sdk.VideoQuality.HIGH);
        const video = track.attach() as HTMLVideoElement;
        viewerVideo = video;
        video.muted = true;
        video.autoplay = true;
        document.body.append(video);
        void video.play().catch(() => undefined);
        let frames = 0;
        const next = () => {
          video.requestVideoFrameCallback(() => {
            if (video.videoWidth === 1920 && video.videoHeight === 1080) {
              frames += 1;
            } else {
              frames = 0;
            }
            if (frames < 30) {
              next();
              return;
            }
            window.clearTimeout(timer);
            resolve({
              frames,
              width: video.videoWidth,
              height: video.videoHeight,
            });
          });
        };
        next();
      });
    },
  );
  try {
    await room.connect(input.url, input.token);
    return await result;
  } catch (error) {
    await room.disconnect(false).catch(() => undefined);
    viewerRoom = null;
    throw error;
  }
}

export async function updateNativeSfuHost(
  profile: QualitySettings,
): Promise<boolean> {
  const host = hostResources;
  if (!host) throw new Error("native SFU Host is unavailable");
  await host.client.updateShare(host.shareId, profile);
  return await host.publisher.updateProfile(profile);
}

export async function waitForNativeSfuViewer(
  width: number,
  height: number,
): Promise<{ frames: number; width: number; height: number }> {
  const video = viewerVideo;
  if (!video) throw new Error("native SFU Viewer is unavailable");
  return await new Promise((resolve, reject) => {
    let frames = 0;
    const timer = window.setTimeout(
      () => reject(new Error("native SFU Viewer profile timed out")),
      20_000,
    );
    const next = () => {
      video.requestVideoFrameCallback(() => {
        frames = video.videoWidth === width && video.videoHeight === height
          ? frames + 1
          : 0;
        if (frames < 15) {
          next();
          return;
        }
        window.clearTimeout(timer);
        resolve({ frames, width: video.videoWidth, height: video.videoHeight });
      });
    };
    next();
  });
}

export async function stopNativeSfuGate(): Promise<void> {
  const viewer = viewerRoom;
  viewerRoom = null;
  viewerVideo = null;
  if (viewer) await viewer.disconnect(false).catch(() => undefined);
  const host = hostResources;
  hostResources = null;
  if (!host) return;
  await host.publisher.disconnect().catch(() => undefined);
  host.bridge.dispose();
  await host.client.stopShare(host.shareId).catch(() => undefined);
  host.client.close();
}
