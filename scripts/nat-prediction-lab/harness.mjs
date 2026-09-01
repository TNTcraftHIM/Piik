import http from "node:http";

const bindAddress = process.env.NATLAB_BIND ?? "127.0.0.1";
const port = Number(process.env.NATLAB_PORT ?? "8080");
const sessions = new Map();
const surveyCounts = new Map();

const page = String.raw`<!doctype html>
<meta charset="utf-8">
<title>NAT lab</title>
<script type="module">
const query = new URLSearchParams(location.search);
const run = query.get("run");
const side = query.get("side");
const nat = query.get("nat");
const mode = query.get("mode") ?? "baseline";
const windowSize = Number(query.get("window") ?? "16");
const holdRelease = query.get("hold") === "1";

if (!run || !["a", "b"].includes(side)) throw new Error("invalid lab URL");

const pc = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:198.18.0.10:3478" },
    { urls: "stun:198.18.0.11:3478" },
  ],
  bundlePolicy: "max-bundle",
});

let queueIndex = 0;
let sendChain = Promise.resolve();
let releaseAt = null;
let resultSent = false;
let channelReady = false;
let localCandidates = 0;
let localSrflxCandidates = 0;
let predictedCandidatesReceived = 0;

const post = async (path, payload) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

const signal = (payload) => {
  sendChain = sendChain.then(() => post("/api/message", { run, side, ...payload }));
  return sendChain;
};

const stripCandidates = (description) => ({
  type: description.type,
  sdp: description.sdp
    .split("\r\n")
    .filter((line) => !line.startsWith("a=candidate:") && line !== "a=end-of-candidates")
    .join("\r\n"),
});

const report = async (success) => {
  if (resultSent) return;
  resultSent = true;
  const elapsedMs = releaseAt === null ? null : Math.round(performance.now() - releaseAt);
  await post("/api/result", {
    run,
    side,
    success,
    elapsedMs,
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    localCandidates,
    localSrflxCandidates,
    predictedCandidatesReceived,
  });
  document.title = success ? "connected" : "failed";
};

const bindChannel = (channel) => {
  channel.addEventListener("open", () => {
    channelReady = true;
    channel.send("ready");
    if (releaseAt !== null) void report(true);
  });
  channel.addEventListener("message", () => {
    channelReady = true;
    if (releaseAt !== null) void report(true);
  });
};

pc.addEventListener("datachannel", (event) => bindChannel(event.channel));
pc.addEventListener("icecandidate", (event) => {
  if (event.candidate) {
    localCandidates += 1;
    if (event.candidate.type === "srflx") localSrflxCandidates += 1;
    void signal({ type: "candidate", candidate: event.candidate.toJSON() });
  } else {
    void signal({ type: "gathered" });
  }
});

pc.addEventListener("connectionstatechange", () => {
  if (pc.connectionState === "failed") void report(false);
});

const handleMessage = async (message) => {
  if (message.type === "description") {
    await pc.setRemoteDescription(message.description);
    if (message.description.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      await signal({ type: "description", description: stripCandidates(pc.localDescription) });
    }
    return;
  }
  if (message.type === "release") {
    releaseAt = performance.now();
    if (channelReady) void report(true);
    setTimeout(() => void report(false), 7000);
    return;
  }
  if (message.type === "candidate") {
    if (message.predicted) predictedCandidatesReceived += 1;
    await pc.addIceCandidate(message.candidate);
    return;
  }
  if (message.type === "end-of-candidates") {
    await pc.addIceCandidate(null);
  }
};

const poll = async () => {
  while (!resultSent) {
    const response = await fetch(
      "/api/poll?run=" + encodeURIComponent(run) +
      "&side=" + side + "&after=" + queueIndex,
      { cache: "no-store" },
    );
    const payload = await response.json();
    for (const message of payload.messages) await handleMessage(message);
    queueIndex = payload.next;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

await signal({ type: "hello", nat, mode, windowSize, holdRelease });
void poll();

if (side === "a") {
  bindChannel(pc.createDataChannel("probe", { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  await signal({ type: "description", description: stripCandidates(pc.localDescription) });
}

setTimeout(() => void report(false), 15000);
</script>`;

