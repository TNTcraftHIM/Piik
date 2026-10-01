import { debugError, debugEvent } from "../lib/debug";

// One codec-sized macroblock; transport timing is not a quality layer.
export const BROWSER_CARRIER_SIZE = 16;

export function supportsBrowserEncoding(): boolean {
  return typeof RTCRtpSender !== "undefined" && typeof RTCEncodedVideoFrame === "function" &&
    typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    typeof (RTCRtpSender.prototype as RTCRtpSender & { createEncodedStreams?: unknown }).createEncodedStreams === "function";
}

export function encodedStreams<Frame extends RTCEncodedVideoFrame | RTCEncodedAudioFrame = RTCEncodedVideoFrame>(sender: RTCRtpSender): {
  readable: ReadableStream<Frame>; writable: WritableStream<Frame>;
} {
  return (sender as RTCRtpSender & { createEncodedStreams(): {
    readable: ReadableStream<Frame>; writable: WritableStream<Frame>;
  } }).createEncodedStreams();
}

export interface BrowserEncodingOutputSnapshot {
  frames: number;
  width: number | null;
  height: number | null;
  lastProducerId: string | null;
  timestamp: number;
}

type Queue = { producerId: string; frames: RTCEncodedVideoFrame[]; needKey: boolean; requestKey: () => Promise<void> };
type Selection = { queue: Queue; onSelected: () => void; accept: (metadata: RTCEncodedVideoFrameMetadata) => boolean };
// Bound pending encoded data; a lost dependency chain resumes on a fresh key.
const MAX_QUEUED_FRAMES = 4;

function copyFrame(frame: RTCEncodedVideoFrame, rtpTimestamp?: number): RTCEncodedVideoFrame {
  const Frame = RTCEncodedVideoFrame as unknown as { new(frame: RTCEncodedVideoFrame,
    options?: { metadata: RTCEncodedVideoFrameMetadata & { rtpTimestamp: number } }): RTCEncodedVideoFrame };
  return new Frame(frame, rtpTimestamp === undefined ? undefined : { metadata: { ...frame.getMetadata(), rtpTimestamp } });
}

/** One connection-lifetime encoded stream, including ordinary fallback. */
export class BrowserEncodingOutput {
  private readonly clock = document.createElement("canvas");
  private readonly clockContext: CanvasRenderingContext2D;
  readonly track: CanvasCaptureMediaStreamTrack;
  private clockFrame = 0;
  private readonly abort = new AbortController();
  private readonly writer: WritableStreamDefaultWriter<RTCEncodedVideoFrame>;
  private current: Queue | undefined;
  private pending: Selection | undefined;
  private carrier: { frame: RTCEncodedVideoFrame; recovery: boolean } | undefined;
  private writing: Promise<void> | undefined;
  private ownKey: (() => Promise<void>) | undefined;
  private raw: false | "key" | true = false;
  private paused = false;
  private epoch = 0;
  private readonly sample = { frames: 0, width: null as number | null, height: null as number | null,
    lastProducerId: null as string | null };

  constructor(sender: RTCRtpSender, private readonly onFailure: () => void, private readonly identity: object) {
    // A CPU-resident macroblock avoids repeatedly mapping/scaling a full GPU
    // decoder surface merely to provide outgoing RTP timing.
    this.clock.width = this.clock.height = BROWSER_CARRIER_SIZE;
    const context = this.clock.getContext("2d");
    if (!context) throw new Error("Browser carrier canvas unavailable");
    this.clockContext = context;
    this.track = this.clock.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    // This synthetic clock needs WebRTC's screen-content ALR probing when the
    // real producer sends little data. The producer owns picture adaptation.
    this.track.contentHint = "detail";
    let streams: ReturnType<typeof encodedStreams<RTCEncodedVideoFrame>>;
    try {
      streams = encodedStreams(sender);
      this.writer = streams.writable.getWriter();
    } catch (error) {
      this.track.stop();
      throw error;
    }
    void streams.readable.pipeTo(new WritableStream({ write: (frame) => this.receive(frame) }),
      { signal: this.abort.signal }).then(() => this.fail(), (error) => this.fail(error)).finally(() => {
        try { this.writer.releaseLock(); } catch { /* Owner abort retired the writer. */ }
      });
  }

  select(producerId: string, requestKey: () => Promise<void>, onSelected: () => void,
    accept: Selection["accept"]): void {
    if (this.abort.signal.aborted) return;
    this.epoch++;
    this.carrier = undefined;
    this.pending = { queue: { producerId, frames: [], needKey: true, requestKey }, onSelected, accept };
    debugEvent("encoding-pool", "selection-requested", { ...this.identity, producerId });
    if (!this.paused) this.request(this.pending.queue);
  }

  cancelSelection(producerId: string): boolean {
    if (this.pending?.queue.producerId !== producerId) return true;
    // Once an accepted key starts writing, that queue owns the wire. Keep its
    // pool reference until completion, including across pause/resume.
    if (this.current === this.pending.queue) return false;
    this.pending = undefined;
    return true;
  }

  push(producerId: string, frame: RTCEncodedVideoFrame): void {
    if (this.abort.signal.aborted || this.paused || frame.data.byteLength === 0) return;
    try {
      let accepted = false;
      for (const queue of new Set([this.current, this.pending?.queue])) {
        if (queue?.producerId !== producerId) continue;
        if (frame.type === "key") { queue.frames.length = 0; queue.needKey = false; }
        else if (queue.frames.length >= MAX_QUEUED_FRAMES) this.recover(queue);
        if (!queue.needKey) { queue.frames.push(copyFrame(frame)); accepted = true; }
      }
      if (accepted) {
        this.clockContext.fillStyle = "#080808";
        this.clockContext.fillRect(0, 0, this.clock.width, this.clock.height);
        this.clockContext.fillStyle = "#181818";
        this.clockContext.fillRect(this.clockFrame++ % this.clock.width, 0, 1, 1);
        this.track.requestFrame();
      }
      void this.drain();
    } catch (error) { this.fail(error); }
  }

