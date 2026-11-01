import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneSenderVideoTrack, senderCaptureTrack, stopSenderVideoTrack } from "../src/client/media/sender-video-track";
import { applyVideoCaptureProfile, configureVideoSender, QUALITY_PROFILES } from "../src/client/media/quality";
import { captureMetrics } from "../src/client/webrtc/stats";

class Track extends EventTarget {
  readonly kind = "video";
  enabled = true;
  contentHint = "motion";
  readyState = "live";
  settings: MediaTrackSettings = { displaySurface: "browser", width: 1920, height: 1080 };
  readonly stop = vi.fn(() => { this.readyState = "ended"; });
  readonly applyConstraints = vi.fn(async (_constraints: MediaTrackConstraints) => undefined);
  getSettings() { return this.settings; }
  getConstraints() { return { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } }; }
  getCapabilities() { return { width: { min: 1, max: 1920 } }; }
  clone = vi.fn(() => {
    const clone = new Track();
    clone.settings = { ...this.settings };
    clone.enabled = this.enabled;
    return clone;
  });
}
const asTrack = (track: Track) => track as unknown as MediaStreamTrack;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const owned: MediaStreamTrack[] = [];
afterEach(async () => {
  owned.splice(0).forEach(stopSenderVideoTrack);
  await flush();
  vi.unstubAllGlobals();
});

function platform() {
  const cancel = vi.fn(), write = vi.fn();
  let frames!: ReadableStreamDefaultController<VideoFrame>;
  const processor = vi.fn(function () {
    return { readable: new ReadableStream<VideoFrame>({ start(c) { frames = c; }, cancel }) };
  });
  class Generator extends Track {
    static instances: Generator[] = [];
    override settings = {};
    writable = new WritableStream<VideoFrame>({ write(frame) { write(frame); frame.close(); } });
    constructor() { super(); Generator.instances.push(this); }
  }
  vi.stubGlobal("MediaStreamTrackProcessor", processor);
  vi.stubGlobal("MediaStreamTrackGenerator", Generator);
  return { cancel, write, processor, frames: () => frames, Generator };
}
function clone(source: Track, onEnded = vi.fn()) {
  const track = cloneSenderVideoTrack(asTrack(source), onEnded);owned.push(track);return track;
}

