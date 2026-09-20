import { afterEach, expect, test, vi } from "vitest";
import { loadCameraPreviews, type CameraPreview } from "../src/client/media/camera-previews";

function setup({ permission = true, frames = true } = {}) {
  const tracks: { id: string; readyState: string; stop: ReturnType<typeof vi.fn> }[] = [];
  const videos: Video[] = [];
  const devices = ["front", "rear"].map(id => ({ kind: "videoinput", deviceId: id, label: `${id} camera` }));
  const enumerateDevices = vi.fn(async () => permission ? devices : []);
  const stream = (id: string) => {
    const track = { id, kind: "video", label: `${id} camera`, readyState: "live",
      getSettings: () => ({ deviceId: id }), stop: vi.fn(() => { track.readyState = "ended"; }) };
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  };
  const getUserMedia = vi.fn(async (options: MediaStreamConstraints) => {
    expect(options.audio).toBe(false);
    expect(tracks.filter(track => track.readyState === "live")).toHaveLength(0);
    permission = true;
    const id = (options.video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters | undefined;
    return stream(id?.exact as string ?? "rear");
  });
  class Video extends EventTarget {
    muted = false;
    playsInline = false;
    srcObject: MediaStream | null = null;
    readyState = 0;
    videoWidth = 1920;
    videoHeight = 1080;
    pause = vi.fn();
    play = vi.fn(async () => {
      if (frames) { this.readyState = 2; this.dispatchEvent(new Event("loadeddata")); }
    });
  }
  const createElement = vi.fn((tag: string) => {
    if (tag === "video") { const video = new Video(); videos.push(video); return video; }
    return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => "data:image/jpeg;preview" };
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices } });
  vi.stubGlobal("document", { createElement });
  const publish = vi.fn<(sources: CameraPreview[]) => void>();
  return { tracks, videos, devices, stream, getUserMedia, enumerateDevices, createElement, publish };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("camera thumbnails use serial video-only inputs and release every input", async () => {
  const { tracks, videos, publish, getUserMedia } = setup();
  await loadCameraPreviews(new AbortController().signal, publish);
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(tracks.every(track => track.stop.mock.calls.length === 1)).toBe(true);
  expect(videos.every(video => video.muted && video.playsInline && video.srcObject === null)).toBe(true);
  expect(publish.mock.lastCall?.[0].every(source => !!source.preview)).toBe(true);
  // Earlier renders are immutable while later thumbnails arrive.
  expect(publish.mock.calls[0]![0].every(source => source.preview === null)).toBe(true);
});

test("permission bootstrap retains its first frame without reopening that camera", async () => {
  const { tracks, publish, getUserMedia } = setup({ permission: false });
  await loadCameraPreviews(new AbortController().signal, publish);
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(tracks.map(track => track.id)).toEqual(["rear", "front"]);
  expect(publish.mock.lastCall?.[0].map(source => source.id)).toEqual(["front", "rear"]);
  expect(tracks.every(track => track.readyState === "ended")).toBe(true);
});

test("late permission results after cancellation are stopped and never published", async () => {
  const { getUserMedia, stream, tracks, publish } = setup({ permission: false });
  let grant!: (value: MediaStream) => void;
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const request = new AbortController();
  const pending = loadCameraPreviews(request.signal, publish);
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(grant).toBeDefined());
  request.abort();
  grant(stream("late"));
  await cancelled;
  expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});

test("cancelling a frame wait immediately releases it and never opens the next camera", async () => {
  const { tracks, videos, publish, getUserMedia } = setup({ frames: false });
  const request = new AbortController();
  const pending = loadCameraPreviews(request.signal, publish);
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(videos).toHaveLength(1));
  const published = publish.mock.calls.length;
  request.abort();
  expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  await cancelled;
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledTimes(published);
  expect(videos[0]!.srcObject).toBeNull();
});

test("an active camera is borrowed without opening or stopping any camera", async () => {
  const { stream, getUserMedia, publish, tracks } = setup();
  const active = { srcObject: stream("front"), readyState: 2, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  await loadCameraPreviews(new AbortController().signal, publish, active);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(tracks[0]!.stop).not.toHaveBeenCalled();
  expect(publish.mock.lastCall?.[0].map(source => !!source.preview)).toEqual([true, false]);
});

test("a busy camera keeps its identity and does not suppress other choices", async () => {
  const { publish, tracks, getUserMedia } = setup();
  getUserMedia.mockRejectedValueOnce(new DOMException("Busy", "NotReadableError"));
  await loadCameraPreviews(new AbortController().signal, publish);
  expect(publish.mock.lastCall?.[0].map(source => [source.id, !!source.preview])).toEqual([["front", false], ["rear", true]]);
  expect(tracks[0]!.stop).toHaveBeenCalledOnce();
});

test("missing frames are bounded and an already cancelled picker requests nothing", async () => {
  vi.useFakeTimers();
  const { videos, tracks, getUserMedia, publish } = setup({ frames: false });
  const pending = loadCameraPreviews(new AbortController().signal, publish);
  await vi.runAllTimersAsync();
  await pending;
  expect(tracks.every(track => track.readyState === "ended")).toBe(true);
  expect(videos.every(video => video.srcObject === null)).toBe(true);
  getUserMedia.mockClear();
  const request = new AbortController(); request.abort();
  await expect(loadCameraPreviews(request.signal, publish)).rejects.toMatchObject({ name: "AbortError" });
  expect(getUserMedia).not.toHaveBeenCalled();
});
