import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerAudio } from "../src/client/media/viewer-audio.ts";

class PlaybackVideo extends EventTarget {
  volume = 1;
  muted = false;
  paused = false;
  ended = false;
  srcObject = {};
}

class AudioStream {
  constructor(public tracks: MediaStreamTrack[]) {}
  getAudioTracks(): MediaStreamTrack[] { return this.tracks; }
}

class PlaybackContext extends EventTarget {
  static instances: PlaybackContext[] = [];
  state: AudioContextState = "suspended";
  destination = {};
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  sources: Array<{ stream: AudioStream; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  resolveResume!: () => void;
  rejectResume!: () => void;
  pendingResume = new Promise<void>((resolve, reject) => {
    this.resolveResume = resolve;
    this.rejectResume = reject;
  });
  resume = vi.fn(() => this.pendingResume);
  close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });

  constructor() {
    super();
    PlaybackContext.instances.push(this);
  }

  createGain() { return this.gain; }
  createMediaStreamSource(stream: AudioStream) {
    const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
    this.sources.push(source);
    return source;
  }
  start() {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
    this.resolveResume();
  }
}

function audioTrack() {
  return { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}

describe("Viewer local audio", () => {
  beforeEach(() => {
    PlaybackContext.instances = [];
    vi.stubGlobal("AudioContext", PlaybackContext);
    vi.stubGlobal("MediaStream", AudioStream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lazily adjusts current audio while pause, mute and track changes remain local", () => {
    const video = new PlaybackVideo();
    const srcObject = video.srcObject;
    const onChange = vi.fn();
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, onChange);
    const firstTrack = audioTrack();
    const stream = new AudioStream([firstTrack]);
    audio.bind(stream as unknown as MediaStream);
    expect(PlaybackContext.instances).toHaveLength(0);
    audio.setLevel(0.5);
    expect(video.volume).toBe(0.5);
    const context = PlaybackContext.instances[0];
    expect(video.muted).toBe(false);
    expect(context.gain.gain.value).toBe(0);
    audio.setLevel(0);
    expect(video.muted).toBe(true);
    audio.setLevel(0.5);
    context.start();
    expect(video.muted).toBe(true);
    expect(context.gain.gain.value).toBe(0.5);
    audio.setLevel(2);
    expect(PlaybackContext.instances).toHaveLength(1);
    expect(context.gain.gain.value).toBe(2);
    expect(audio.snapshot).toEqual({ level: 2, muted: false, boostAvailable: true });

    const nextTrack = audioTrack();
    stream.tracks = [nextTrack];
    audio.bind(stream as unknown as MediaStream);
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.sources[1].stream.tracks).toEqual([nextTrack]);
    audio.setMuted(true);
    expect(context.gain.gain.value).toBe(0);
    audio.setMuted(false);
    expect(context.gain.gain.value).toBe(2);
    video.paused = true;
    video.dispatchEvent(new Event("pause"));
    expect(context.gain.gain.value).toBe(0);
    audio.bind(null);
    expect(context.sources[1].disconnect).toHaveBeenCalledOnce();
    audio.bind(stream as unknown as MediaStream);
    expect(context.gain.gain.value).toBe(0);
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    expect(context.gain.gain.value).toBe(2);
    video.ended = true;
    video.dispatchEvent(new Event("ended"));
    expect(context.gain.gain.value).toBe(0);
    expect(video.srcObject).toBe(srcObject);
    for (const track of [firstTrack, nextTrack]) {
      expect(track.enabled).toBe(true);
      expect(track.stop).not.toHaveBeenCalled();
    }
    audio.useNativeControls();
    expect(audio.snapshot).toEqual({ level: 1, muted: false, boostAvailable: true });
    expect(video.muted).toBe(false);
    expect(context.sources[2].disconnect).toHaveBeenCalledOnce();
    video.volume = 0.65;
    video.muted = true;
    video.dispatchEvent(new Event("volumechange"));
    audio.resume();
    expect(audio.snapshot).toEqual({ level: 0.65, muted: true, boostAvailable: true });
    expect(PlaybackContext.instances).toHaveLength(1);
    audio.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("falls back to ordinary audio if starting the context fails", async () => {
    const video = new PlaybackVideo();
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, vi.fn());
    audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
    audio.setLevel(2);
    const context = PlaybackContext.instances[0];
    context.rejectResume();
    await Promise.resolve();
    expect(audio.snapshot).toEqual({ level: 1, muted: false, boostAvailable: false });
    expect(video.muted).toBe(false);
    expect(context.close).toHaveBeenCalledOnce();
    audio.setLevel(2);
    expect(PlaybackContext.instances).toHaveLength(1);
    expect(audio.snapshot.level).toBe(1);
    audio.setLevel(0);
    expect(video.muted).toBe(true);
    audio.setLevel(0.5);
    expect(video.muted).toBe(false);
    expect(audio.snapshot.level).toBe(0.5);
    expect(PlaybackContext.instances).toHaveLength(1);
    audio.dispose();
  });

  it("uses current preferences after resume and ignores completions after disposal", async () => {
    const video = new PlaybackVideo();
    const onChange = vi.fn();
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, onChange);
    audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
    audio.setLevel(2);
    const context = PlaybackContext.instances[0];
    audio.setLevel(0.4);
    audio.setMuted(true);
    const currentTrack = audioTrack();
    audio.bind(new AudioStream([currentTrack]) as unknown as MediaStream);
    context.start();
    await Promise.resolve();
    expect(audio.snapshot).toEqual({ level: 0.4, muted: true, boostAvailable: true });
    expect(context.gain.gain.value).toBe(0);
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.sources[1].stream.tracks).toEqual([currentTrack]);

    context.state = "suspended";
    context.pendingResume = new Promise<void>((resolve) => { context.resolveResume = resolve; });
    audio.resume();
    audio.dispose();
    video.volume = 0.75;
    video.muted = false;
    onChange.mockClear();
    context.start();
    await Promise.resolve();
    expect(video.volume).toBe(0.75);
    expect(video.muted).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
