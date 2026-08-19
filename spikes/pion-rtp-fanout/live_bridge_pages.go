package fanoutoracle

import (
	"strconv"
	"strings"
)

func liveBridgeHostPage(token string) string {
	return strings.ReplaceAll(liveBridgeHostHTML, "__TOKEN__", token)
}

func liveBridgeViewerPage(token string, index int) string {
	page := strings.ReplaceAll(liveBridgeViewerHTML, "__TOKEN__", token)
	return strings.ReplaceAll(page, "__VIEWER_ID__", strconv.Itoa(index+1))
}

const liveBridgeHostHTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Screener live WebCodecs bridge host</title>
<body>
<canvas id="source" width="320" height="180"></canvas>
<script>
const token = "__TOKEN__";
const width = 320;
const height = 180;
const fps = 30;
const frameCount = 360;
const durationMicros = Math.round(1_000_000 / fps);
const socketBufferedBytesLimit = 512 * 1024;
const encoderQueueLimit = 4;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

async function postError(error) {
  try {
    await fetch("/api/host-error?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({error: String(error && (error.stack || error))}),
    });
  } catch {}
}

function packChunk(chunk) {
  const packet = new ArrayBuffer(17 + chunk.byteLength);
  const view = new DataView(packet);
  view.setUint8(0, chunk.type === "key" ? 1 : 2);
  view.setBigUint64(1, BigInt(chunk.timestamp));
  view.setBigUint64(9, BigInt(chunk.duration || durationMicros));
  chunk.copyTo(new Uint8Array(packet, 17));
  return packet;
}