  passthrough(requestKey: () => Promise<void>): void {
    if (this.abort.signal.aborted) return;
    this.epoch++;
    this.current = undefined; this.pending = undefined; this.carrier = undefined;
    this.raw = "key";
    debugEvent("encoding-pool", "ordinary-requested", this.identity);
    this.ownKey = requestKey;
    if (!this.paused) this.requestOwnKey();
  }

  setPaused(paused: boolean): void {
    if (this.abort.signal.aborted || this.paused === paused) return;
    this.paused = paused;
    this.track.enabled = !paused;
    debugEvent("encoding-pool", "paused", { ...this.identity, paused });
    this.epoch++;
    this.carrier = undefined;
    if (this.raw) this.raw = "key";
    for (const queue of new Set([this.current, this.pending?.queue])) if (queue) {
      queue.frames.length = 0; queue.needKey = true;
      if (!paused) this.request(queue);
    }
    if (!paused && this.raw) this.requestOwnKey();
  }

  snapshot(): BrowserEncodingOutputSnapshot { return { ...this.sample, timestamp: performance.now() }; }

  dispose(): void {
    if (this.abort.signal.aborted) return;
    this.epoch++;
    this.current = undefined; this.pending = undefined; this.carrier = undefined; this.ownKey = undefined;
    this.abort.abort();
    this.track.stop();
    void this.writer.abort().catch(() => undefined);
  }

  private async receive(frame: RTCEncodedVideoFrame): Promise<void> {
    if (this.abort.signal.aborted || this.paused || frame.data.byteLength === 0) return;
    if (this.raw) {
      const epoch = this.epoch;
      await this.writing;
      if (this.abort.signal.aborted || this.paused || this.epoch !== epoch) return;
    }
    // Coalescing keeps the newest clock, but must not overwrite a recovery
    // request received while the previous output write is still pending.
    this.carrier = { frame, recovery: frame.type === "key" || this.carrier?.recovery === true };
    const writing = this.drain();
    if (this.raw) await writing;
  }

  private drain(): Promise<void> | undefined {
    if (this.abort.signal.aborted || this.paused || this.writing || !this.carrier) return;
    try {
      let selection = this.pending?.queue.frames[0]?.type === "key" ? this.pending : undefined;
      // Preparation is not commitment: validate the actual key while the old
      // stream is still intact, before consuming either queue or writing bytes.
      if (selection && selection.queue !== this.current && !selection.accept(selection.queue.frames[0]!.getMetadata())) {
        debugEvent("encoding-pool", "selection-rejected", { ...this.identity, producerId: selection.queue.producerId });
        this.pending = undefined;
        selection = undefined;
      }
      const { frame: own, recovery } = this.carrier;
      // A carrier key can be a remote PLI. Only an accepted candidate key can
      // replace the current stream's recovery; a rejected one proves nothing.
      if (recovery && !selection && this.current && this.current.frames[0]?.type !== "key") this.recover(this.current);
      if (this.raw && !selection) {
        this.carrier = undefined;
        if (this.raw === "key" && own.type !== "key") return;
        return this.write(own, null);
      }
      const queue = selection?.queue ?? this.current, frame = queue?.frames.shift();
      if (!queue || !frame) return;
      this.carrier = undefined;
      const copy = copyFrame(frame, own.timestamp);
      this.current = queue;
      this.raw = false;
      return this.write(copy, queue.producerId, selection);
    } catch (error) { this.fail(error); }
  }

  private write(frame: RTCEncodedVideoFrame, producerId: string | null, selection?: Selection): Promise<void> {
    const epoch = this.epoch, metadata = frame.getMetadata(), key = frame.type === "key";
    const writing = this.writer.write(frame).then(() => {
      if (this.abort.signal.aborted) return;
      this.sample.frames++;
      this.sample.width = metadata.width ?? null; this.sample.height = metadata.height ?? null;
      this.sample.lastProducerId = producerId;
      if (epoch !== this.epoch || this.paused) return;
      if (key) this.raw = producerId === null;
      if (selection && this.pending === selection) {
        this.pending = undefined;
        debugEvent("encoding-pool", "selected", { ...this.identity, producerId, width: metadata.width, height: metadata.height });
        selection.onSelected();
      }
    }).catch((error) => this.fail(error)).finally(() => { this.writing = undefined; void this.drain(); });
    this.writing = writing;
    return writing;
  }

  private recover(queue: Queue): void {
    if (queue.needKey) return;
    debugEvent("encoding-pool", "recovery-requested", { ...this.identity, producerId: queue.producerId, queued: queue.frames.length });
    queue.frames.length = 0; queue.needKey = true;
    this.request(queue);
  }

  private request(queue: Queue): void {
    const epoch = this.epoch;
    void queue.requestKey().catch((error) => {
      if (epoch === this.epoch && (this.current === queue || this.pending?.queue === queue)) this.fail(error);
    });
  }

  private requestOwnKey(): void {
    const epoch = this.epoch;
    void this.ownKey?.().catch((error) => { if (epoch === this.epoch) this.fail(error); });
  }

  private fail(error?: unknown): void {
    if (this.abort.signal.aborted) return;
    debugError("encoding-pool", "output-failed", error, { ...this.identity, producerId: this.current?.producerId });
    this.dispose();
    this.onFailure();
  }
}
