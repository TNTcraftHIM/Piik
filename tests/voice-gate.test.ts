import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophoneInput } from "../src/client/media/microphone-input";
import {
  closedVoiceGate, dbfsFromLevel, levelFromDbfs, PUSH_TO_TALK_RELEASE_SECONDS, retuneVoiceGate, SPEAKING_LEVEL,
  VOICE_ACTIVATION_HOLD_SECONDS, VOICE_GATE_PROCESSOR, voiceGateUntil, type VoiceGate, type VoiceGateSettings,
} from "../src/client/media/voice-gate";

afterEach(() => vi.unstubAllGlobals());

/** Advances the gate by one render quantum and reports whether that quantum passes audio. */
function step(gate: VoiceGate, level: number, now: number): boolean {
  gate.until = voiceGateUntil(gate, level, now);
  return now < gate.until;
}

const push = (pressed: boolean): VoiceGateSettings => ({ mode: "push", threshold: SPEAKING_LEVEL, pressed });
const activity = (threshold = SPEAKING_LEVEL): VoiceGateSettings => ({ mode: "activity", threshold, pressed: false });

describe("voice gate rules", () => {
  it("keeps one speaking level of -40 dBFS", () => {
    expect(SPEAKING_LEVEL).toBe(.01);
    expect(dbfsFromLevel(levelFromDbfs(-25))).toBeCloseTo(-25);
  });

  it("opens push to talk on press and closes it after the release delay, whatever the level", () => {
    let gate = retuneVoiceGate(closedVoiceGate, push(false));
    expect(step(gate, 1, 1)).toBe(false);
    gate = retuneVoiceGate(gate, push(true));
    expect(step(gate, 0, 2)).toBe(true);
    expect(step(gate, 0, 3)).toBe(true);
    gate = retuneVoiceGate(gate, push(false));
    expect(step(gate, 1, 3 + PUSH_TO_TALK_RELEASE_SECONDS - .01)).toBe(true);
    expect(step(gate, 1, 3 + PUSH_TO_TALK_RELEASE_SECONDS)).toBe(false);
    expect(step(gate, 1, 10)).toBe(false);
  });

  it("opens voice activation at the threshold and holds it across short pauses", () => {
    const gate = retuneVoiceGate(closedVoiceGate, activity());
    expect(step(gate, SPEAKING_LEVEL / 2, 1)).toBe(false);
    expect(step(gate, SPEAKING_LEVEL, 2)).toBe(true);
    expect(step(gate, 0, 2 + VOICE_ACTIVATION_HOLD_SECONDS / 2)).toBe(true);
    expect(step(gate, SPEAKING_LEVEL * 2, 2.2)).toBe(true);
    expect(step(gate, 0, 2.2 + VOICE_ACTIVATION_HOLD_SECONDS - .01)).toBe(true);
    expect(step(gate, 0, 2.2 + VOICE_ACTIVATION_HOLD_SECONDS)).toBe(false);
    // The talk key means nothing to voice activation.
    const held = retuneVoiceGate(gate, { ...activity(), pressed: true });
    expect(step(held, 0, 5)).toBe(false);
  });

  it("starts a different mode closed but keeps a hold through a change within the mode", () => {
    let gate = retuneVoiceGate(closedVoiceGate, push(true));
    expect(step(gate, 0, 1)).toBe(true);
    gate = retuneVoiceGate(gate, activity());
    expect(step(gate, 0, 1.05)).toBe(false);
    expect(step(gate, 1, 2)).toBe(true);
    gate = retuneVoiceGate(gate, activity(levelFromDbfs(-20)));
    expect(step(gate, 0, 2.1)).toBe(true);
    expect(step(gate, levelFromDbfs(-30), 2.5)).toBe(false);
    gate = retuneVoiceGate(gate, push(false));
    expect(step(gate, 1, 2.6)).toBe(false);
  });
});

class GateNode {
  static nodes: GateNode[] = [];
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  constructor(_context: unknown, readonly name: string, readonly options: AudioWorkletNodeOptions) { GateNode.nodes.push(this); }
}

