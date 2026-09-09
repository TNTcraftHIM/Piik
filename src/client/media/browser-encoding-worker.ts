export type BrowserEncodingWorkerOptions =
  | { kind: "producer"; id: string }
  | { kind: "carrier"; id: string; passthrough: boolean };
export type BrowserEncodingWorkerMessage =
  | { type: "select"; carrierId: string; producerId: string; requestId: string }
  | { type: "pause"; carrierId: string; paused: boolean }
  | { type: "passthrough"; carrierId: string }
  | { type: "remove"; id: string }
  | { type: "sample"; requestId: string };
export interface BrowserEncodingOutputSample {
  carrierId: string;
  frames: number;
  bytes: number;
  lastProducerId: string | null;
  width: number | null;
  height: number | null;
}
export type BrowserEncodingWorkerEvent =
  | { type: "frame"; carrierIds: string[] }
  | { type: "key"; id: string }
  | { type: "selected"; carrierId: string; producerId: string; requestId: string }
  | { type: "sample"; requestId: string; outputs: BrowserEncodingOutputSample[] }
  | { type: "error"; id: string; message: string };

interface Transform {
  options: BrowserEncodingWorkerOptions;
  readable: ReadableStream<RTCEncodedVideoFrame>;
  writable: WritableStream<RTCEncodedVideoFrame>;
}
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<BrowserEncodingWorkerMessage>) => void;
  onrtctransform: (event: { transformer: Transform }) => void;
  postMessage(message: BrowserEncodingWorkerEvent): void;
};
const MAX_QUEUED_FRAMES = 4;
type Unit = { data: ArrayBuffer; key: boolean; width: number | null; height: number | null };
type Queue = { producerId: string; frames: Unit[]; needKey: boolean };
type Selection = { queue: Queue; requestId: string };
type Endpoint = { writer: WritableStreamDefaultWriter<RTCEncodedVideoFrame>; abort: AbortController };
interface Carrier {
  sample: BrowserEncodingOutputSample;
  current?: Queue;
  pending?: Selection;
  frame?: RTCEncodedVideoFrame;
  paused: boolean;
  passthrough: false | "key" | true;
  writing?: Promise<void>;
  epoch: number;
}
const endpoints = new Map<string, Endpoint>();
const carriers = new Map<string, Carrier>();
const key = (id: string) => scope.postMessage({ type: "key", id });
const error = (id: string, value: unknown) => scope.postMessage({ type: "error", id,
  message: value instanceof Error ? value.message : String(value) });

function carrier(id: string): Carrier {
  let value = carriers.get(id);
  if (!value) {
    value = { sample: { carrierId: id, frames: 0, bytes: 0, lastProducerId: null, width: null, height: null },
      paused: false, passthrough: false, epoch: 0 };
    carriers.set(id, value);
  }
  return value;
}

function drain(id: string, output: Carrier): Promise<void> | undefined {
  const endpoint = endpoints.get(id);
  if (!endpoint || carriers.get(id) !== output || output.paused || output.writing || !output.frame) return;
  const frame = output.frame;
  const pending = output.pending;
  const pendingReady = pending?.queue.frames[0]?.key === true;
  if (output.passthrough && !(pendingReady && frame.type === "key")) return;
  let queue = output.current;
  if (pendingReady) {
    if (frame.type === "key") queue = pending.queue;
    else key(id);
  }
  const unit = queue?.frames[0];
  if (!queue || !unit) return;
  if (frame.type === "key" && !unit.key) {
    queue.frames.length = 0;
    if (!queue.needKey) key(queue.producerId);
    queue.needKey = true;
    return;
  }
  if (frame.type !== "key" && unit.key) {
    output.frame = undefined;
    key(id);
    return;
  }
  queue.frames.shift();
  output.frame = undefined;
  output.current = queue;
  const selection = pending?.queue === queue ? pending : undefined;
  frame.data = unit.data;
  return write(id, output, endpoint, frame, unit, queue.producerId, selection);
}

function write(id: string, output: Carrier, endpoint: Endpoint, frame: RTCEncodedVideoFrame,
  unit: Unit, producerId: string | null, selection?: Selection): Promise<void> {
  const epoch = output.epoch, bytes = unit.data.byteLength;
  const pendingWrite = endpoint.writer.write(frame).then(() => {
    if (carriers.get(id) !== output) return;
    output.sample.frames++;
    output.sample.bytes += bytes;
    output.sample.lastProducerId = producerId;
    output.sample.width = unit.width;
    output.sample.height = unit.height;
    if (unit.key && output.epoch === epoch && !output.paused) output.passthrough = producerId === null;
    if (producerId !== null && unit.key && selection && output.pending === selection && output.epoch === epoch && !output.paused) {
      output.pending = undefined;
      scope.postMessage({ type: "selected", carrierId: id, producerId, requestId: selection.requestId });
    }
  }, (failure) => {
    if (!endpoint.abort.signal.aborted) { error(id, failure); remove(id); }
  }).finally(() => { output.writing = undefined; void drain(id, output); });
  output.writing = pendingWrite;
  return pendingWrite;
}