describe("sender display-frame ownership", () => {
  it("cancels a quiet input on retirement without stopping the shared source", async () => {
    const p = platform(), source = new Track();
    source.enabled = false;
    const ended = vi.fn(), track = clone(source, ended), input = source.clone.mock.results[0]!.value;
    expect(track.enabled).toBe(false);
    expect(input.enabled).toBe(true);
    expect(senderCaptureTrack(track)).toBe(input);
    expect(p.processor).toHaveBeenCalledWith({ track: input, maxBufferSize: 1 });
    expect(input.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ frameRate: { min: 1, ideal: 30, max: 30 } }));
    stopSenderVideoTrack(track);
    expect(input.readyState).toBe("ended");
    expect(track.readyState).toBe("ended");
    await flush();
    expect(p.cancel).toHaveBeenCalledOnce();
    expect(source.readyState).toBe("live");
    expect(source.stop).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("forwards frames unchanged and leaves profile constraints with the capture input", async () => {
    const p = platform(), source = new Track(), track = clone(source);
    const input = source.clone.mock.results[0]!.value;
    const frame = { close: vi.fn(), timestamp: 123, displayWidth: 1920, displayHeight: 1080 } as unknown as VideoFrame;
    p.frames().enqueue(frame);
    await flush();
    expect(p.write).toHaveBeenCalledWith(frame);
    expect(frame.close).toHaveBeenCalledOnce();
    await applyVideoCaptureProfile(track, QUALITY_PROFILES["720p30"]);
    expect(input.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ width: { max: 1280 } }));
    expect(input.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({ frameRate: { min: 1, ideal: 30, max: 30 } }));
    expect((track as unknown as Track).applyConstraints).not.toHaveBeenCalled();

    // Generated-track settings can lag by a frame. Do not apply the profile's
    // scale twice after the input accepted a smaller capture size.
    input.settings = { displaySurface: "browser", width: 1280, height: 720 };
    (track as unknown as Track).settings = { width: 1920, height: 1080 };
    expect(captureMetrics(track)).toEqual({ captureWidth: 1280, captureHeight: 720, captureFramesPerSecond: null });
    let parameters = { encodings: [{}] } as RTCRtpSendParameters;
    const sender = { track, getParameters: () => parameters, setParameters: async (next: RTCRtpSendParameters) => { parameters = next; } };
    await configureVideoSender(sender as unknown as RTCRtpSender, QUALITY_PROFILES["720p30"]);
    expect(parameters.encodings[0]!.scaleResolutionDownBy).toBe(1);
  });

  it.each(["ended", "failed"])("retires the generated output when its input %s", async (end) => {
    const p = platform(), source = new Track(), ended = vi.fn(), track = clone(source, ended);
    if (end === "ended") p.frames().close();
    else p.frames().error(new Error("capture ended unexpectedly"));
    await flush();
    expect(track.readyState).toBe("ended");
    expect(source.clone.mock.results[0]!.value.readyState).toBe("ended");
    expect(source.readyState).toBe("live");
    expect(ended).toHaveBeenCalledExactlyOnceWith(track);
  });

  it("keeps camera and received tracks on the ordinary clone path", () => {
    const p = platform(), source = new Track();source.settings = { width: 640, height: 480 };
    expect(clone(source)).toBe(source.clone.mock.results[0]!.value);
    expect(p.processor).not.toHaveBeenCalled();
  });

  it("normalizes only oriented shared frames and releases their snapshots", async () => {
    const p = platform(), source = new Track();source.settings = { width: 640, height: 480 };
    class Frame {
      readonly close = vi.fn();
      get rotation() { return 0; }
      get flip() { return false; }
      constructor(readonly bitmap: ImageBitmap, readonly init: VideoFrameInit) {}
    }
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const snapshot = vi.fn(async () => bitmap);
    vi.stubGlobal("VideoFrame", Frame);
    vi.stubGlobal("createImageBitmap", snapshot);
    const track = cloneSenderVideoTrack(asTrack(source), vi.fn(), { normalizeOrientation: true });owned.push(track);
    const input = source.clone.mock.results[0]!.value;
    expect(input.applyConstraints).toHaveBeenCalledWith(source.getConstraints());
    const plain = { rotation: 0, flip: false, close: vi.fn() } as unknown as VideoFrame;
    const oriented = { rotation: 90, flip: true, displayWidth: 480, displayHeight: 640, timestamp: 123, duration: 456, close: vi.fn() } as unknown as VideoFrame;
    p.frames().enqueue(plain);p.frames().enqueue(oriented);
    await flush();
    expect(p.write.mock.calls[0]![0]).toBe(plain);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(oriented, { resizeWidth: 480, resizeHeight: 640 });
    expect(p.write.mock.calls[1]![0]).toMatchObject({ bitmap, init: { timestamp: 123, duration: 456 } });
    expect(plain.close).toHaveBeenCalledOnce();
    expect(oriented.close).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect((p.write.mock.calls[1]![0] as VideoFrame).close).toHaveBeenCalledOnce();
    stopSenderVideoTrack(track);await flush();
    expect(p.cancel).toHaveBeenCalledOnce();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it("retires both ends if idle-refresh configuration fails before piping", async () => {
    const p = platform(), source = new Track(), input = new Track(), ended = vi.fn();
    source.clone.mockReturnValue(input);
    input.applyConstraints.mockRejectedValueOnce(new Error("constraints rejected"));
    const track = clone(source, ended);
    await flush();
    expect(p.cancel).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledExactlyOnceWith(track);
    expect(input.readyState).toBe("ended");
    expect(track.readyState).toBe("ended");
    expect(source.readyState).toBe("live");
  });

  it("retains the ordinary clone if frame APIs are unavailable or construction fails", () => {
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    const source = new Track();expect(clone(source)).toBe(source.clone.mock.results[0]!.value);
    const p = platform();
    vi.stubGlobal("MediaStreamTrackProcessor", class { constructor() { throw new Error("unavailable"); } });
    const other = new Track();const track = clone(other);
    expect(track).toBe(other.clone.mock.results[0]!.value);
    expect(track.readyState).toBe("live");
    expect(p.Generator.instances[0]!.readyState).toBe("ended");
  });
});