async function run() {
  if (!("VideoEncoder" in window) || !("VideoFrame" in window) || !("WebSocket" in window)) {
    throw new Error("WebCodecs VideoEncoder/VideoFrame or WebSocket is unavailable");
  }
  const requestedConfig = {
    codec: "vp8",
    width,
    height,
    bitrate: 600_000,
    framerate: fps,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
  };
  const support = await VideoEncoder.isConfigSupported(requestedConfig);
  if (!support.supported) {
    throw new Error("the browser WebCodecs implementation does not support the live VP8 config");
  }
  const hardwareAccelerationHint = support.config.hardwareAcceleration || requestedConfig.hardwareAcceleration;

  const socketURL = new URL("/api/live?token=" + encodeURIComponent(token), location.href);
  socketURL.protocol = "ws:";
  const socket = new WebSocket(socketURL);
  socket.binaryType = "arraybuffer";
  let closeResolve;
  let closeReject;
  const closed = new Promise((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  let forceKeyFrame = true;
  let droppingUntilKeyFrame = false;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const control = JSON.parse(event.data);
    if (control.kind === "request-keyframe") {
      forceKeyFrame = true;
    }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 1000) {
      closeResolve();
    } else {
      closeReject(new Error("live IPC closed with code " + event.code + ": " + event.reason));
    }
  });
  socket.addEventListener("error", () => closeReject(new Error("live IPC WebSocket failed")));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", () => reject(new Error("live IPC WebSocket did not open")), {once: true});
  });

  let encoderInstances = 0;
  let encoderFailure;
  let encoderInputCalls = 0;
  let encoderInputDrops = 0;
  let encoderOutputs = 0;
  let encoderOutputBytes = 0;
  let sentChunks = 0;
  let sentChunkBytes = 0;
  let keyFrames = 0;
  let socketDroppedChunks = 0;
  let maxEncoderQueueSize = 0;
  let maxSocketBufferedBytes = 0;
  const encoder = new VideoEncoder({
    output(chunk) {
      encoderOutputs++;
      encoderOutputBytes += chunk.byteLength;
      if (chunk.type === "key") {
        keyFrames++;
      }
      if (droppingUntilKeyFrame && chunk.type !== "key") {
        socketDroppedChunks++;
        forceKeyFrame = true;
        return;
      }
      const packet = packChunk(chunk);
      if (socket.bufferedAmount + packet.byteLength > socketBufferedBytesLimit) {
        socketDroppedChunks++;
        droppingUntilKeyFrame = true;
        forceKeyFrame = true;
        return;
      }
      if (chunk.type === "key") {
        droppingUntilKeyFrame = false;
      }
      socket.send(packet);
      sentChunks++;
      sentChunkBytes += chunk.byteLength;
      maxSocketBufferedBytes = Math.max(maxSocketBufferedBytes, socket.bufferedAmount);
    },
    error(error) {
      encoderFailure = error;
    },
  });
  encoderInstances++;
  socket.send(JSON.stringify({
    kind: "config",
    codec: support.config.codec,
    width,
    height,
    fps,
    encoderInstances,
    hardwareAccelerationHint,
    socketBufferedBytesLimit,
    encoderQueueLimit,
  }));
  encoder.configure(support.config);

  const canvas = document.querySelector("#source");
  const context = canvas.getContext("2d", {alpha: false});
  const started = performance.now();
  for (let index = 0; index < frameCount; index++) {
    await delay(started + index * (1000 / fps) - performance.now());
    context.fillStyle = "hsl(" + ((index * 7) % 360) + " 85% 42%)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect((index * 5) % (width - 48), 42, 48, 48);
    context.fillStyle = "#111111";
    context.font = "bold 24px sans-serif";
    context.fillText(String(index).padStart(3, "0"), 112, 105);

    if (encoder.encodeQueueSize >= encoderQueueLimit) {
      encoderInputDrops++;
      forceKeyFrame = true;
      continue;
    }
    const frame = new VideoFrame(canvas, {
      timestamp: index * durationMicros,
      duration: durationMicros,
    });
    const keyFrame = forceKeyFrame || index % fps === 0;
    forceKeyFrame = false;
    encoder.encode(frame, {keyFrame});
    encoderInputCalls++;
    maxEncoderQueueSize = Math.max(maxEncoderQueueSize, encoder.encodeQueueSize);
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (encoderFailure) {
    throw encoderFailure;
  }

  socket.send(JSON.stringify({
    kind: "complete",
    host: {
      userAgent: navigator.userAgent,
      encoderInstances,
      encoderInputCalls,
      encoderOutputs,
      sentChunks,
      keyFrames,
      encoderOutputBytes,
      sentChunkBytes,
      encoderInputDrops,
      socketDroppedChunks,
      maxEncoderQueueSize,
      maxSocketBufferedBytes,
      socketBufferedBytesLimit,
      encoderQueueLimit,
      hardwareAccelerationHint,
      elapsedMillis: Math.round(performance.now() - started),
    },
  }));

  await Promise.race([
    closed,
    delay(5000).then(() => { throw new Error("live IPC close acknowledgement timed out"); }),
  ]);
  document.body.dataset.complete = "true";
}

run().catch(async (error) => {
  document.body.dataset.error = String(error && (error.stack || error));
  await postError(error);
});
</script>
</body>
</html>`

const liveBridgeViewerHTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Screener live bridge viewer</title>
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(path, value) {
  const response = await fetch(path + "?token=" + encodeURIComponent(token) + "&id=" + viewerID, {
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
  if (renderedFrameCallbacks <= 5 || renderedFrameCallbacks % 15 === 0) {
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
    delay(3000).then(() => { throw new Error("remote track was not signaled"); }),
  ]);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering();
  await request("/api/answer", pc.localDescription.toJSON());
  await request("/api/ready");

  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    const state = await request("/api/state");
    if (state.error) {
      throw new Error(state.error);
    }
    if (state.complete) {
      await delay(500);
      const metrics = await collectMetrics();
      await request("/api/result", metrics);
      document.body.dataset.complete = "true";
      return;
    }
    await delay(100);
  }
  throw new Error("live bridge did not complete within 25 seconds");
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
