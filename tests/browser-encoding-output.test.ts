import { afterEach, expect, it, vi } from "vitest";
import { BrowserEncodingOutput } from "../src/client/media/browser-encoding-output";

const outputs: BrowserEncodingOutput[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) output.dispose();
  vi.unstubAllGlobals();
});

function frame(width: number, height: number, type: RTCEncodedVideoFrame["type"] = "key"): RTCEncodedVideoFrame {
  return { type, timestamp: 123, data: new ArrayBuffer(1), getMetadata: () => ({ width, height }) } as RTCEncodedVideoFrame;
}

function liveOutput() {
  vi.stubGlobal("document", { createElement: () => ({
    getContext: () => ({ fillRect: () => undefined }),
    captureStream: () => ({ getVideoTracks: () => [{ stop: vi.fn(), requestFrame: vi.fn() }] }),
  }) });
  vi.stubGlobal("RTCEncodedVideoFrame", class {
    readonly data: ArrayBuffer;
    readonly type: RTCEncodedVideoFrame["type"];
    readonly timestamp: number;
    constructor(private readonly frame: RTCEncodedVideoFrame, options?: { metadata: { rtpTimestamp: number } }) {
      this.data = frame.data.slice(0); this.type = frame.type;
      this.timestamp = options?.metadata.rtpTimestamp ?? frame.timestamp;
    }
    getMetadata() { return this.frame.getMetadata(); }
  });
  const carrier = new TransformStream<RTCEncodedVideoFrame>();
  const write = vi.fn<(_frame: RTCEncodedVideoFrame) => void | Promise<void>>(() => undefined), failure = vi.fn();
  const output = new BrowserEncodingOutput({ createEncodedStreams: () => ({
    readable: carrier.readable, writable: new WritableStream({ write }),
  }) } as unknown as RTCRtpSender, failure, {});
  outputs.push(output);
  const writer = carrier.writable.getWriter();
  return { output, write, failure, receive: async (value: RTCEncodedVideoFrame) => {
    await writer.write(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } };
}

it("rejects a regressed recovery frame before writing or replacing the healthy output", async () => {
  const { output, write, receive, failure } = liveOutput();
  const requestKey = vi.fn(async () => undefined), selected = vi.fn();
  output.select("current", requestKey, () => undefined, () => true);
  output.push("current", frame(1280, 720));
  await receive(frame(16, 16));

  const accept = vi.fn((metadata: RTCEncodedVideoFrameMetadata) => metadata.height! >= 720);
  output.select("candidate", requestKey, selected, accept);
  output.push("candidate", frame(960, 540));
  output.push("current", frame(1280, 720, "delta"));
  await receive(frame(16, 16, "delta"));
  expect(accept).toHaveBeenCalledWith({ width: 960, height: 540 });
  expect(selected).not.toHaveBeenCalled();
  expect(write.mock.calls.map(([value]) => value.getMetadata().height)).toEqual([720, 720]);
  expect(output.snapshot().lastProducerId).toBe("current");

  // A rejected pending producer cannot revive itself on its next key.
  output.push("candidate", frame(1920, 1080));
  output.push("current", frame(1280, 720, "delta"));
  await receive(frame(16, 16, "delta"));
  expect(accept).toHaveBeenCalledOnce();
  expect(write.mock.calls.map(([value]) => value.getMetadata().height)).toEqual([720, 720, 720]);
  expect(failure).not.toHaveBeenCalled();
});

it.each([false, true])("preserves the ordinary stream's recovery boundary after rejection (started=%s)", async (started) => {
  const { output, write, receive, failure } = liveOutput();
  const requestKey = vi.fn(async () => undefined), selected = vi.fn();
  output.passthrough(requestKey);
  if (started) await receive(frame(1280, 720));
  output.select("candidate", requestKey, selected, () => false);
  output.push("candidate", frame(960, 540));
  const delta = frame(1280, 720, "delta");
  await receive(delta);
  expect(write.mock.calls.map(([value]) => value.type)).toEqual(started ? ["key", "delta"] : []);
  if (started) expect(write.mock.lastCall?.[0]).toBe(delta);
  await receive(frame(1280, 720));
  expect(output.snapshot().lastProducerId).toBeNull();
  expect(selected).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
});

it("still recovers the current stream when a carrier key cannot use the rejected candidate", async () => {
  const { output, write, receive, failure } = liveOutput();
  const requestCurrentKey = vi.fn(async () => undefined);
  output.select("current", requestCurrentKey, () => undefined, () => true);
  output.push("current", frame(1280, 720));
  await receive(frame(16, 16));
  requestCurrentKey.mockClear();

  output.select("candidate", async () => undefined, () => undefined, () => false);
  output.push("candidate", frame(960, 540));
  output.push("current", frame(1280, 720, "delta"));
  await receive(frame(16, 16));
  expect(requestCurrentKey).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledOnce();
  output.push("current", frame(1280, 720));
  await receive(frame(16, 16, "delta"));
  expect(write.mock.calls.map(([value]) => value.type)).toEqual(["key", "key"]);
  expect(failure).not.toHaveBeenCalled();
});

it.each([false, true])("retains the newest clock and recovery across a pending write (accepted=%s)", async (accepted) => {
  const { output, write, receive, failure } = liveOutput();
  const requestKey = vi.fn(async () => undefined);
  output.select("current", requestKey, () => undefined, () => true);
  output.push("current", frame(1280, 720));
  await receive(frame(16, 16));
  requestKey.mockClear();
  let complete!: () => void;
  write.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  output.push("current", frame(1280, 720, "delta"));
  await receive(frame(16, 16, "delta"));
  output.select("candidate", async () => undefined, () => undefined, () => accepted);
  output.push("candidate", frame(960, 540));
  output.push("current", frame(1280, 720, "delta"));
  await receive(frame(16, 16));
  await receive({ ...frame(16, 16, "delta"), timestamp: 456 });
  complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (accepted) {
    expect(requestKey).not.toHaveBeenCalled();
    expect(output.snapshot().lastProducerId).toBe("candidate");
  } else {
    expect(requestKey).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
    output.push("current", frame(1280, 720));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(write.mock.lastCall?.[0].timestamp).toBe(456);
  expect(write.mock.lastCall?.[0].type).toBe("key");
  expect(failure).not.toHaveBeenCalled();
});

it.each(["streams", "writer"])("releases its carrier when %s initialization fails", (stage) => {
  const track = { stop: vi.fn(), contentHint: "" };
  vi.stubGlobal("document", { createElement: () => ({
    getContext: () => ({}), captureStream: () => ({ getVideoTracks: () => [track] }),
  }) });
  const failure = new DOMException("Already acquired", "InvalidStateError");
  const sender = { createEncodedStreams: () => {
    if (stage === "streams") throw failure;
    return { writable: { getWriter: () => { throw failure; } } };
  } } as unknown as RTCRtpSender;
  const onFailure = vi.fn();
  expect(() => new BrowserEncodingOutput(sender, onFailure, {})).toThrow(failure);
  expect(track.stop).toHaveBeenCalledOnce();
  // Construction has no live owner yet; start()'s caller handles its rejection.
  expect(onFailure).not.toHaveBeenCalled();
});

it("finishes an accepted selection after pause without rejecting its ownership again", async () => {
  const { output, write, receive, failure } = liveOutput();
  const requestKey = vi.fn(async () => undefined), selected = vi.fn();
  const accept = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  let complete!: () => void;
  write.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  output.select("candidate", requestKey, selected, accept);
  output.push("candidate", frame(1280, 720));
  await receive(frame(16, 16));
  output.setPaused(true);
  complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selected).not.toHaveBeenCalled();
  output.setPaused(false);
  output.push("candidate", frame(1280, 720));
  await receive(frame(16, 16));
  expect(accept).toHaveBeenCalledOnce();
  expect(selected).toHaveBeenCalledOnce();
  expect(output.snapshot().lastProducerId).toBe("candidate");
  expect(failure).not.toHaveBeenCalled();
});

it.each([false, true])("cancels only a selection whose key has not started writing (writing=%s)", async (writing) => {
  const { output, write, receive, failure } = liveOutput();
  const requestKey = vi.fn(async () => undefined), selected = vi.fn();
  output.select("current", requestKey, () => undefined, () => true);
  output.push("current", frame(1280, 720));
  await receive(frame(16, 16));
  output.select("candidate", requestKey, selected, () => true);
  output.push("candidate", frame(1280, 720));
  let complete!: () => void;
  if (writing) {
    write.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await receive(frame(16, 16));
  }
  const cancelled = output.cancelSelection("candidate");
  if (writing) complete();
  else {
    output.push("candidate", frame(1280, 720));
    output.push("current", frame(1280, 720, "delta"));
  }
  await receive(frame(16, 16, "delta"));
  expect(cancelled).toBe(!writing);
  expect(selected).toHaveBeenCalledTimes(writing ? 1 : 0);
  expect(output.snapshot().lastProducerId).toBe(writing ? "candidate" : "current");
  expect(failure).not.toHaveBeenCalled();
});
