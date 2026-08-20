import {
  HARDWARE_PREFERENCE,
  HARDWARE_STATUS,
  retainsHardwarePreference,
} from "./hardware-status.js";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const BITRATE = 3_000_000;
const FRAME_DURATION = Math.round(1_000_000 / FPS);
const MAX_ENCODER_QUEUE = 2;
const MAX_SOCKET_BUFFER = 512 * 1024;
const MAX_FRAME_BYTES = 1 << 20;
const ENVELOPE_HEADER_BYTES = 20;
const MEDIA_KIND_VIDEO = 1;
const MEDIA_KIND_PCM = 2;
const MEDIA_KIND_OPUS = 3;

const fragment = new URLSearchParams(location.hash.slice(1));
const processToken = fragment.get("token") || "";
history.replaceState(null, "", location.pathname);

const elements = {
  serverURL: document.querySelector("#server-url"),
  password: document.querySelector("#password"),
  codec: document.querySelector("#codec"),
  audioTarget: document.querySelector("#audio-target"),
  refreshAudio: document.querySelector("#refresh-audio"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  preview: document.querySelector("#preview"),
  empty: document.querySelector("#empty-state"),
  invite: document.querySelector("#invite"),
  inviteLink: document.querySelector("#invite-link"),
  copy: document.querySelector("#copy"),
  status: document.querySelector("#status"),
  viewerCount: document.querySelector("#viewer-count"),
  error: document.querySelector("#error"),
  captureDiagnostic: document.querySelector("#capture-diagnostic"),
  encoderDiagnostic: document.querySelector("#encoder-diagnostic"),
  bridgeDiagnostic: document.querySelector("#bridge-diagnostic"),
  helperDiagnostic: document.querySelector("#helper-diagnostic"),
  edgeDiagnostic: document.querySelector("#edge-diagnostic"),
  audioStatus: document.querySelector("#audio-status"),
};

let stream = null;
let processorReader = null;
let encoder = null;
let audioEncoder = null;
let silentAudioChunks = 0;
let mediaSocket = null;
let sharing = false;
let stopping = false;
let startInFlight = false;
let roomGeneration = 0;
let forceKeyFrame = true;
let frameNumber = 0;
let captureSettings = null;
let nativeDiagnostics = null;
let metrics = emptyMetrics();
let startGeneration = 0;
let diagnosticsTimer = null;
let pendingStartGeneration = 0;

if (!processToken) {
  showError("本地发送端令牌已失效，请重新启动 sender.exe");
  elements.start.disabled = true;
}

elements.start.addEventListener("click", () => void startSharing());
elements.stop.addEventListener("click", () => void stopSharing(startGeneration));
elements.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.inviteLink.href);
    elements.copy.textContent = "✓";
    setTimeout(() => { elements.copy.textContent = "⧉"; }, 1200);
  } catch {
    showError("无法复制链接，请直接打开邀请链接");
  }
});
elements.refreshAudio.addEventListener("click", () => void loadAudioTargets());
if (processToken) void loadAudioTargets();

