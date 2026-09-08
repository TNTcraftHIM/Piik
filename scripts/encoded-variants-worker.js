// Isolated component experiment; no application transport, feedback or policy.
const profiles = [[480, 270, 312500], [960, 540, 1250000], [1920, 1080, 5000000]];
const fps = 30;
const trace = [[2, 2], [2, 0], [0, 0], [1, 1], [2, 2], [2, 0], [2, 2]];
const phaseFrames = 32;
const now = () => performance.now();
const assert = (condition, message) => { if (!condition) throw Error(message); };
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};

function makeInput() {
  return Array.from({ length: 32 }, (_, frame) => {
    const data = new Uint8Array(1920 * 1080 * 3 / 2).fill(128);
    for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
      const u = (x + frame * 4) % 128;
      const v = y % 128;
      data[y * 1920 + x] = 32 + ((u >> 3) ^ (v >> 3)) * 8 + ((u ^ v) & 31) * 2;
    }
    return data;
  });
}

function config(codec, layer) {
  const [width, height, bitrate] = profiles[layer];
  return { codec, width, height, bitrate, framerate: fps, latencyMode: "realtime",
    bitrateMode: "constant", hardwareAcceleration: "prefer-software",
    ...(codec.startsWith("avc") ? { avc: { format: "annexb" } } : {}) };
}

function encoder(codec, layer) {
  let result;
  let failure;
  const value = new VideoEncoder({ output: (chunk, metadata) => { result = { chunk, metadata }; }, error: (error) => { failure = error; } });
  value.configure(config(codec, layer));
  return {
    value,
    async encode(frame, keyFrame) {
      result = undefined;
      value.encode(frame, { keyFrame });
      await value.flush();
      if (failure) throw failure;
      assert(result?.chunk.timestamp === frame.timestamp, "Missing/out-of-order encoded frame");
      if (keyFrame) assert(result.chunk.type === "key", "Missing switch keyframe");
      return result;
    },
  };
}

function decoder(codec) {
  let complete;
  let reject;
  let layer = -1;
  let failure;
  const value = new VideoDecoder({
    output: (frame) => { const accept = complete; complete = undefined; if (accept) accept(frame); else frame.close(); },
    error: (error) => { failure = error; reject?.(error); },
  });
  return {
    value,
    async decode(packet, nextLayer) {
      if (layer !== nextLayer) {
        const [codedWidth, codedHeight] = profiles[nextLayer];
        value.configure({ codec, codedWidth, codedHeight, optimizeForLatency: true, hardwareAcceleration: "prefer-software" });
        layer = nextLayer;
      }
      if (failure) throw failure;
      const promise = new Promise((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise; });
      value.decode(packet);
      const frame = await promise;
      assert(frame.displayWidth === profiles[nextLayer][0] && frame.displayHeight === profiles[nextLayer][1], "Wrong decoded dimensions");
      return frame;
    },
  };
}

function rawFrame(input, frame) {
  return new VideoFrame(input[frame % input.length], { format: "NV12", codedWidth: 1920, codedHeight: 1080,
    timestamp: Math.round(frame * 1e6 / fps), duration: Math.round(1e6 / fps) });
}

async function prepareIngress(codec, input) {
  const source = encoder(codec, 2);
  const packets = [];
  try {
    for (let i = 0; i < input.length; i++) {
      const frame = rawFrame(input, i);
      try {
        const { chunk } = await source.encode(frame, i === 0);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        packets.push({ data, type: chunk.type });
      } finally { frame.close(); }
    }
    return packets;
  } finally { source.value.close(); }
}

