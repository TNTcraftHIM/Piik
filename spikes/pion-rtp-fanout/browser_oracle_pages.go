package fanoutoracle

import (
	"strconv"
	"strings"
)

func fixtureOraclePage(token string) string {
	return strings.ReplaceAll(fixtureOracleHTML, "__TOKEN__", token)
}

func viewerOraclePage(token string, index int) string {
	page := strings.ReplaceAll(viewerOracleHTML, "__TOKEN__", token)
	return strings.ReplaceAll(page, "__VIEWER_ID__", strconv.Itoa(index+1))
}

const fixtureOracleHTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Screener VP8 fixture generator</title>
<body>
<canvas id="source" width="320" height="180"></canvas>
<script>
const token = "__TOKEN__";
const width = 320;
const height = 180;
const fps = 30;
const frameCount = 120;
const durationMicros = Math.round(1_000_000 / fps);

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function post(path, value) {
  const response = await fetch(path + "?token=" + token, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    throw new Error(path + " returned " + response.status + ": " + await response.text());
  }
}

async function generateFixture() {
  if (!("VideoEncoder" in window) || !("VideoFrame" in window)) {
    throw new Error("WebCodecs VideoEncoder/VideoFrame is unavailable");
  }
  const config = {
    codec: "vp8",
    width,
    height,
    bitrate: 600_000,
    framerate: fps,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error("the browser WebCodecs implementation does not support VP8 encoding");
  }

  const encoded = [];
  let encoderFailure;
  const encoder = new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      encoded.push({
        timestampMicros: chunk.timestamp,
        durationMicros: chunk.duration || durationMicros,
        type: chunk.type,
        data: bytesToBase64(bytes),
      });
    },
    error(error) {
      encoderFailure = error;
    },
  });
  encoder.configure(support.config);

  const canvas = document.querySelector("#source");
  const context = canvas.getContext("2d", {alpha: false});
  let encoderInputCalls = 0;
  for (let index = 0; index < frameCount; index++) {
    context.fillStyle = "hsl(" + ((index * 7) % 360) + " 85% 42%)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect((index * 5) % (width - 48), 42, 48, 48);
    context.fillStyle = "#111111";
    context.font = "bold 24px sans-serif";
    context.fillText(String(index).padStart(3, "0"), 112, 105);

    const timestamp = index * durationMicros;
    const frame = new VideoFrame(canvas, {timestamp, duration: durationMicros});
    encoder.encode(frame, {keyFrame: index % 30 === 0});
    encoderInputCalls++;
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (encoderFailure) {
    throw encoderFailure;
  }
  encoded.sort((first, second) => first.timestampMicros - second.timestampMicros);

  await post("/api/fixture", {
    codec: "vp8",
    width,
    height,
    fps,
    encoderInputCalls,
    frames: encoded,
  });
  document.body.dataset.complete = "true";
}

