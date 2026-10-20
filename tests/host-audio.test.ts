import { afterEach, expect, test, vi } from "vitest";
import { HostAudio } from "../src/client/media/host-audio";
import { captureBrowserSource, QUALITY_PROFILES } from "../src/client/media/quality";

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  onended: (() => void) | null = null;
  constructor(readonly kind: string) { super(); }
  stop = vi.fn(() => { this.readyState = "ended"; });
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
}
const media = (...tracks: Track[]) => new Stream(tracks) as unknown as MediaStream;

function setup() {
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { getUserMedia };
}
afterEach(() => vi.unstubAllGlobals());

test("source-audio availability follows live input and replacement without owning video or room voice", () => {
  const video = new Track("video"), sound = new Track("audio"), next = new Track("audio");
  const changed = vi.fn(), audio = new HostAudio(media(video, sound), "browser", changed);
  expect(audio.audioAvailable).toBe(true);
  sound.stop(); sound.dispatchEvent(new Event("ended"));
  expect(changed).toHaveBeenLastCalledWith(false);
  const replacement = media(video, next);
  expect(audio.attach(replacement, "camera")).toBe(replacement);
  expect(audio.sourceStream).toBe(replacement);
  expect(audio.sourceKind).toBe("camera");
  expect(changed).toHaveBeenLastCalledWith(true);
  next.enabled = false;
  expect(audio.audioAvailable).toBe(true);
  audio.dispose(); changed.mockClear();
  expect(next.stop).toHaveBeenCalledOnce();
  expect(video.stop).not.toHaveBeenCalled();
  next.dispatchEvent(new Event("ended"));
  expect(changed).not.toHaveBeenCalled();
});

test("camera is a bounded video source and never implicitly requests a microphone", async () => {
  const { getUserMedia } = setup();
  const video = new Track("video");
  const source = media(video);
  getUserMedia.mockResolvedValue(source);
  expect(await captureBrowserSource(QUALITY_PROFILES["1080p30"], "camera")).toBe(source);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: {
    resizeMode: { exact: "none" },
    facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  } });
});

test("camera selection requests one exact device without microphone permission", async () => {
  const { getUserMedia } = setup();
  getUserMedia.mockResolvedValue(media(new Track("video")));
  await captureBrowserSource(QUALITY_PROFILES["1080p30"], "camera", "front-camera");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ deviceId: { exact: "front-camera" } }) });
  expect(getUserMedia.mock.calls[0][0].video).toHaveProperty("resizeMode", { exact: "none" });
  expect(getUserMedia.mock.calls[0][0].video).not.toHaveProperty("facingMode");
});
