import { playbackOutput } from "../src/client/media/playback-output";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerAudio, VoicePlaybackContext } from "../src/client/media/viewer-audio.ts";

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

  it("reports the usable voice output independently of local mute and a refused native sink", async () => {
    await playbackOutput.choose("headphones");
    let refused = true;
    const video = Object.assign(new PlaybackVideo(), {
      async setSinkId() { if (refused) throw Error("unavailable"); },
    });
    class VoiceContext extends PlaybackContext { async setSinkId() {} }
    vi.stubGlobal("AudioContext", VoiceContext);
    const ready = vi.fn();
    const audio = new ViewerAudio(video as unknown as HTMLAudioElement, vi.fn(), new VoicePlaybackContext(), 4, ready);
    try {
      audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
      await vi.waitFor(() => expect(playbackOutput.failedFor(video as unknown as HTMLAudioElement)).toBe(true));
      expect(ready).toHaveBeenLastCalledWith(false);
      audio.setLevel(2);
      PlaybackContext.instances[0].start();
      await vi.waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
      audio.setMuted(true);
      expect(ready).toHaveBeenLastCalledWith(true);
      audio.setLevel(1);
      expect(ready).toHaveBeenLastCalledWith(false);
      refused = false;
      await playbackOutput.choose("headphones");
      expect(ready).toHaveBeenLastCalledWith(true);
      expect(video.muted).toBe(true);
    } finally { audio.dispose(); await playbackOutput.choose(""); }
  });

  it("retains gain on its mute echo when the system ignores volume writes", () => {
    const video = new PlaybackVideo();
    Object.defineProperty(video, "volume", { get: () => 1, set: () => {} });
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, vi.fn());
    audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
    audio.setLevel(0.5);
    const context = PlaybackContext.instances[0];
    context.start();
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(true);
    video.dispatchEvent(new Event("volumechange"));
    expect(context.close).not.toHaveBeenCalled();
    expect(context.gain.gain.value).toBe(0.5);
    expect(audio.snapshot).toEqual({ level: 0.5, muted: false, boostAvailable: true });

    video.muted = false;
    video.dispatchEvent(new Event("volumechange"));
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(audio.snapshot).toEqual({ level: 1, muted: false, boostAvailable: true });
    expect(video.muted).toBe(false);
    audio.dispose();
  });

  it("hands boosted playback to native volume controls without leaving two audio outputs", () => {
    const video = new PlaybackVideo();
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, vi.fn());
    audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
    audio.setLevel(1.5);
    const context = PlaybackContext.instances[0];
    context.start();
    video.dispatchEvent(new Event("volumechange")); // The owner's queued native mute write.
    expect(context.close).not.toHaveBeenCalled();
    expect(context.gain.gain.value).toBe(1.5);

    // Chromium's PiP mute control writes the media element's muted property.
    video.muted = false;
    video.dispatchEvent(new Event("volumechange"));
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.gain.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(video.muted).toBe(false);
    expect(audio.snapshot).toEqual({ level: 1, muted: false, boostAvailable: true });
    video.muted = true;
    video.dispatchEvent(new Event("volumechange"));
    expect(audio.snapshot.muted).toBe(true);
    video.muted = false;
    video.dispatchEvent(new Event("volumechange"));
    expect(audio.snapshot.muted).toBe(false);

    audio.setLevel(1.5);
    PlaybackContext.instances[1].start();
    expect(video.muted).toBe(true);
    expect(PlaybackContext.instances[1].gain.gain.value).toBe(1.5);
    audio.dispose();
  });

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

  it("shares a lent context while muting and retiring each voice sink independently", () => {
    const voiceContext = new VoicePlaybackContext();
    const gains: PlaybackContext["gain"][] = [];
    const createGain = vi.spyOn(PlaybackContext.prototype, "createGain").mockImplementation(() => {
      const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain); return gain;
    });
    const elements = [new PlaybackVideo(), new PlaybackVideo(), new PlaybackVideo()];
    const outputs = elements.map(element => new ViewerAudio(element as unknown as HTMLAudioElement,
      vi.fn(), voiceContext, 4));
    outputs.forEach((output, index) => {
      output.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
      output.setLevel(index === 2 ? 1 : 2);
    });
    const context = PlaybackContext.instances[0];
    context.start();
    expect(PlaybackContext.instances).toHaveLength(1);
    expect(gains.map(gain => gain.gain.value)).toEqual([2, 2]);
    expect(elements.map(element => element.muted)).toEqual([true, true, false]);
    outputs[0].setLevel(4);
    expect(gains.map(gain => gain.gain.value)).toEqual([4, 2]);
    outputs[0].setMuted(true);
    expect(gains.map(gain => gain.gain.value)).toEqual([0, 2]);
    outputs[0].dispose();
    expect(gains[0].disconnect).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    outputs[1].setLevel(0);
    expect(gains[1].gain.value).toBe(0);
    outputs[1].setLevel(1.5);
    expect(gains[1].gain.value).toBe(1.5);
    outputs[1].dispose(); // The last adjusted speaker leaves; another room still plays natively.
    expect(context.close).toHaveBeenCalledOnce();
    expect(elements[2].muted).toBe(false);
    outputs[2].setLevel(.5);
    expect(PlaybackContext.instances).toHaveLength(2);
    outputs[2].setLevel(1);
    expect(PlaybackContext.instances[1].close).toHaveBeenCalledOnce();
    outputs[2].dispose();
    createGain.mockRestore();
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

  it.each(["absent", "failed"])("restores zero volume when the audio context is %s", (state) => {
    vi.stubGlobal("AudioContext", state === "absent" ? undefined : class {
      constructor() { throw new DOMException("Audio unavailable", "NotSupportedError"); }
    });
    const video = new PlaybackVideo();
    const audio = new ViewerAudio(video as unknown as HTMLVideoElement, vi.fn());
    audio.setLevel(0);
    // HTMLMediaElement queues this for both volume and muted writes.
    video.dispatchEvent(new Event("volumechange"));
    audio.setLevel(0.5);
    video.dispatchEvent(new Event("volumechange"));
    expect(audio.snapshot).toEqual({ level: 0.5, muted: false, boostAvailable: false });
    expect(video.muted).toBe(false);
    audio.setMuted(true);
    audio.setLevel(0);
    video.dispatchEvent(new Event("volumechange"));
    audio.setLevel(0.5);
    video.dispatchEvent(new Event("volumechange"));
    expect(audio.snapshot.muted).toBe(true);
    expect(video.muted).toBe(true);
    audio.dispose();
  });
});

it("waits for the selected output before enabling playback gain", async () => {
  let complete!: () => void;
  class DelayedContext extends PlaybackContext {
    setSinkId() { return new Promise<void>(resolve => { complete = resolve; }); }
  }
  vi.stubGlobal("AudioContext", DelayedContext);
  vi.stubGlobal("MediaStream", AudioStream);
  await playbackOutput.choose("headphones");
  const audio = new ViewerAudio(new PlaybackVideo() as unknown as HTMLVideoElement, vi.fn());
  try {
    audio.bind(new AudioStream([audioTrack()]) as unknown as MediaStream);
    audio.setLevel(1.5);
    const context = PlaybackContext.instances.at(-1)!;
    context.start();
    await vi.waitFor(() => expect(complete).toBeDefined());
    expect(context.gain.gain.value).toBe(0);
    complete();
    await vi.waitFor(() => expect(context.gain.gain.value).toBe(1.5));
  } finally { complete?.(); audio.dispose(); await playbackOutput.choose(""); vi.unstubAllGlobals(); }
});
