import { afterEach, expect, test, vi } from "vitest";
import { FeedbackAudio } from "../src/client/channel/feedback-audio";

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
}

afterEach(() => { AudioBoundary.instances = []; vi.unstubAllGlobals(); });

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
