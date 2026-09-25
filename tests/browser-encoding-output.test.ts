import { afterEach, expect, it, vi } from "vitest";
import { BrowserEncodingOutput } from "../src/client/media/browser-encoding-output";

afterEach(() => vi.unstubAllGlobals());

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