function microphone(addModule = vi.fn(async () => {})) {
  GateNode.nodes = [];
  vi.stubGlobal("AudioWorkletNode", GateNode);
  const node = () => ({ channelCount: 1, channelCountMode: "max", connect: vi.fn(), disconnect: vi.fn() });
  const track = { id: "track", kind: "audio", readyState: "live", enabled: true, contentHint: "", onended: null, stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const gain = { ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } };
  const destination = { ...node(), stream };
  const analyser = { ...node(), fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(.5) };
  const context = { state: "running", sampleRate: 48000, currentTime: 0, audioWorklet: { addModule },
    createGain: () => gain, createAnalyser: () => analyser, createMediaStreamSource: vi.fn(node),
    createMediaStreamDestination: () => destination, close: vi.fn(async () => {}) };
  const input = new MicrophoneInput(stream, context as unknown as AudioContext, 1, vi.fn());
  return { input, gain, destination, analyser, addModule };
}

async function ready(index = 0) {
  await vi.waitFor(() => expect(GateNode.nodes[index]?.port.onmessage).toBeTypeOf("function"));
  const node = GateNode.nodes[index]!;
  node.port.onmessage!({ data: "ready" });
  return node;
}

describe("microphone gate", () => {
  it("leaves open microphone exactly as the graph was, without loading a worklet", async () => {
    const { input, gain, destination, analyser, addModule } = microphone();
    expect(gain.connect.mock.calls).toEqual([[destination], [analyser]]);
    await input.gate("open");
    input.press(true);
    input.threshold(-20);
    expect(addModule).not.toHaveBeenCalled();
    expect(GateNode.nodes).toHaveLength(0);
    expect(gain.disconnect).not.toHaveBeenCalled();
    expect(input.transmitting).toBe(true);
    expect(input.level()).toBe(.5);
    input.close();
  });

  it("puts the gate after the gain and before the output, with the meter still reading before it", async () => {
    const { input, gain, destination, analyser } = microphone();
    input.threshold(-30);
    const gating = input.gate("push");
    const node = await ready();
    await gating;
    expect(node.name).toBe(VOICE_GATE_PROCESSOR);
    expect(node.connect).toHaveBeenCalledWith(destination);
    expect(gain.connect).toHaveBeenLastCalledWith(node);
    expect(gain.disconnect).toHaveBeenCalledWith(destination);
    expect(gain.disconnect).not.toHaveBeenCalledWith(analyser);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ mode: "push", threshold: levelFromDbfs(-30), pressed: false });
    expect(input.transmitting).toBe(false);
    expect(input.level()).toBe(.5);

    input.press(true);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ mode: "push", threshold: levelFromDbfs(-30), pressed: true });
    node.port.onmessage!({ data: true });
    expect(input.transmitting).toBe(true);
    node.port.onmessage!({ data: false });
    expect(input.transmitting).toBe(false);

    // Another gated mode reuses the gate and starts released.
    await input.gate("activity");
    expect(GateNode.nodes).toHaveLength(1);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ mode: "activity", threshold: levelFromDbfs(-30), pressed: false });
    input.threshold(-50);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ mode: "activity", threshold: levelFromDbfs(-50), pressed: false });

    await input.gate("open");
    expect(gain.connect).toHaveBeenLastCalledWith(destination);
    expect(gain.disconnect).toHaveBeenLastCalledWith(node);
    expect(node.port.postMessage).toHaveBeenLastCalledWith("close");
    expect(node.port.close).toHaveBeenCalledOnce();
    expect(input.transmitting).toBe(true);
    input.close();
  });

  it("fails closed when the gate cannot load, leaving the output unchanged for its owner to retire", async () => {
    const { input, gain } = microphone(vi.fn(async () => { throw new Error("module failed"); }));
    await expect(input.gate("activity")).rejects.toThrow("voice_gate_failed");
    expect(gain.disconnect).not.toHaveBeenCalled();
    expect(GateNode.nodes).toHaveLength(0);
    input.close();
  });

  it("retires a gate that is still starting when the microphone closes, and reports a failed processor once committed", async () => {
    const { input } = microphone();
    const gating = input.gate("push");
    await vi.waitFor(() => expect(GateNode.nodes).toHaveLength(1));
    input.close();
    await expect(gating).rejects.toMatchObject({ name: "AbortError" });
    expect(GateNode.nodes[0]!.port.postMessage).toHaveBeenLastCalledWith("close");

    const next = microphone();
    const failed = vi.fn();
    next.input.onProcessingError = failed;
    const committing = next.input.gate("push");
    const node = await ready();
    await committing;
    node.onprocessorerror!();
    expect(failed).toHaveBeenCalledWith("voice_gate_failed");
    next.input.close();
  });
});
