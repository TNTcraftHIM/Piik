import { afterEach, expect, test, vi } from "vitest";
import { FeedbackAudio } from "../src/client/channel/feedback-audio";
import { validateCustomFeedbackClip } from "../src/client/channel/feedback-clip";

class OscillatorBoundary {
  type = "sine";
  frequency = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  connect() {}
  disconnect() {}
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}

class AudioBoundary {
  static instances: AudioBoundary[] = [];
  state = "suspended";
  currentTime = 0;
  onstatechange: (() => void) | null = null;
  destination = {};
  oscillators: OscillatorBoundary[] = [];
  buffers: { buffer?: AudioBuffer; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect(): void; disconnect(): void; onended?: () => void }[] = [];
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({ duration: .2 }) as AudioBuffer);
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { AudioBoundary.instances.push(this); }
  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
  }
  createOscillator() {
    const oscillator = new OscillatorBoundary();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createBufferSource() {
    const source = { buffer: undefined as AudioBuffer | undefined, start: vi.fn(), stop: vi.fn(), connect() {}, disconnect() {} };
    this.buffers.push(source); return source;
  }
}

afterEach(() => { AudioBoundary.instances = []; vi.unstubAllGlobals(); });

test("an unreadable feedback sound reports that the selected file could not be opened", async () => {
  const file = new File(["audio"], "clip.wav");
  Object.defineProperty(file, "arrayBuffer", { value: async () => { throw new DOMException("", "NotReadableError"); } });
  await expect(validateCustomFeedbackClip(file)).rejects.toThrow("feedback_clip_invalid");
});

test("feedback requires activation, bounds active sound and releases mute/close resources", async () => {
  const document = new EventTarget();
  vi.stubGlobal("document", document); vi.stubGlobal("AudioContext", AudioBoundary);
  const audio = new FeedbackAudio();
  audio.configure({ enabled: false, volume: 1 }); audio.play("message");
  expect(AudioBoundary.instances).toHaveLength(0);
  audio.configure({ enabled: true, volume: .5 }); audio.play("message");
  expect(AudioBoundary.instances).toHaveLength(0);
  document.dispatchEvent(new Event("pointerdown"));
  await Promise.resolve();
  const context = AudioBoundary.instances[0];
  audio.play("message"); audio.play("throw");
  expect(context.oscillators).toHaveLength(2);
  for (const node of context.oscillators) node.onended?.();
  audio.play("throw");
  expect(context.oscillators).toHaveLength(3);
  context.state = "suspended"; context.onstatechange?.();
  audio.play("message");
  expect(context.oscillators).toHaveLength(3);
  expect(context.oscillators[2].stop).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event("pointerdown")); await Promise.resolve();
  expect(context.state).toBe("running");
  expect(context.oscillators).toHaveLength(3);
  audio.configure({ enabled: true, volume: 0 });
  expect(context.close).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("pointerdown")); audio.play("message");
  expect(AudioBoundary.instances).toHaveLength(1);
  audio.configure({ enabled: true, volume: 1 });
  document.dispatchEvent(new Event("keydown")); await Promise.resolve();
  expect(AudioBoundary.instances).toHaveLength(2);
  audio.close();
  expect(AudioBoundary.instances[1].close).toHaveBeenCalledOnce();
});

