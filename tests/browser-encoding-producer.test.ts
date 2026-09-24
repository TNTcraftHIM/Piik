import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEncodingProducer } from "../src/client/media/browser-encoding-producer";
import { QUALITY_PROFILES } from "../src/client/media/quality";

vi.mock("../src/client/media/quality", async (original) => ({
  ...await original<typeof import("../src/client/media/quality")>(),
  applyVideoCaptureProfile: vi.fn(async () => undefined),
  configureVideoSender: vi.fn(async () => undefined),
}));

class Track extends EventTarget {
  enabled = true;
  readyState = "live";
  contentHint = "motion";
  readonly stop = vi.fn(() => { this.readyState = "ended"; });
  clone() { return new Track(); }
}

class Connection {
  static instances: Connection[] = [];
  connectionState = "connecting";
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate }) => void) | null = null;
  readonly addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => undefined);
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly close = vi.fn(() => { this.connectionState = "closed"; });
  readonly sender = {
    createEncodedStreams: () => ({
      readable: new ReadableStream<RTCEncodedVideoFrame>(),
      writable: new WritableStream<RTCEncodedVideoFrame>(),
    }),
  };
  constructor() { Connection.instances.push(this); }
  addTransceiver() { return { sender: this.sender, setCodecPreferences() {} }; }
  async createOffer() { return { type: "offer" as const, sdp: "offer" }; }
  async createAnswer() { return { type: "answer" as const, sdp: "answer" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  state(value: string) { this.connectionState = value; this.onconnectionstatechange?.(); }
}

const producers: BrowserEncodingProducer[] = [];
function createProducer() {
  const source = new Track();
  const failed = vi.fn();
  const producer = new BrowserEncodingProducer(source as unknown as MediaStreamTrack,
    QUALITY_PROFILES["1080p30"], { mimeType: "video/VP8", clockRate: 90000 }, vi.fn(), failed);
  producers.push(producer);
  return { producer, source, failed };
}

beforeEach(() => {
  vi.useFakeTimers();
  Connection.instances = [];
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("document", { createElement: () => ({ pause() {}, play: async () => undefined }) });
});

afterEach(async () => {
  for (const producer of producers.splice(0)) producer.dispose();
  await vi.runAllTimersAsync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Browser encoding producer startup", () => {
  it.each(["queued", "active"])("keeps the producer after a %s candidate rejection", async (phase) => {
    const { producer, failed } = createProducer();
    const starting = producer.start();
    const [send, receive] = Connection.instances;
    const candidate = { candidate: "candidate:1 1 udp 1 127.0.0.1 9000 typ host" } as RTCIceCandidate;
    receive!.addIceCandidate.mockRejectedValueOnce(new DOMException("Rejected candidate", "OperationError"));
    if (phase === "queued") send!.onicecandidate?.({ candidate });
    await starting;
    for (const connection of Connection.instances) connection.state("connected");
    if (phase === "active") send!.onicecandidate?.({ candidate });
    const valid = { candidate: "candidate:2 1 udp 1 127.0.0.1 9001 typ host" } as RTCIceCandidate;
    send!.onicecandidate?.({ candidate: valid });
    await vi.advanceTimersByTimeAsync(0);
    expect(receive!.addIceCandidate).toHaveBeenCalledWith(valid);
    expect(failed).not.toHaveBeenCalled();
    expect(Connection.instances.every(connection => connection.close.mock.calls.length === 0)).toBe(true);
    expect(producer.track?.readyState).toBe("live");
  });

  it.each([false, true])("retires a stuck local transport once (one side connected: %s)", async (oneSide) => {
    const { producer, source, failed } = createProducer();
    await producer.start();
    const input = producer.track as unknown as Track;
    if (oneSide) Connection.instances[0]!.state("connected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(failed).toHaveBeenCalledOnce();
    expect(Connection.instances.every((connection) => connection.close.mock.calls.length === 1)).toBe(true);
    expect(input.stop).toHaveBeenCalledOnce();
    expect(source.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("keeps a connected producer without requiring frames from a quiet or paused source", async () => {
    const { producer, failed } = createProducer();
    await producer.start();
    producer.setPaused(true);
    for (const connection of Connection.instances) connection.state("connected");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failed).not.toHaveBeenCalled();
    expect(producer.track?.readyState).toBe("live");
  });

  it("cancels startup when retired and does not fail its replacement", async () => {
    const old = createProducer();
    await old.producer.start();
    old.producer.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const next = createProducer();
    await next.producer.start();
    for (const connection of Connection.instances.slice(2)) connection.state("connected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(old.failed).not.toHaveBeenCalled();
    expect(next.failed).not.toHaveBeenCalled();
    expect(next.producer.track?.readyState).toBe("live");
  });
});