function put(id: string, output: Carrier, queue: Queue, frame: RTCEncodedVideoFrame): void {
  if (frame.type === "key") {
    queue.frames.length = 0;
    queue.needKey = false;
  } else if (queue.frames.length >= MAX_QUEUED_FRAMES) {
    queue.frames.length = 0;
    queue.needKey = true;
    key(queue.producerId);
  }
  if (queue.needKey) return;
  const metadata = frame.getMetadata();
  queue.frames.push({ data: frame.data.slice(0), key: frame.type === "key",
    width: metadata.width ?? null, height: metadata.height ?? null });
  if (frame.type === "key" && output.frame?.type !== "key") key(id);
  drain(id, output);
}

function remove(id: string): void {
  const endpoint = endpoints.get(id);
  const removed = carriers.get(id);
  if (removed) {
    removed.paused = true;
    removed.frame = undefined;
    for (const queue of [removed.current, removed.pending?.queue]) if (queue) queue.frames.length = 0;
    removed.current = undefined;
    removed.pending = undefined;
    removed.epoch++;
  }
  endpoints.delete(id);
  carriers.delete(id);
  if (endpoint) {
    endpoint.abort.abort();
    void endpoint.writer.abort().catch(() => undefined);
  }
  for (const output of carriers.values()) {
    if (output.current?.producerId === id || output.pending?.queue.producerId === id) {
      if (output.current?.producerId === id) {
        output.current.frames.length = 0; output.current = undefined;
      }
      if (output.pending?.queue.producerId === id) {
        output.pending.queue.frames.length = 0; output.pending = undefined;
      }
      output.frame = undefined;
      output.epoch++;
    }
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === "remove") { remove(data.id); return; }
  if (data.type === "sample") {
    scope.postMessage({ type: "sample", requestId: data.requestId,
      outputs: [...carriers.values()].map((output) => ({ ...output.sample })) });
    return;
  }
  const output = carrier(data.carrierId);
  if (data.type === "select") {
    output.pending = { requestId: data.requestId,
      queue: { producerId: data.producerId, frames: [], needKey: true } };
    if (!output.paused) key(data.producerId);
  } else if (data.type === "passthrough") {
    output.passthrough = "key";
    output.frame = undefined;
    for (const queue of [output.current, output.pending?.queue]) if (queue) queue.frames.length = 0;
    output.current = output.pending = undefined;
    output.epoch++;
    if (!output.paused) key(data.carrierId);
  } else {
    output.paused = data.paused;
    output.frame = undefined;
    output.epoch++;
    if (output.passthrough) {
      output.passthrough = "key";
      if (!output.paused) key(data.carrierId);
    }
    for (const queue of new Set([output.current, output.pending?.queue])) if (queue) {
      queue.frames.length = 0;
      queue.needKey = true;
      if (!output.paused) key(queue.producerId);
    }
  }
};

scope.onrtctransform = ({ transformer: { options, readable, writable } }) => {
  const { id, kind } = options;
  if (endpoints.has(id)) {
    error(id, "Duplicate encoding endpoint");
    void readable.cancel().catch(() => undefined);
    void writable.abort().catch(() => undefined);
    return;
  }
  const endpoint = { writer: writable.getWriter(), abort: new AbortController() };
  endpoints.set(id, endpoint);
  const output = kind === "carrier" ? carrier(id) : undefined;
  if (output && options.kind === "carrier" && !output.passthrough) output.passthrough = options.passthrough ? "key" : false;
  void readable.pipeTo(new WritableStream<RTCEncodedVideoFrame>({
    async write(frame) {
      if (endpoint.abort.signal.aborted || frame.data.byteLength === 0) return;
      if (output) {
        if (output.paused) return;
        // Keep the existing own key until its source key arrives. Writing any
        // later own frame would make this retained frame's counter invalid.
        if (output.frame?.type === "key") { await drain(id, output); return; }
        if (output.passthrough) {
          const epoch = output.epoch;
          await output.writing;
          if (endpoint.abort.signal.aborted || output.paused || output.epoch !== epoch) return;
          if (output.passthrough === "key" && frame.type !== "key") { key(id); return; }
          if (output.pending && frame.type === "key") {
            output.frame = frame;
            await drain(id, output);
            return;
          }
          if (output.passthrough && !(frame.type === "key" && output.pending?.queue.frames[0]?.key)) {
            if (output.pending?.queue.frames[0]?.key) key(id);
            const metadata = frame.getMetadata();
            await write(id, output, endpoint, frame, { data: frame.data, key: frame.type === "key",
              width: metadata.width ?? null, height: metadata.height ?? null }, null);
            return;
          }
        }
        output.frame = frame;
        const draining = drain(id, output);
        if (output.passthrough) await draining;
      } else {
        const carrierIds: string[] = [];
        for (const [carrierId, target] of carriers) if (!target.paused) {
          let consumes = false;
          for (const queue of new Set([target.current, target.pending?.queue])) {
            if (queue?.producerId === id) { put(carrierId, target, queue, frame); consumes = true; }
          }
          if (consumes) carrierIds.push(carrierId);
        }
        if (carrierIds.length) scope.postMessage({ type: "frame", carrierIds });
        await endpoint.writer.write(frame);
      }
    },
  }), { signal: endpoint.abort.signal }).then(() => {
    if (!endpoint.abort.signal.aborted) error(id, "Encoded stream ended");
  }, (failure) => {
    if (!endpoint.abort.signal.aborted) error(id, failure);
  }).finally(() => {
    if (endpoints.get(id) === endpoint) remove(id);
    try { endpoint.writer.releaseLock(); } catch { /* Owner abort already retired this writer. */ }
  });
};