generateFixture().catch(async (error) => {
  document.body.dataset.error = String(error && (error.stack || error));
  try {
    await post("/api/fixture-error", {error: document.body.dataset.error});
  } catch {}
});
</script>
</body>
</html>`

const viewerOracleHTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Screener browser receiver oracle</title>
<body>
<video id="remote" muted autoplay playsinline width="320" height="180"></video>
<canvas id="sample" width="16" height="9" hidden></canvas>
<script>
const token = "__TOKEN__";
const viewerID = __VIEWER_ID__;
const video = document.querySelector("#remote");
const sampleCanvas = document.querySelector("#sample");
const sampleContext = sampleCanvas.getContext("2d", {alpha: false, willReadFrequently: true});
const pc = new RTCPeerConnection();
let renderedFrameCallbacks = 0;
const renderedPixelHashes = [];
const renderedPixelHashSet = new Set();
let trackSeenResolve;
const trackSeen = new Promise((resolve) => { trackSeenResolve = resolve; });

async function request(path, value) {
  const response = await fetch(path + "?token=" + token + "&id=" + viewerID, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: value === undefined ? "{}" : JSON.stringify(value),
  });
  if (!response.ok) {
    throw new Error(path + " returned " + response.status + ": " + await response.text());
  }
  if (response.status === 204) {
    return undefined;
  }
  return response.json();
}

function waitForIceGathering() {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const listener = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", listener);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", listener);
  });
}

function hashRenderedFrame() {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    return;
  }
  sampleContext.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
  const data = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
  let hash = 2166136261;
  for (const value of data) {
    hash = Math.imul(hash ^ value, 16777619) >>> 0;
  }
  if (!renderedPixelHashSet.has(hash)) {
    renderedPixelHashSet.add(hash);
    renderedPixelHashes.push(hash);
  }
}

function onRenderedFrame() {
  renderedFrameCallbacks++;
  if (renderedFrameCallbacks <= 5 || renderedFrameCallbacks % 5 === 0) {
    hashRenderedFrame();
  }
  video.requestVideoFrameCallback(onRenderedFrame);
}

pc.ontrack = (event) => {
  video.srcObject = event.streams[0] || new MediaStream([event.track]);
  video.play().catch(() => {});
  video.requestVideoFrameCallback(onRenderedFrame);
  trackSeenResolve();
};

async function collectMetrics() {
  const reports = await pc.getStats();
  let inbound;
  for (const report of reports.values()) {
    if (report.type === "inbound-rtp" && !report.isRemote && (report.kind === "video" || report.mediaType === "video")) {
      inbound = report;
      break;
    }
  }
  const transport = inbound && inbound.transportId ? reports.get(inbound.transportId) : undefined;
  const pair = transport && transport.selectedCandidatePairId ? reports.get(transport.selectedCandidatePairId) : undefined;
  const local = pair && pair.localCandidateId ? reports.get(pair.localCandidateId) : undefined;
  const remote = pair && pair.remoteCandidateId ? reports.get(pair.remoteCandidateId) : undefined;
  return {
    userAgent: navigator.userAgent,
    peerConnectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    dtlsState: transport && transport.dtlsState || "",
    candidatePairState: pair && pair.state || "",
    localCandidateType: local && local.candidateType || "",
    remoteCandidateType: remote && remote.candidateType || "",
    inboundSsrc: inbound && inbound.ssrc || 0,
    packetsReceived: inbound && inbound.packetsReceived || 0,
    bytesReceived: inbound && inbound.bytesReceived || 0,
    framesReceived: inbound && inbound.framesReceived || 0,
    framesDecoded: inbound && inbound.framesDecoded || 0,
    framesRendered: inbound && inbound.framesRendered || 0,
    keyFramesDecoded: inbound && inbound.keyFramesDecoded || 0,
    frameWidth: inbound && inbound.frameWidth || video.videoWidth || 0,
    frameHeight: inbound && inbound.frameHeight || video.videoHeight || 0,
    renderedFrameCallbacks,
    renderedPixelHashes,
    decoderImplementation: inbound && inbound.decoderImplementation || "",
    powerEfficientDecoder: Boolean(inbound && inbound.powerEfficientDecoder),
  };
}

async function run() {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    throw new Error("requestVideoFrameCallback is unavailable");
  }
  const offer = await request("/api/offer");
  await pc.setRemoteDescription(offer);
  await Promise.race([
    trackSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("remote track was not signaled")), 3000)),
  ]);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering();
  await request("/api/answer", pc.localDescription.toJSON());
  await request("/api/ready");

  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const metrics = await collectMetrics();
    if (metrics.framesDecoded >= 30 && renderedFrameCallbacks >= 20 && renderedPixelHashes.length >= 2) {
      await request("/api/result", metrics);
      document.body.dataset.complete = "true";
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const metrics = await collectMetrics();
  throw new Error("decode/render threshold not reached: " + JSON.stringify(metrics));
}

run().catch(async (error) => {
  const message = String(error && (error.stack || error));
  document.body.dataset.error = message;
  try {
    await request("/api/result", {userAgent: navigator.userAgent, error: message});
  } catch {}
});
</script>
</body>
</html>`
