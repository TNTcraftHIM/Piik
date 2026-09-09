export function supportsBrowserEncoding(): boolean {
  return typeof RTCRtpSender !== "undefined" && typeof RTCEncodedVideoFrame === "function" &&
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
type Selection = { queue: Queue; onSelected: () => void };
// Bound pending encoded data; a lost dependency chain resumes on a fresh key.
const MAX_QUEUED_FRAMES = 4;

function copyFrame(frame: RTCEncodedVideoFrame, rtpTimestamp?: number): RTCEncodedVideoFrame {
  const Frame = RTCEncodedVideoFrame as unknown as { new(frame: RTCEncodedVideoFrame,
    options?: { metadata: RTCEncodedVideoFrameMetadata & { rtpTimestamp: number } }): RTCEncodedVideoFrame };
  return new Frame(frame, rtpTimestamp === undefined ? undefined : { metadata: { ...frame.getMetadata(), rtpTimestamp } });
}

/** One connection-lifetime encoded stream, including ordinary fallback. */
export class BrowserEncodingOutput {
  private readonly abort = new AbortController();
  private readonly writer: WritableStreamDefaultWriter<RTCEncodedVideoFrame>;
  private current: Queue | undefined;
  private pending: Selection | undefined;
  private carrier: RTCEncodedVideoFrame | undefined;
  private writing: Promise<void> | undefined;
  private ownKey: (() => Promise<void>) | undefined;
  private raw: false | "key" | true = false;
  private paused = false;
  private epoch = 0;
  private readonly sample = { frames: 0, width: null as number | null, height: null as number | null,
    lastProducerId: null as string | null };

  constructor(sender: RTCRtpSender, private readonly onFailure: () => void) {
    const streams = encodedStreams(sender);
    this.writer = streams.writable.getWriter();
    void streams.readable.pipeTo(new WritableStream({ write: (frame) => this.receive(frame) }),
      { signal: this.abort.signal }).then(() => this.fail(), () => this.fail()).finally(() => {
        try { this.writer.releaseLock(); } catch { /* Owner abort retired the writer. */ }
      });
  }

  select(producerId: string, requestKey: () => Promise<void>, onSelected: () => void): void {
    if (this.abort.signal.aborted) return;
    this.epoch++;
    this.carrier = undefined;
    this.pending = { queue: { producerId, frames: [], needKey: true, requestKey }, onSelected };
    if (!this.paused) this.request(this.pending.queue);
  }

  push(producerId: string, frame: RTCEncodedVideoFrame): void {
    if (this.abort.signal.aborted || this.paused || frame.data.byteLength === 0) return;
    try {
      for (const queue of new Set([this.current, this.pending?.queue])) {
        if (queue?.producerId !== producerId) continue;
        if (frame.type === "key") { queue.frames.length = 0; queue.needKey = false; }
        else if (queue.frames.length >= MAX_QUEUED_FRAMES) this.recover(queue);
        if (!queue.needKey) queue.frames.push(copyFrame(frame));
      }
      void this.drain();
    } catch { this.fail(); }
  }

  passthrough(requestKey: () => Promise<void>): void {
    if (this.abort.signal.aborted) return;
    this.epoch++;
    this.current = undefined; this.pending = undefined; this.carrier = undefined;
    this.raw = "key";
    this.ownKey = requestKey;
    if (!this.paused) this.requestOwnKey();
  }

  setPaused(paused: boolean): void {
    if (this.abort.signal.aborted || this.paused === paused) return;
    this.paused = paused;
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
    void this.writer.abort().catch(() => undefined);
  }

  private async receive(frame: RTCEncodedVideoFrame): Promise<void> {
    if (this.abort.signal.aborted || this.paused || frame.data.byteLength === 0) return;
    if (this.raw) {
      const epoch = this.epoch;
      await this.writing;
      if (this.abort.signal.aborted || this.paused || this.epoch !== epoch) return;
      if (this.raw && !this.pending?.queue.frames[0]) {
        if (this.raw === "key" && frame.type !== "key") return;
        await this.write(frame, null);
        return;
      }
    }
    // A native carrier key can be a remote PLI. Recover the selected real
    // stream, without requiring its frame type to match this clock frame.
    if (frame.type === "key" && this.current && this.pending?.queue.frames[0]?.type !== "key" &&
      this.current.frames[0]?.type !== "key") this.recover(this.current);
    this.carrier = frame;
    const writing = this.drain();
    if (this.raw) await writing;
  }

  private drain(): Promise<void> | undefined {
    if (this.abort.signal.aborted || this.paused || this.writing || !this.carrier) return;
    const selection = this.pending?.queue.frames[0]?.type === "key" ? this.pending : undefined;
    if (this.raw && !selection) return;
    const queue = selection?.queue ?? this.current, frame = queue?.frames.shift();
    if (!queue || !frame) return;
    const own = this.carrier;
    this.carrier = undefined;
    try {
      const copy = copyFrame(frame, own.timestamp);
      this.current = queue;
      this.raw = false;
      return this.write(copy, queue.producerId, selection);
    } catch { this.fail(); }
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
        selection.onSelected();
      }
    }).catch(() => this.fail()).finally(() => { this.writing = undefined; void this.drain(); });
    this.writing = writing;
    return writing;
  }

  private recover(queue: Queue): void {
    if (queue.needKey) return;
    queue.frames.length = 0; queue.needKey = true;
    this.request(queue);
  }

  private request(queue: Queue): void {
    const epoch = this.epoch;
    void queue.requestKey().catch(() => {
      if (epoch === this.epoch && (this.current === queue || this.pending?.queue === queue)) this.fail();
    });
  }

  private requestOwnKey(): void {
    const epoch = this.epoch;
    void this.ownKey?.().catch(() => { if (epoch === this.epoch) this.fail(); });
  }

  private fail(): void {
    if (this.abort.signal.aborted) return;
    this.dispose();
    this.onFailure();
  }
}