const surveyPage = String.raw`<!doctype html>
<meta charset="utf-8">
<title>NAT survey</title>
<output id="result">measuring</output>
<script type="module">
const query = new URLSearchParams(location.search);
const requestedSamples = Number(query.get("samples") ?? "6");
const sampleCount = Math.max(3, Math.min(12, requestedSamples || 6));
const configuredStun = query.getAll("stun");
const configuredStunIsSafe = configuredStun.every(
  (url) => url.startsWith("stun:") && url.length <= 256,
);
const stunUrls = configuredStunIsSafe && configuredStun.length >= 2 && configuredStun.length <= 3
  ? configuredStun
  : [
      "stun:198.18.0.10:3478",
      "stun:198.18.0.11:3478",
      "stun:198.18.0.12:3478",
    ];

const candidatePort = (candidate) => {
  if (Number.isInteger(candidate.port)) return candidate.port;
  const fields = candidate.candidate.trim().split(/\s+/);
  const port = Number(fields[5]);
  return Number.isInteger(port) ? port : null;
};

const gatherSample = async () => {
  const pc = new RTCPeerConnection({
    iceServers: stunUrls.map((url) => ({ urls: url })),
    bundlePolicy: "max-bundle",
  });
  pc.createDataChannel("gather");
  const ports = [];
  const complete = new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate?.type === "srflx") {
        const port = candidatePort(event.candidate);
        if (port !== null) ports.push(port);
      }
      if (!event.candidate) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await pc.setLocalDescription(await pc.createOffer());
  await complete;
  pc.close();
  return [...new Set(ports)].sort((left, right) => left - right);
};

const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  samples.push(await gatherSample());
}

const varyingSamples = samples.filter((sample) => sample.length >= 2);
const shapedSamples = varyingSamples.map((sample) => {
  if (sample.length < 2) return null;
  const gaps = sample.slice(1).map((port, index) => port - sample[index]);
  if (gaps.some((gap) => gap <= 0 || gap !== gaps[0])) return null;
  return { gap: gaps[0], center: sample.reduce((sum, port) => sum + port, 0) / sample.length };
}).filter(Boolean);

const gapStable = shapedSamples.length >= 3 && shapedSamples.every(
  (sample) => sample.gap === shapedSamples[0].gap,
);
const centerDirections = shapedSamples.slice(1).map((sample, index) =>
  Math.sign(sample.center - shapedSamples[index].center),
).filter((direction) => direction !== 0);
const directionStable = centerDirections.length >= 2 && centerDirections.every(
  (direction) => direction === centerDirections[0],
);

let classification = "unknown";
if (varyingSamples.length >= Math.ceil(sampleCount / 2)) {
  classification = gapStable ? "sequential-shape" : "unstable";
}
const deltaStability = varyingSamples.length < 3
  ? "insufficient"
  : gapStable ? "stable" : "unstable";
const allocationDirection = directionStable
  ? centerDirections[0] > 0 ? "increasing" : "decreasing"
  : "unknown";

const result = { classification, deltaStability, allocationDirection, sampleCount };
await fetch("/api/survey-result", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(result),
});
document.querySelector("#result").textContent = JSON.stringify(result);
document.title = "survey-complete";
</script>`;

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validRun(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value);
}

function validSide(value) {
  return value === "a" || value === "b";
}

function newSession() {
  return {
    queues: { a: [], b: [] },
    candidates: { a: [], b: [] },
    gathered: { a: false, b: false },
    metadata: { a: null, b: null },
    results: { a: null, b: null },
    mapping: {
      a: { srflxCandidates: 0, signedDelta: null, injectedCandidates: 0 },
      b: { srflxCandidates: 0, signedDelta: null, injectedCandidates: 0 },
    },
    externallyReleased: false,
    released: false,
  };
}