async function startSharing() {
  if (sharing || stopping || startInFlight) return;
  showError("");
  if (!("VideoEncoder" in window) || !("MediaStreamTrackProcessor" in window)) {
    showError("此浏览器缺少 WebCodecs 屏幕编码支持，请使用当前版 Chrome 或 Edge");
    return;
  }
  startInFlight = true;
  elements.start.disabled = true;
  const generation = ++startGeneration;
  const codec = selectedCodec();
  const audioTargetId = elements.audioTarget.value;
  if (audioTargetId && (!("AudioEncoder" in window) || !("AudioData" in window))) {
    showError("当前浏览器缺少 WebCodecs Opus 编码支持，请关闭目标进程音频或使用当前版 Chrome / Edge");
    startInFlight = false;
    elements.start.disabled = false;
    return;
  }
  setStatus("选择屏幕");
  try {
    const capturedStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: WIDTH, max: WIDTH },
        height: { ideal: HEIGHT, max: HEIGHT },
        frameRate: { ideal: FPS, max: FPS },
      },
      audio: false,
    });
    assertCurrentStart(generation, mediaSocket, capturedStream);
    stream = capturedStream;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("没有可用的视频轨道");
    await videoTrack.applyConstraints({ width: WIDTH, height: HEIGHT, frameRate: FPS });
    assertCurrentStart(generation);
    captureSettings = videoTrack.getSettings();
    updateDiagnostics();
    videoTrack.addEventListener("ended", () => void stopSharing(generation), { once: true });
    elements.preview.srcObject = stream;
    elements.empty.hidden = true;

    setStatus("创建房间");
    pendingStartGeneration = generation;
    const room = await localRequest("/api/start", {
      serverUrl: elements.serverURL.value,
      password: elements.password.value,
      codec,
      audioTargetId,
    });
    assertCurrentStart(generation);
    if (pendingStartGeneration === generation) pendingStartGeneration = 0;
    roomGeneration = generation;
    elements.password.value = "";
    elements.inviteLink.href = room.inviteUrl;
    elements.inviteLink.textContent = room.inviteUrl;
    elements.invite.hidden = false;

    if (audioTargetId) await startAudioEncoder(generation);
    await connectMediaSocket(generation, codec, Boolean(audioTargetId));
    assertCurrentStart(generation);
    const activeEncoder = await startEncoder(generation, codec);
    assertCurrentStart(generation);
    sharing = true;
    elements.stop.hidden = false;
    setStatus("正在分享");
    void readFrames(videoTrack, generation, activeEncoder, mediaSocket);
  } catch (error) {
    if (generation === startGeneration && !(error instanceof StaleStartError)) {
      showError(readableError(error, "无法开始分享"));
    }
    await stopSharing(generation);
  } finally {
    startInFlight = false;
    elements.start.disabled = sharing || stopping;
  }
}

async function connectMediaSocket(generation, codec, audio) {
  const url = new URL("/media", location.href);
  url.protocol = "ws:";
  const socket = new WebSocket(url, [`screener.token.${processToken}`]);
  mediaSocket = socket;
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => handleLocalEvent(generation, socket, event));
  socket.addEventListener("close", () => {
    if (generation === startGeneration && !stopping && mediaSocket === socket) {
      void failSharing(generation, "本地媒体连接意外断开");
    }
  });

  const ready = waitForLocalKind(socket, "ready", "等待本地媒体服务超时");
  await waitForSocketOpen(socket);
  assertCurrentStart(generation, socket);
  await ready;
  assertCurrentStart(generation, socket);
  const accepted = waitForLocalKind(socket, "config-accepted", "本地编码配置确认超时");
  socket.send(JSON.stringify({
    kind: "config",
    codec,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    bitrate: BITRATE,
    encoderInstances: 1,
    audio,
  }));
  await accepted;
  assertCurrentStart(generation, socket);
}

async function startEncoder(generation, codec) {
  const preferred = {
    codec: codec === "h264" ? "avc1.42c01f" : "vp8",
    width: WIDTH,
    height: HEIGHT,
    bitrate: BITRATE,
    framerate: FPS,
    latencyMode: "realtime",
    bitrateMode: "variable",
    hardwareAcceleration: HARDWARE_PREFERENCE,
  };
  if (codec === "h264") preferred.avc = { format: "annexb" };
  let support = await VideoEncoder.isConfigSupported(preferred);
  assertCurrentStart(generation, mediaSocket);
  if (!retainsHardwarePreference(support)) {
    const fallback = { ...preferred };
    delete fallback.hardwareAcceleration;
    support = await VideoEncoder.isConfigSupported(fallback);
    assertCurrentStart(generation, mediaSocket);
    metrics.hardwarePreference = support.supported
      ? HARDWARE_STATUS.FALLBACK
      : HARDWARE_STATUS.UNSUPPORTED;
  } else {
    metrics.hardwarePreference = HARDWARE_STATUS.PREFERENCE_ACCEPTED;
  }
  metrics.hardwareEvidence = HARDWARE_STATUS.UNVERIFIED;
  if (!support.supported) throw new Error("此设备不支持 VP8 720p30 编码");
  let activeEncoder;
  activeEncoder = new VideoEncoder({
    output: (chunk) => sendEncodedChunk(generation, activeEncoder, chunk),
    error: (error) => void failSharing(generation, `编码器失败：${error.message}`),
  });
  encoder = activeEncoder;
  activeEncoder.configure(support.config);
  updateDiagnostics();
  return activeEncoder;
}

