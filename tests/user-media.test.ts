import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  vi.resetModules();
  const window = new EventTarget();
  vi.stubGlobal("window", window);
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const media = await import("../src/client/media/user-media");
  media.installUserMediaPort();
  const postMessage = vi.fn((data: string) => JSON.parse(data)), close = vi.fn();
  const port = { postMessage, close, onmessage: undefined as undefined | ((event: { data: string }) => void) };
  const message = new Event("message");
  Object.assign(message, { source: null, data: "piik-browser-media", ports: [port] });
  window.dispatchEvent(message);
  return { ...media, getUserMedia, postMessage, close, window, port };
}

function input(kind: "audio" | "video") {
  const events = new EventTarget();
  const track = Object.assign(events, { kind, readyState: "live", stop: vi.fn(() => { track.readyState = "ended"; }) });
  return { track: track as unknown as MediaStreamTrack, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

test("pending capture hands off to live tracks without dropping service demand, including replacement and natural end", async () => {
  const media = await setup();
  const mic = input("audio"), camera = input("video"), replacement = input("audio");
  let grant!: (stream: MediaStream) => void;
  media.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const capture = media.acquireUserMedia({ audio: true });
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toEqual({ type: "media-state", microphone: true, camera: false });
  media.port.onmessage?.({ data: "media-sync" });
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toEqual({ type: "media-state", microphone: true, camera: false, synchronized: true });
  grant(mic.stream); await capture;
  expect(media.postMessage.mock.calls.slice(1).every(([state]) => JSON.parse(state).microphone)).toBe(true);
  media.getUserMedia.mockResolvedValueOnce(camera.stream).mockResolvedValueOnce(replacement.stream);
  await media.acquireUserMedia({ video: true });
  await media.acquireUserMedia({ audio: true });
  media.stopUserMediaTrack(mic.track);
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toMatchObject({ microphone: true, camera: true });
  replacement.track.dispatchEvent(new Event("ended"));
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toMatchObject({ microphone: false, camera: true });
  media.stopUserMediaTrack(camera.track);
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toMatchObject({ microphone: false, camera: false });
});

test("failed requests clear pending demand and a replacement native port receives the current snapshot", async () => {
  const media = await setup();
  media.getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await expect(media.acquireUserMedia({ audio: true, video: true })).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(JSON.parse(media.postMessage.mock.lastCall![0])).toMatchObject({ microphone: false, camera: false });
  const camera = input("video");
  media.getUserMedia.mockResolvedValueOnce(camera.stream);
  await media.acquireUserMedia({ video: true });
  const postMessage = vi.fn();
  const message = new Event("message");
  Object.assign(message, { source: media.window, data: "piik-browser-media", ports: [{ postMessage }] });
  media.window.dispatchEvent(message);
  expect(media.close).toHaveBeenCalledOnce();
  media.postMessage.mockClear();
  media.port.onmessage?.({ data: "media-sync" });
  expect(media.postMessage).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: "media-state", microphone: false, camera: true }));
  media.stopUserMediaTrack(camera.track);
});