function getSession(run) {
  if (!validRun(run)) throw new Error("invalid run");
  let session = sessions.get(run);
  if (!session) {
    session = newSession();
    sessions.set(run, session);
  }
  return session;
}

function enqueue(session, side, message) {
  session.queues[side].push(message);
}

function parseSrflx(candidateJson) {
  if (!candidateJson || typeof candidateJson.candidate !== "string") return null;
  const fields = candidateJson.candidate.trim().split(/\s+/);
  const typeIndex = fields.indexOf("typ");
  if (fields.length < 8 || typeIndex < 0 || fields[typeIndex + 1] !== "srflx") return null;
  if (fields[2]?.toLowerCase() !== "udp") return null;
  const port = Number(fields[5]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { fields, address: fields[4], port, candidateJson };
}

function predictedCandidates(candidateJsons, requestedWindow) {
  const observations = candidateJsons.map(parseSrflx).filter(Boolean);
  const distinct = [];
  const seen = new Set();
  for (const observation of observations) {
    const key = observation.address + ":" + observation.port;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(observation);
  }
  if (distinct.length < 2) {
    return { candidates: [], srflxCandidates: distinct.length, signedDelta: null };
  }

  const previous = distinct.at(-2);
  const latest = distinct.at(-1);
  if (previous.address !== latest.address) {
    return { candidates: [], srflxCandidates: distinct.length, signedDelta: null };
  }

  const signedDelta = latest.port - previous.port;
  const windowSize = Math.max(0, Math.min(32, Number(requestedWindow) || 0));
  if (signedDelta === 0 || windowSize === 0) {
    return { candidates: [], srflxCandidates: distinct.length, signedDelta };
  }

  const candidates = [];
  for (let index = 1; index <= windowSize; index += 1) {
    const predictedPort = latest.port + signedDelta * index;
    if (predictedPort < 1024 || predictedPort > 65535) break;
    const fields = [...latest.fields];
    fields[0] = "candidate:p" + index;
    fields[5] = String(predictedPort);
    candidates.push({
      ...latest.candidateJson,
      candidate: fields.join(" "),
    });
  }
  return { candidates, srflxCandidates: distinct.length, signedDelta };
}

function releaseCandidates(session) {
  if (session.released || !session.gathered.a || !session.gathered.b) return;
  if (!session.metadata.a || !session.metadata.b) return;
  if ((session.metadata.a.holdRelease || session.metadata.b.holdRelease)
    && !session.externallyReleased) return;

  session.released = true;
  enqueue(session, "a", { type: "release" });
  enqueue(session, "b", { type: "release" });

  for (const sourceSide of ["a", "b"]) {
    const targetSide = sourceSide === "a" ? "b" : "a";
    const metadata = session.metadata[sourceSide];
    const prediction = predictedCandidates(session.candidates[sourceSide], metadata.windowSize);
    session.mapping[sourceSide].srflxCandidates = prediction.srflxCandidates;
    session.mapping[sourceSide].signedDelta = prediction.signedDelta;

    const shouldInject = metadata.mode !== "baseline" && metadata.nat === "sequential";
    if (shouldInject && metadata.mode === "predict-first") {
      for (const candidate of prediction.candidates) {
        enqueue(session, targetSide, { type: "candidate", candidate, predicted: true });
      }
      session.mapping[sourceSide].injectedCandidates = prediction.candidates.length;
    }
    for (const candidate of session.candidates[sourceSide]) {
      enqueue(session, targetSide, { type: "candidate", candidate, predicted: false });
    }
    if (shouldInject && metadata.mode === "predict") {
      for (const candidate of prediction.candidates) {
        enqueue(session, targetSide, { type: "candidate", candidate, predicted: true });
      }
      session.mapping[sourceSide].injectedCandidates = prediction.candidates.length;
    }
    enqueue(session, targetSide, { type: "end-of-candidates" });
  }
}

function publicResult(run, session) {
  const complete = Boolean(session.results.a && session.results.b);
  return {
    run,
    complete,
    success: complete ? Boolean(session.results.a.success && session.results.b.success) : null,
    released: session.released,
    sides: session.results,
    mapping: session.mapping,
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === "/survey") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(surveyPage);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/survey-reset") {
      surveyCounts.clear();
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/survey-result") {
      const body = await readJson(request);
      const classifications = new Set(["unknown", "sequential-shape", "unstable"]);
      const stabilities = new Set(["insufficient", "stable", "unstable"]);
      const directions = new Set(["unknown", "increasing", "decreasing"]);
      if (!classifications.has(body.classification)
        || !stabilities.has(body.deltaStability)
        || !directions.has(body.allocationDirection)) {
        throw new Error("invalid survey result");
      }
      const key = [body.classification, body.deltaStability, body.allocationDirection].join("|");
      surveyCounts.set(key, (surveyCounts.get(key) ?? 0) + 1);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/survey-summary") {
      const buckets = [...surveyCounts.entries()].map(([key, count]) => {
        const [classification, deltaStability, allocationDirection] = key.split("|");
        return { classification, deltaStability, allocationDirection, count };
      });
      json(response, 200, {
        total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        buckets,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      const body = await readJson(request);
      if (!validRun(body.run)) throw new Error("invalid run");
      sessions.set(body.run, newSession());
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const run = url.searchParams.get("run");
      const session = getSession(run);
      json(response, 200, {
        readyForRelease: Boolean(
          session.gathered.a
          && session.gathered.b
          && session.metadata.a
          && session.metadata.b
        ),
        released: session.released,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/release") {
      const body = await readJson(request);
      const session = getSession(body.run);
      session.externallyReleased = true;
      releaseCandidates(session);
      json(response, 200, { ok: true, released: session.released });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/message") {
      const body = await readJson(request);
      if (!validRun(body.run) || !validSide(body.side)) throw new Error("invalid message owner");
      const session = getSession(body.run);
      const otherSide = body.side === "a" ? "b" : "a";
      if (body.type === "hello") {
        const windowSize = Math.max(0, Math.min(32, Number(body.windowSize) || 0));
        session.metadata[body.side] = {
          nat: String(body.nat),
          mode: ["predict", "predict-first"].includes(body.mode) ? body.mode : "baseline",
          windowSize,
          holdRelease: Boolean(body.holdRelease),
        };
      } else if (body.type === "description") {
        enqueue(session, otherSide, { type: "description", description: body.description });
      } else if (body.type === "candidate") {
        session.candidates[body.side].push(body.candidate);
      } else if (body.type === "gathered") {
        session.gathered[body.side] = true;
      } else {
        throw new Error("invalid message type");
      }
      releaseCandidates(session);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/poll") {
      const run = url.searchParams.get("run");
      const side = url.searchParams.get("side");
      if (!validRun(run) || !validSide(side)) throw new Error("invalid poll owner");
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const queue = getSession(run).queues[side];
      json(response, 200, { messages: queue.slice(after), next: queue.length });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/result") {
      const body = await readJson(request);
      if (!validRun(body.run) || !validSide(body.side)) throw new Error("invalid result owner");
      const session = getSession(body.run);
      session.results[body.side] = {
        success: Boolean(body.success),
        elapsedMs: Number.isFinite(body.elapsedMs) ? body.elapsedMs : null,
        connectionState: String(body.connectionState),
        iceConnectionState: String(body.iceConnectionState),
        localCandidates: Number(body.localCandidates) || 0,
        localSrflxCandidates: Number(body.localSrflxCandidates) || 0,
        predictedCandidatesReceived: Number(body.predictedCandidatesReceived) || 0,
      };
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/result") {
      const run = url.searchParams.get("run");
      const session = getSession(run);
      json(response, 200, publicResult(run, session));
      return;
    }
    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "request failed" });
  }
});

server.listen(port, bindAddress);
