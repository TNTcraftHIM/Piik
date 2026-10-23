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

class AudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class Context {
  currentTime = 0;
  state = "running";
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => {});
  createMediaStreamDestination() { return Object.assign(new AudioNode(), { stream: media(new Track("audio")) }); }
  createMediaStreamSource = vi.fn(() => new AudioNode());
  createGain() { return Object.assign(new AudioNode(), { gain: { value: 1, setTargetAtTime: vi.fn() } }); }
  createAnalyser() { return Object.assign(new AudioNode(), { fftSize: 256, getFloatTimeDomainData: vi.fn() }); }
}
function mixerSetup() {
  const { getUserMedia } = setup();
  const contexts: Context[] = [];
  vi.stubGlobal("AudioContext", class extends Context { constructor() { super(); contexts.push(this); } });
  vi.stubGlobal("MediaStream", Stream);
  return { getUserMedia, contexts };
}

test("failed optional mixing preserves source sharing and retires its partial graph", async () => {
  const { getUserMedia } = mixerSetup();
  const context = new Context();
  context.resume.mockRejectedValueOnce(new Error("Audio unavailable"));
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  const destination = vi.spyOn(context, "createMediaStreamDestination");
  const video = new Track("video"), sound = new Track("audio"), source = media(video, sound);
  const audio = new HostAudio(source);
  expect(await audio.start()).toBe(source);
  expect(audio.commentaryAvailable).toBe(false);
  expect(audio.audioAvailable).toBe(true);
  expect(video.stop).not.toHaveBeenCalled(); expect(sound.stop).not.toHaveBeenCalled();
  expect(destination.mock.results[0]!.value.stream.getAudioTracks()[0].readyState).toBe("ended");
  expect(context.close).toHaveBeenCalledOnce();
  await expect(audio.setMicrophone(true, { deviceId: "", volume: 1, voiceProcessing: true })).rejects.toThrow("Shared audio is unavailable");
  expect(getUserMedia).not.toHaveBeenCalled();
  const nextSound = new Track("audio"), replacement = media(video, nextSound);
  expect(audio.attach(replacement)).toBe(replacement);
  expect(sound.stop).toHaveBeenCalledOnce();
  audio.dispose();
  expect(nextSound.stop).toHaveBeenCalledOnce(); expect(video.stop).not.toHaveBeenCalled();
});

test("commentary and source replacement retain one published output and retire their own inputs", async () => {
  const { getUserMedia, contexts } = mixerSetup();
  const microphone = new Track("audio"), nextMic = new Track("audio"), video = new Track("video"), sound = new Track("audio");
  const changed = vi.fn(), microphoneChanged = vi.fn();
  const audio = new HostAudio(media(video, sound), "browser", changed, microphoneChanged);
  const output = await audio.start(), outputTrack = output.getAudioTracks()[0];
  expect(audio.commentaryAvailable).toBe(true);
  getUserMedia.mockResolvedValueOnce(media(microphone));
  await audio.setMicrophone(true, { deviceId: "headset", volume: 1, voiceProcessing: true });
  expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: "headset" }, echoCancellation: true }), video: false });
  const nextVideo = new Track("video");
  const replacement = audio.attach(media(nextVideo), "camera");
  expect(replacement.getAudioTracks()[0]).toBe(outputTrack);
  expect(replacement.getVideoTracks()[0]).toBe(nextVideo);
  expect(audio.sourceAudioAvailable).toBe(false);
  expect(audio.audioAvailable).toBe(true);
  expect(sound.stop).toHaveBeenCalledOnce();
  getUserMedia.mockRejectedValueOnce(new Error("Device unavailable"));
  await expect(audio.setMicrophone(true, { deviceId: "missing", volume: 1, voiceProcessing: true })).rejects.toThrow("Device unavailable");
  expect(audio.audioAvailable).toBe(true);
  expect(microphone.stop).not.toHaveBeenCalled();
  getUserMedia.mockResolvedValueOnce(media(nextMic));
  changed.mockClear();
  microphoneChanged.mockClear();
  await audio.setMicrophone(true, { deviceId: "other", volume: .5, voiceProcessing: false });
  expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  expect(microphoneChanged).toHaveBeenCalledExactlyOnceWith(true);
  expect(microphone.stop).toHaveBeenCalledOnce();
  expect(outputTrack.readyState).toBe("live");
  await audio.setMicrophone(false, { deviceId: "", volume: 1, voiceProcessing: true });
  expect(nextMic.stop).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenLastCalledWith(false);
  expect(contexts[0]!.close).not.toHaveBeenCalled();
  audio.dispose();
  expect(outputTrack.readyState).toBe("ended");
  expect(contexts.every(context => context.state === "closed")).toBe(true);
  expect(nextVideo.stop).not.toHaveBeenCalled();
});

test("ending a share retires microphone permission completed after disposal", async () => {
  const { getUserMedia, contexts } = mixerSetup();
  let complete!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>(resolve => { complete = resolve; }));
  const microphone = new Track("audio"), enabled = vi.fn();
  const audio = new HostAudio(media(new Track("video")), "browser", () => {}, enabled);
  await audio.start();
  const pending = audio.setMicrophone(true, { deviceId: "", volume: 1, voiceProcessing: true });
  await Promise.resolve();
  audio.dispose(); complete(media(microphone)); await pending;
  expect(microphone.stop).toHaveBeenCalledOnce();
  expect(enabled).not.toHaveBeenCalledWith(true);
  expect(contexts.every(context => context.state === "closed")).toBe(true);
});

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
