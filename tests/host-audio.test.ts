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
    nodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    currentTime = 0;
    gain = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
    constructor() { contexts.push(this); }
    createMediaStreamDestination() { return { stream: this.output }; }
    createGain() { return this.gain; }
    createMediaStreamSource(stream: Stream) {
      this.inputs.push(stream);
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      this.nodes.push(node);
      return node;
    }
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
  expect(audio.sourceStream.getAudioTracks()).toHaveLength(0);
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

test("source audio facts are independent of mixed voice, mute, volume and share pause", async () => {
  const { getUserMedia } = setup();
  const camera = new Track("video"), microphone = new Track("audio");
  const source = media(camera);
  const audio = new HostAudio(source, vi.fn());
  getUserMedia.mockResolvedValue(media(microphone));
  const mixed = (await audio.toggleMicrophone())!;
  expect(mixed.getAudioTracks()).toHaveLength(1);
  expect(audio.sourceStream).toBe(source);
  expect(audio.sourceStream.getAudioTracks()).toHaveLength(0);
  await audio.toggleMicrophone();
  audio.setMicrophoneVolume(0);
  mixed.getTracks().forEach(track => { track.enabled = false; });
  expect(audio.sourceStream.getAudioTracks()).toHaveLength(0);
  const sourceSound = new Track("audio");
  sourceSound.enabled = false;
  const nextSource = media(new Track("video"), sourceSound);
  audio.attach(nextSource);
  expect(audio.sourceStream).toBe(nextSource);
  expect(audio.sourceStream.getAudioTracks()).toHaveLength(1);
  expect(microphone.enabled).toBe(false);
  audio.dispose();
  expect(sourceSound.stop).toHaveBeenCalledOnce();
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

test("microphone volume changes only the microphone input without replacing the shared output", async () => {
  const { contexts, getUserMedia } = setup();
  const sound = new Track("audio"), microphone = new Track("audio");
  const audio = new HostAudio(media(new Track("video"), sound), vi.fn());
  audio.setMicrophoneVolume(0.5);
  getUserMedia.mockResolvedValue(media(microphone));
  const mixed = (await audio.toggleMicrophone())!;
  const context = contexts[0];
  expect(context.gain.gain.value).toBe(0.5);
  expect(context.nodes[0].connect).not.toHaveBeenCalledWith(context.gain);
  expect(context.nodes[1].connect).toHaveBeenCalledWith(context.gain);
  audio.setMicrophoneVolume(1.5);
  expect(context.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, 0.01);
  audio.setMicrophoneVolume(Number.NaN);
  expect(context.gain.gain.setTargetAtTime).toHaveBeenCalledOnce();
  await audio.toggleMicrophone();
  const changed = audio.attach(media(new Track("video")));
  expect(changed.getAudioTracks()).toEqual(mixed.getAudioTracks());
  expect(microphone.enabled).toBe(false);
  expect(getUserMedia).toHaveBeenCalledOnce();
  audio.dispose();
  expect(context.gain.disconnect).toHaveBeenCalledOnce();
});

test("switching microphone preserves output and leaves the old input on failure", async () => {
  const { getUserMedia } = setup();
  const video = new Track("video"), first = new Track("audio"), second = new Track("audio");
  const audio = new HostAudio(media(video), vi.fn());
  getUserMedia.mockResolvedValueOnce(media(first));
  const output = (await audio.setMicrophone(true, "first"))!;
  getUserMedia.mockRejectedValueOnce(new DOMException("missing", "NotFoundError"));
  await expect(audio.setMicrophone(true, "missing")).rejects.toThrow("missing");
  expect(first.stop).not.toHaveBeenCalled();
  expect(video.stop).not.toHaveBeenCalled();
  getUserMedia.mockResolvedValueOnce(media(second));
  const replacement = await audio.setMicrophone(true, "second");
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: "second" } }) });
  expect(replacement).toBeNull(); // No transport update for an input-only change.
  expect(output.getAudioTracks()[0].readyState).toBe("live");
  expect(first.stop).toHaveBeenCalledOnce();
  first.onended!(); // Retired input cannot mute its replacement.
  expect(second.enabled).toBe(true);
  await audio.setMicrophone(false, "first");
  expect(second.stop).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledTimes(3); // Selecting while muted never captures.
  audio.dispose();
});

test("camera selection requests one exact device without microphone permission", async () => {
  const { getUserMedia } = setup();
  getUserMedia.mockResolvedValue(media(new Track("video")));
  await captureBrowserSource(QUALITY_PROFILES["1080p30"], "camera", "front-camera");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ deviceId: { exact: "front-camera" } }) });
  expect(getUserMedia.mock.calls[0][0].video).not.toHaveProperty("facingMode");
});