test("custom sound decoding cannot queue notifications or overwrite a replacement/closed owner", async () => {
  vi.stubGlobal("document", new EventTarget()); vi.stubGlobal("AudioContext", AudioBoundary);
  const audio = new FeedbackAudio(), first = { name: "first.wav", data: "YQ==" }, second = { name: "second.wav", data: "Yg==" };
  audio.configure({ enabled: true, volume: 1 }); audio.activate(); await Promise.resolve();
  const context = AudioBoundary.instances[0];
  let finishFirst!: (buffer: AudioBuffer) => void, finishSecond!: (buffer: AudioBuffer) => void;
  context.decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  audio.configure({ enabled: true, volume: 1, clips: { message: first } });
  audio.play("message"); audio.preview("message"); await Promise.resolve();
  expect(context.buffers).toHaveLength(0);
  audio.configure({ enabled: true, volume: 1, clips: { message: second } });
  const oldBuffer = { duration: .2 } as AudioBuffer, newBuffer = { duration: .3 } as AudioBuffer;
  finishFirst(oldBuffer); await Promise.resolve(); await Promise.resolve();
  expect(context.buffers).toHaveLength(0);
  finishSecond(newBuffer); await Promise.resolve(); await Promise.resolve();
  expect(context.buffers).toHaveLength(0);
  audio.play("message"); expect(context.buffers[0].buffer).toBe(newBuffer);
  audio.configure({ enabled: true, volume: 1, clips: { message: first } });
  expect(context.buffers[0].stop).toHaveBeenCalledOnce();
  audio.preview("message"); audio.close(); await Promise.resolve(); await Promise.resolve();
  expect(context.buffers).toHaveLength(1); expect(context.close).toHaveBeenCalledOnce();
});

test("a pending preview cannot play after mute and a later activation", async () => {
  vi.stubGlobal("document", new EventTarget()); vi.stubGlobal("AudioContext", AudioBoundary);
  const audio = new FeedbackAudio();
  audio.configure({ enabled: true, volume: 1 }); audio.activate();
  const first = AudioBoundary.instances[0];
  let resume!: () => void;
  first.resume.mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
  audio.preview();
  audio.configure({ enabled: false, volume: 1 });
  audio.configure({ enabled: true, volume: 1 }); audio.activate();
  resume(); await Promise.resolve(); await Promise.resolve();
  expect(first.oscillators).toHaveLength(0);
  expect(AudioBoundary.instances[1].oscillators).toHaveLength(0);
  audio.play("message");
  expect(AudioBoundary.instances[1].oscillators).toHaveLength(2);
  audio.close();
});

test("suspension drops a pending preview while a new preview reuses the decoded sound", async () => {
  vi.stubGlobal("document", new EventTarget()); vi.stubGlobal("AudioContext", AudioBoundary);
  const audio = new FeedbackAudio();
  audio.configure({ enabled: true, volume: 1 }); audio.activate(); await Promise.resolve();
  const context = AudioBoundary.instances[0];
  let finishDecode!: (buffer: AudioBuffer) => void;
  context.decodeAudioData.mockImplementationOnce(() => new Promise(resolve => { finishDecode = resolve; }));
  audio.configure({ enabled: true, volume: 1, clips: { message: { name: "message.wav", data: "YQ==" } } });
  audio.preview("message"); await Promise.resolve();
  context.state = "suspended"; context.onstatechange?.();
  audio.activate(); await Promise.resolve();
  finishDecode({ duration: .2 } as AudioBuffer);
  await Promise.resolve(); await Promise.resolve();
  expect(context.buffers).toHaveLength(0);
  audio.preview("message");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(context.buffers).toHaveLength(1);
  expect(context.decodeAudioData).toHaveBeenCalledOnce();
  expect(AudioBoundary.instances).toHaveLength(1);
  audio.close();
});

test("muting a cue stops only that cue and cancels its pending preview", async () => {
  vi.stubGlobal("document", new EventTarget()); vi.stubGlobal("AudioContext", AudioBoundary);
  const audio = new FeedbackAudio();
  const prefs = { enabled: true, volume: .4 };
  audio.configure(prefs); audio.activate(); await Promise.resolve();
  const context = AudioBoundary.instances[0];
  audio.play("throw");
  const throwNode = context.oscillators[0];
  audio.configure({ ...prefs, muted: { message: true } });
  expect(throwNode.stop).toHaveBeenCalledTimes(1);
  audio.configure({ ...prefs, muted: { throw: true } });
  expect(throwNode.stop).toHaveBeenCalledTimes(2);
  audio.play("throw"); audio.preview("throw");
  audio.preview("message");
  audio.configure({ ...prefs, muted: { message: true } });
  audio.configure(prefs);
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(context.oscillators).toHaveLength(1);
  audio.play("message");
  expect(context.oscillators).toHaveLength(3);
  audio.close();
});
