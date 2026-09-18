import { afterEach, expect, test, vi } from "vitest";
import { HostAudio } from "../src/client/media/host-audio";
import { captureBrowserSource, QUALITY_PROFILES } from "../src/client/media/quality";

class Track {
  enabled = true;
  readyState = "live";
  onended: (() => void) | null = null;
  constructor(readonly kind: string) {}
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
  const contexts: Context[] = [];
  class Context {
    output = new Stream([new Track("audio")]);
    inputs: Stream[] = [];
    constructor() { contexts.push(this); }
    createMediaStreamDestination() { return { stream: this.output }; }
    createMediaStreamSource(stream: Stream) { this.inputs.push(stream); return { connect: vi.fn(), disconnect: vi.fn() }; }
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("AudioContext", Context);
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { contexts, getUserMedia };
}
afterEach(() => vi.unstubAllGlobals());

test("camera is a bounded video source and never implicitly requests a microphone", async () => {
  const { getUserMedia } = setup();
  const video = new Track("video");
  const source = media(video);
  getUserMedia.mockResolvedValue(source);
  expect(await captureBrowserSource(QUALITY_PROFILES["1080p30"], "camera")).toBe(source);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: {
    facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  } });
});

test("mixing and source changes retain one audio track, microphone intent and the capture-owned video", async () => {
  const { contexts, getUserMedia } = setup();
  const video = new Track("video"), sound = new Track("audio"), microphone = new Track("audio");
  const change = vi.fn();
  const audio = new HostAudio(media(video, sound), change);
  getUserMedia.mockResolvedValue(media(microphone));
  const mixed = (await audio.toggleMicrophone())!;
  expect(mixed.getVideoTracks()).toEqual([video]);
  expect(mixed.getAudioTracks()).toHaveLength(1);
  await audio.toggleMicrophone();
  expect(microphone.enabled).toBe(false);
  expect(change).toHaveBeenLastCalledWith(false);
  const camera = new Track("video");
  const replaced = audio.attach(media(camera));
  expect(replaced.getAudioTracks()).toEqual(mixed.getAudioTracks());
  expect(replaced.getVideoTracks()).toEqual([camera]);
  expect(sound.stop).toHaveBeenCalledOnce();
  expect(video.stop).not.toHaveBeenCalled(); // Host owns picture retirement.
  await audio.toggleMicrophone();
  microphone.stop(); microphone.onended!();
  expect(getUserMedia).toHaveBeenCalledOnce(); // Mute/unmute must not open a second microphone.
  expect(change).toHaveBeenLastCalledWith(false);
  expect(mixed.getAudioTracks()[0].readyState).toBe("live");
  expect(camera.stop).not.toHaveBeenCalled();
  audio.dispose();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(mixed.getAudioTracks()[0].readyState).toBe("ended");
});

test("microphone denial leaves source audio/video alone; late permission cannot revive a retired share", async () => {
  const { contexts, getUserMedia } = setup();
  const video = new Track("video"), sound = new Track("audio");
  const changed = vi.fn();
  const audio = new HostAudio(media(video, sound), changed);
  getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await expect(audio.toggleMicrophone()).rejects.toThrow("Denied");
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(video.stop).not.toHaveBeenCalled();
  expect(sound.stop).not.toHaveBeenCalled();
  let grant!: (stream: MediaStream) => void;
  getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
  const request = audio.toggleMicrophone();
  audio.dispose();
  const lateMicrophone = new Track("audio");
  grant(media(lateMicrophone));
  expect(await request).toBeNull();
  expect(lateMicrophone.stop).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(contexts[1].close).toHaveBeenCalledOnce();
});