async function readFrames(videoTrack, generation, activeEncoder, activeSocket) {
  const processor = new MediaStreamTrackProcessor({ track: videoTrack });
  const reader = processor.readable.getReader();
  if (generation !== startGeneration || encoder !== activeEncoder || mediaSocket !== activeSocket) {
    await reader.cancel();
    return;
  }
  processorReader = reader;
  try {
    while (generation === startGeneration && sharing && encoder === activeEncoder &&
      mediaSocket === activeSocket && activeSocket?.readyState === WebSocket.OPEN) {
      const { value: frame, done } = await reader.read();
      if (done) {
        if (generation === startGeneration && sharing && !stopping) {
          await failSharing(generation, "屏幕画面读取意外结束");
        }
        return;
      }
      if (generation !== startGeneration || !sharing || encoder !== activeEncoder ||
        mediaSocket !== activeSocket || processorReader !== reader) {
        frame.close();
        return;
      }
      metrics.framesRead += 1;
      try {
        const queueSize = activeEncoder.encodeQueueSize;
        metrics.encoderQueuePeak = Math.max(metrics.encoderQueuePeak, queueSize);
        if (activeEncoder.state === "configured" && queueSize < MAX_ENCODER_QUEUE) {
          const keyFrame = forceKeyFrame || frameNumber % (FPS * 2) === 0;
          forceKeyFrame = false;
          activeEncoder.encode(frame, { keyFrame });
          frameNumber += 1;
          metrics.framesSubmitted += 1;
        } else {
          metrics.encoderQueueDrops += 1;
          forceKeyFrame = true;
        }
      } finally {
        frame.close();
      }
      scheduleDiagnostics();
    }
  } catch (error) {
    if (generation === startGeneration && sharing && !stopping && encoder === activeEncoder) {
      await failSharing(generation, readableError(error, "读取屏幕画面失败"));
    }
  }
}