async function run(codec, policy, role, input, ingress) {
  const encoders = [null, null, null];
  const receivers = [decoder(codec), decoder(codec)];
  const inputDecoder = role === "relay" ? decoder(codec) : null;
  let previous = [-1, -1];
  const encoded = [0, 0, 0];
  const generatedBytes = [0, 0, 0];
  const selectedBytes = [0, 0];
  const decoded = [0, 0];
  const switches = [];
  const phases = [];
  let creates = 0;
  let ingressDecodes = 0;
  const metrics = { management: [], input: [], encodeReady: [], allReceivers: [], processing: [] };
  const start = now();
  try {
    for (let index = 0; index < trace.length * phaseFrames; index++) {
      const phase = Math.floor(index / phaseFrames);
      const demand = trace[phase];
      const tick = now();
      const demanded = new Set(demand);
      const active = policy === "exact" ? demanded : new Set(Array.from({ length: Math.max(...demand) + 1 }, (_, i) => i));
      // A relay already has H. It never re-encodes H or starts lower encoders just for H/H.
      if (role === "relay") {
        active.delete(2);
        if (!demand.some((i) => i < 2)) active.clear();
      }
      const switched = demand.map((layer, child) => previous[child] !== layer);
      const keyframes = new Set(demand.filter((_, child) => switched[child]));
      for (let layer = 0; layer < 3; layer++) {
        if (active.has(layer) && !encoders[layer]) { encoders[layer] = encoder(codec, layer); creates++; keyframes.add(layer); }
        if (!active.has(layer) && encoders[layer]) { encoders[layer].value.close(); encoders[layer] = null; }
      }
      const afterManagement = now();
      let sourceFrame;
      const outputs = new Map();
      const deliveries = [];
      const deliver = async (layer, child, packetPromise) => {
        const packet = await packetPromise;
        assert(packet, "Missing demanded encoding");
        if (switched[child]) assert(packet.type === "key", "Switch did not start at a recovery frame");
        const frame = await receivers[child].decode(packet, layer);
        assert(frame.timestamp === Math.round(index * 1e6 / fps), "Wrong decoded timestamp");
        frame.close();
        decoded[child]++;
        selectedBytes[child] += packet.byteLength;
        const delivered = now();
        if (switched[child] && index > 0) switches.push({ index, child, layer, ms: delivered - tick, bytes: packet.byteLength });
        return delivered;
      };
      if (role === "relay") {
        const sourcePacket = ingress[index % ingress.length];
        const packet = new EncodedVideoChunk({ ...sourcePacket, timestamp: Math.round(index * 1e6 / fps) });
        outputs.set(2, Promise.resolve(packet));
        demand.forEach((layer, child) => { if (layer === 2) deliveries[child] = deliver(layer, child, outputs.get(layer)); });
        if (active.size) {
          sourceFrame = await inputDecoder.decode(packet, 2);
          ingressDecodes++;
        }
        // Demand phases align with input GOPs; real upstream PLI/network delay is not measured.
      } else {
        sourceFrame = rawFrame(input, index);
      }
      const afterInput = now();
      try {
        for (const layer of active) {
          outputs.set(layer, encoders[layer].encode(sourceFrame, keyframes.has(layer)).then(({ chunk }) => {
            encoded[layer]++;
            generatedBytes[layer] += chunk.byteLength;
            return chunk;
          }));
        }
        demand.forEach((layer, child) => { deliveries[child] ??= deliver(layer, child, outputs.get(layer)); });
        await Promise.all(outputs.values());
      } finally { sourceFrame?.close(); }
      const afterEncode = now();
      const decodedAt = await Promise.all(deliveries);
      const afterDecode = Math.max(...decodedAt);
      const row = { management: afterManagement - tick, input: afterInput - afterManagement,
        encodeReady: afterEncode - afterInput, allReceivers: afterDecode - tick, processing: now() - tick };
      for (const key of Object.keys(metrics)) metrics[key].push(row[key]);
      if (!phases[phase]) phases[phase] = { demand, frames: 0, work: [] };
      phases[phase].frames++;
      phases[phase].work.push(row.processing);
      previous = demand;
      const delay = start + (index + 1) * 1000 / fps - now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const expected = role === "host" ? policy === "exact" ? [96, 32, 160] : [224, 192, 160]
      : policy === "exact" ? [96, 32, 0] : [128, 96, 0];
    assert(encoded.every((count, layer) => count === expected[layer]), "Unexpected encode count");
    assert(decoded.every((count) => count === 224), "Missing receiver frames");
    assert(ingressDecodes === (role === "relay" ? 128 : 0), "Repeated or unnecessary input decode");
    return { codec, policy, role, encoded, decoded, ingressDecodes, creates, generatedBytes, selectedBytes, switches,
      elapsedMs: now() - start, metrics: Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, summarize(values)])),
      overFrameBudget: metrics.processing.filter((value) => value > 1000 / fps).length,
      phases: phases.map(({ demand, frames, work }) => ({ demand, frames, work: summarize(work) })) };
  } finally {
    for (const slot of [...encoders, ...receivers, inputDecoder]) if (slot && slot.value.state !== "closed") slot.value.close();
  }
}

self.onmessage = async () => {
  try {
    const input = makeInput();
    const results = [];
    const support = {};
    for (const codec of ["vp8", "avc1.420028"]) {
      support[codec] = (await VideoEncoder.isConfigSupported(config(codec, 2))).supported;
      if (!support[codec]) continue;
      const ingress = await prepareIngress(codec, input);
      for (let round = 1; round <= 2; round++) {
        for (const role of ["host", "relay"]) for (const policy of round === 1 ? ["exact", "envelope"] : ["envelope", "exact"]) {
          self.postMessage({ progress: `${codec} ${round} ${role} ${policy}` });
          results.push({ round, ...await run(codec, policy, role, input, ingress) });
        }
      }
    }
    self.postMessage({ completed: true, scope: "WebCodecs software preference; independent child decode; no RTP, network, hardware or perceptual acceptance",
      userAgent: navigator.userAgent, support, profiles, fps, phaseFrames, trace, results });
  } catch (error) { self.postMessage({ error: String(error.stack ?? error) }); }
};
