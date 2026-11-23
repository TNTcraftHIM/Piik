import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeDecodedFrameProof } from "../src/client/media/decoded-frame-proof";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const report = (framesDecoded: number) => [{ id: "video", framesDecoded }];

describe("decoded frame proof observer", () => {
  it("accepts the first cumulative frame on a fresh exact transport", async () => {
    const readFramesDecoded = vi
      .fn<() => Promise<ReturnType<typeof report>>>()
      .mockResolvedValueOnce(report(0))
      .mockResolvedValueOnce(report(1));
    const onProof = vi.fn(() => true);

    observeDecodedFrameProof({
      readFramesDecoded,
      owns: () => true,
      onProof,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(readFramesDecoded).toHaveBeenCalledTimes(2);
    expect(onProof).toHaveBeenCalledOnce();
  });

  it("requires growth beyond a post-resume baseline", async () => {
    const values = [7, 7, 8];
    const onProof = vi.fn(() => true);

    observeDecodedFrameProof({
      readFramesDecoded: async () => report(values.shift() ?? 8),
      owns: () => true,
      requireProgress: true,
      onProof,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onProof).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onProof).toHaveBeenCalledOnce();
  });

  it("proves a new SSRC after the first receiver snapshot without counting a formerly missing field", async () => {
    const old = { id: "old", framesDecoded: 100 };
    const samples = [
      [old, { id: "unknown", framesDecoded: null }],
      [old, { id: "unknown", framesDecoded: 50 }],
      [{ id: "new", framesDecoded: 1 }],
    ];
    const onProof = vi.fn(() => true);
    observeDecodedFrameProof({
      owns: () => true,
      requireProgress: true,
      readFramesDecoded: async () => samples.shift() ?? [],
      onProof,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onProof).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onProof).toHaveBeenCalledOnce();
  });

  it("accepts the first decoded frame after an empty receiver snapshot", async () => {
    const onProof = vi.fn(() => true);
    observeDecodedFrameProof({
      owns: () => true,
      requireProgress: true,
      readFramesDecoded: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(report(1)),
      onProof,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(onProof).toHaveBeenCalledOnce();
  });

  it("serializes reads and ignores an in-flight result after ownership ends", async () => {
    const first = deferred<ReturnType<typeof report>>();
    let owned = true;
    const readFramesDecoded = vi.fn(() => first.promise);
    const onProof = vi.fn(() => true);
    const stop = observeDecodedFrameProof({
      readFramesDecoded,
      owns: () => owned,
      onProof,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(readFramesDecoded).toHaveBeenCalledOnce();
    owned = false;
    stop();
    first.resolve(report(3));
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(onProof).not.toHaveBeenCalled();
    expect(readFramesDecoded).toHaveBeenCalledOnce();
  });
});