function sendEncodedChunk(generation, activeEncoder, chunk) {
  if (generation !== startGeneration || stopping || !sharing || encoder !== activeEncoder) return;
  try {
    if (!mediaSocket || mediaSocket.readyState !== WebSocket.OPEN) {
      if (!stopping) void failSharing(generation, "本地媒体连接不可用");
      return;
    }
    if (mediaSocket.bufferedAmount > MAX_SOCKET_BUFFER) {
      void failSharing(generation, "本地媒体桥接积压超过安全上限");
      return;
    }
    if (chunk.byteLength < 1 || chunk.byteLength > MAX_FRAME_BYTES) {
      void failSharing(generation, "编码帧大小超出本地媒体契约");
      return;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const message = mediaEnvelope(
      MEDIA_KIND_VIDEO,
      chunk.type === "key" ? 1 : 0,
      BigInt(Math.max(0, chunk.timestamp)) * 10n,
      BigInt(chunk.duration || FRAME_DURATION) * 10n,
      data,
    );
    mediaSocket.send(message);
    metrics.encoderOutputs += 1;
    metrics.encodedBytes += data.byteLength;
    metrics.socketBufferedPeak = Math.max(metrics.socketBufferedPeak, mediaSocket.bufferedAmount);
    scheduleDiagnostics();
  } catch (error) {
    void failSharing(generation, readableError(error, "发送编码帧失败"));
  }
}

function handleLocalEvent(generation, socket, event) {
  if (generation !== startGeneration || socket !== mediaSocket) return;
  if (event.data instanceof ArrayBuffer) {
    handlePCM(generation, event.data);
    return;
  }
  if (typeof event.data !== "string") return;
  const message = parseLocalMessage(event.data);
  if (!message) return;
  if (message.kind === "request-keyframe") forceKeyFrame = true;
  if (message.kind === "viewer-count" || message.kind === "ready") {
    showViewerCounts(message.activeViewers, message.waitingViewers);
  }
  if (message.kind === "diagnostics") {
    nativeDiagnostics = message;
    updateDiagnostics();
  }
  if (message.kind === "warning" && message.message) showError(message.message);
  if (message.kind === "audio-state") {
    elements.audioStatus.textContent = message.state === "unavailable"
      ? "不可用（未回退系统声音）"
      : "正在连接目标进程";
  }
  if (message.kind === "fatal") {
    void failSharing(generation, message.message || "分享会话已失败并停止");
  }
}

async function failSharing(generation, message) {
  if (generation !== startGeneration || stopping) return;
  showError(message);
  await stopSharing(generation);
}

async function stopSharing(expectedGeneration = startGeneration) {
  if (expectedGeneration !== startGeneration || stopping) return;
  stopping = true;
  startGeneration += 1;
  sharing = false;
  setStatus("正在停止");
  let stopError = null;
  const rememberError = (error) => {
    if (stopError === null) stopError = error;
  };
  try {
    const reader = processorReader;
    processorReader = null;
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch (error) {
      rememberError(error);
    }
    stream = null;
    elements.preview.srcObject = null;
    try {
      await reader?.cancel();
    } catch (error) {
      rememberError(error);
    }
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch (error) {
      rememberError(error);
    }
    encoder = null;
    try {
      if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
    } catch (error) {
      rememberError(error);
    }
    audioEncoder = null;
    const socket = mediaSocket;
    mediaSocket = null;
    try {
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "sender stopped");
    } catch (error) {
      rememberError(error);
    }
    if (roomGeneration === expectedGeneration || pendingStartGeneration === expectedGeneration) {
      try {
        await stopLocalSession(expectedGeneration);
      } catch (error) {
        rememberError(error);
      }
    }
    if (stopError !== null) showError(readableError(stopError, "停止分享失败"));
  } finally {
    frameNumber = 0;
    forceKeyFrame = true;
    silentAudioChunks = 0;
    captureSettings = null;
    nativeDiagnostics = null;
    metrics = emptyMetrics();
    if (diagnosticsTimer !== null) {
      clearTimeout(diagnosticsTimer);
      diagnosticsTimer = null;
    }
    updateDiagnostics();
    elements.empty.hidden = false;
    elements.invite.hidden = true;
    elements.stop.hidden = true;
    elements.start.disabled = startInFlight;
    showViewerCounts(0, 0);
    setStatus("未开始");
    elements.audioStatus.textContent = "关闭";
    stopping = false;
  }
}

async function stopLocalSession(generation) {
  if (roomGeneration === generation) roomGeneration = 0;
  if (pendingStartGeneration === generation) pendingStartGeneration = 0;
  await localRequest("/api/stop");
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("本地媒体连接超时")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("本地媒体连接失败"));
    }, { once: true });
  });
}

function waitForLocalKind(socket, kind, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error(timeoutMessage)), 5000);
    const onMessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseLocalMessage(event.data);
      if (!message) return;
      if (message.kind === kind) finish(resolve, message);
      if (message.kind === "fatal") finish(reject, new Error(message.message || "分享会话已失败"));
    };
    const onClose = () => finish(reject, new Error("本地媒体连接在确认前关闭"));
    const finish = (callback, value) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      callback(value);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function localRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Screener-Process-Token": processToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`本地发送端返回 HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(result.error || `本地发送端返回 HTTP ${response.status}`);
  return result;
}

async function loadAudioTargets() {
  elements.refreshAudio.disabled = true;
  const previous = elements.audioTarget.value;
  try {
    const result = await localRequest("/api/audio-targets");
    elements.audioTarget.replaceChildren(new Option("关闭", ""));
    for (const target of Array.isArray(result.targets) ? result.targets : []) {
      if (target?.id && target?.title) elements.audioTarget.add(new Option(target.title, target.id));
    }
    if ([...elements.audioTarget.options].some((option) => option.value === previous)) {
      elements.audioTarget.value = previous;
    }
    elements.audioTarget.disabled = !result.supported;
    elements.audioStatus.textContent = result.supported ? "关闭" : "Windows 11 helper 不可用";
  } catch (error) {
    elements.audioTarget.disabled = true;
    elements.audioStatus.textContent = readableError(error, "窗口列表不可用");
  } finally {
    elements.refreshAudio.disabled = false;
  }
}

async function startAudioEncoder(generation) {
  const config = { codec: "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 };
  const support = await AudioEncoder.isConfigSupported(config);
  assertCurrentStart(generation);
  if (!support.supported) throw new Error("当前浏览器不支持 WebCodecs Opus 编码");
  let active;
  active = new AudioEncoder({
    output: (chunk) => sendEncodedAudio(generation, active, chunk),
    error: (error) => void failSharing(generation, `音频编码器失败：${error.message}`),
  });
  audioEncoder = active;
  active.configure(support.config);
  elements.audioStatus.textContent = "等待目标进程音频";
}

function handlePCM(generation, message) {
  if (generation !== startGeneration || !audioEncoder || audioEncoder.state !== "configured") return;
  if (audioEncoder.encodeQueueSize >= 4) return;
  try {
    const view = new DataView(message);
    if (message.byteLength <= ENVELOPE_HEADER_BYTES || view.getUint8(0) !== 1 ||
      view.getUint8(1) !== MEDIA_KIND_PCM || view.getUint8(2) !== 0 || view.getUint8(3) !== 0) {
      throw new Error("本地 PCM envelope 无效");
    }
    const data = new Uint8Array(message, ENVELOPE_HEADER_BYTES);
    if (data.byteLength % 4 !== 0) throw new Error("本地 PCM 帧长度无效");
    let audible = false;
    for (const byte of data) if (byte !== 0) { audible = true; break; }
    silentAudioChunks = audible ? 0 : silentAudioChunks + 1;
    elements.audioStatus.textContent = silentAudioChunks >= 100
      ? "目标进程当前无声（未回退系统声音）"
      : "目标进程树音频";
    const audio = new AudioData({
      format: "s16", sampleRate: 48_000, numberOfChannels: 2,
      numberOfFrames: data.byteLength / 4,
      timestamp: Number(view.getBigUint64(4, false) / 10n), data,
    });
    audioEncoder.encode(audio);
    audio.close();
  } catch (error) {
    void failSharing(generation, readableError(error, "处理目标进程音频失败"));
  }
}

function sendEncodedAudio(generation, activeEncoder, chunk) {
  if (generation !== startGeneration || stopping || audioEncoder !== activeEncoder ||
    !mediaSocket || mediaSocket.readyState !== WebSocket.OPEN) return;
  if (chunk.byteLength < 1 || chunk.byteLength > 64 * 1024 ||
    mediaSocket.bufferedAmount > MAX_SOCKET_BUFFER) {
    void failSharing(generation, "本地音频桥接超过安全上限");
    return;
  }
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  mediaSocket.send(mediaEnvelope(
    MEDIA_KIND_OPUS, 0, BigInt(Math.max(0, chunk.timestamp)) * 10n,
    BigInt(chunk.duration || 20_000) * 10n, data,
  ));
}

function mediaEnvelope(kind, flags, timestamp100ns, duration100ns, data) {
  const message = new ArrayBuffer(ENVELOPE_HEADER_BYTES + data.byteLength);
  const view = new DataView(message);
  view.setUint8(0, 1);
  view.setUint8(1, kind);
  view.setUint8(2, flags);
  view.setBigUint64(4, timestamp100ns, false);
  view.setBigUint64(12, duration100ns, false);
  new Uint8Array(message, ENVELOPE_HEADER_BYTES).set(data);
  return message;
}

function showViewerCounts(activeValue, waitingValue) {
  const active = boundedCount(activeValue);
  const waiting = boundedCount(waitingValue);
  elements.viewerCount.textContent = waiting > 0
    ? `${active} 位已分配/连接中，${waiting} 位等待`
    : `${active} 位已分配/连接中`;
}

function updateDiagnostics() {
  const width = captureSettings?.width ?? "未知";
  const height = captureSettings?.height ?? "未知";
  const rate = captureSettings?.frameRate ?? "未知";
  elements.captureDiagnostic.textContent = `${width} × ${height} · ${rate} FPS`;
  elements.encoderDiagnostic.textContent = `VP8 · 3 Mbps 上限 · 单对象 · 硬件偏好 ${hardwarePreferenceLabel(metrics.hardwarePreference)} · 硬件证据 ${hardwareEvidenceLabel(metrics.hardwareEvidence)}`;
  elements.bridgeDiagnostic.textContent = `读取 ${metrics.framesRead} · 提交 ${metrics.framesSubmitted} · 输出 ${metrics.encoderOutputs} · 编码队列丢弃 ${metrics.encoderQueueDrops} · 编码队列峰值 ${metrics.encoderQueuePeak} 帧 · socket 峰值 ${metrics.socketBufferedPeak} B`;
  const helper = nativeDiagnostics?.media;
  const queue = helper?.queue;
  elements.helperDiagnostic.textContent = helper && queue
    ? `帧 ${helper.framesWritten} · 源 RTP ${helper.sourceRtpPacketsWritten} 包 / ${formatBytes(helper.sourceRtpBytesWritten)} · 队列 ${queue.depth}/${queue.capacity}，峰值 ${queue.maxDepth} · 丢弃 ${queue.droppedFrames} · 过载 ${queue.overloadEvents} · 恢复 ${queue.completedRecoveries}`
    : "尚无数据";
  const peers = Array.isArray(nativeDiagnostics?.peers) ? nativeDiagnostics.peers : [];
  elements.edgeDiagnostic.textContent = peers.length === 0
    ? "无活动媒体边"
    : peers.map((peer) => {
      const sent = peer.bitrateBps === undefined ? "码率未知" : formatBitrate(peer.bitrateBps);
      const rtt = peer.currentRoundTripTimeMs === undefined ? "RTT 未知" : `RTT ${peer.currentRoundTripTimeMs} ms`;
      return `边 ${peer.slot}: ${peer.connectionState || "未知"} / ${peer.route || "未知路径"} / ${sent} / ${rtt} / PLI ${peer.pliRequests ?? 0} / FIR ${peer.firRequests ?? 0}`;
    }).join("；");
}

function scheduleDiagnostics() {
  if (diagnosticsTimer !== null) return;
  diagnosticsTimer = setTimeout(() => {
    diagnosticsTimer = null;
    updateDiagnostics();
  }, 500);
}

function formatBitrate(value) {
  const bitrate = Number(value);
  return Number.isFinite(bitrate) ? `${(bitrate / 1_000_000).toFixed(2)} Mbps` : "码率未知";
}

function formatBytes(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : "未知";
}

function parseLocalMessage(value) {
  try {
    const message = JSON.parse(value);
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function selectedCodec() {
  return elements.codec?.value === "h264" ? "h264" : "vp8";
}

function emptyMetrics() {
  return {
    framesRead: 0,
    framesSubmitted: 0,
    encoderOutputs: 0,
    encodedBytes: 0,
    encoderQueueDrops: 0,
    encoderQueuePeak: 0,
    socketBufferedPeak: 0,
    hardwarePreference: HARDWARE_STATUS.UNREQUESTED,
    hardwareEvidence: HARDWARE_STATUS.UNVERIFIED,
  };
}

function hardwarePreferenceLabel(value) {
  return {
    [HARDWARE_STATUS.UNREQUESTED]: "未请求",
    [HARDWARE_STATUS.PREFERENCE_ACCEPTED]: "偏好已接受",
    [HARDWARE_STATUS.FALLBACK]: "已回退",
    [HARDWARE_STATUS.UNSUPPORTED]: "不支持",
  }[value] || "未知";
}

function hardwareEvidenceLabel(value) {
  return value === HARDWARE_STATUS.UNVERIFIED ? "未验证" : "未知";
}

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function assertCurrentStart(generation, socket = mediaSocket, staleStream = null) {
  if (!isCurrentStart(generation, socket)) {
    staleStream?.getTracks().forEach((track) => track.stop());
    throw new StaleStartError();
  }
}

function isCurrentStart(generation, socket = mediaSocket) {
  return generation === startGeneration && !stopping && (!socket || socket === mediaSocket);
}

class StaleStartError extends Error {}

function setStatus(value) { elements.status.textContent = value; }
function showError(value) { elements.error.textContent = value; }
