import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  reservePort,
  waitForSample,
  waitForVersion,
  withDeadline,
} from "./browser-gate-harness";
import {
  decodeClientEndpoint,
  type ClientEndpoint as Endpoint,
} from "./client-gate-endpoint";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ROOT = join(ROOT, "build", "client-check");
const SOURCE_TITLE = "Screener Native Gate Source";
const GATE_STUN_URL =
  process.env.SCREENER_CLIENT_GATE_STUN_URL?.trim() ||
  "stun:share.bonfire.icu:3478";

interface Probe {
  protocol: number;
  processAudio: boolean;
  systemAudio: boolean;
  adapters: Array<{
    index: number;
    hardwareH264: Array<{ index: number }>;
  }>;
}

interface WindowTarget {
  kind: "window" | "display";
  sourceId: string;
  pid?: number;
  creationTime?: string;
  title: string;
}

interface CaptureEvidence {
  starting: boolean;
  active: boolean;
  frames: number;
  keyFrameRequested: boolean;
  recoveryFrame: boolean;
  audioReady: boolean;
  audioFrames: number;
  audioNonZeroSamples: number;
}

interface MediaEvidence {
  captureActive: boolean;
  connected: boolean;
  connectedEdges: number;
  frames: number;
  edgeFrames: number[];
  audioPackets: number;
  edgeAudioPackets: number[];
  audioEnergy: number;
  edgeAudioEnergy: number[];
  audioSamples: number;
  edgeAudioSamples: number[];
  audioBytes: number;
  edgeAudioBytes: number[];
  audioAvailable: boolean;
  width: number;
  height: number;
  localType: string | null;
  remoteType: string | null;
  nativeCandidateTypes: string[];
  liveProfileUpdated: boolean;
  pausedProfileUpdated: boolean;
  error: string | null;
}

function run(command: string, args: string[], cwd = ROOT): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || command + " failed");
  }
  return result.stdout.trim();
}

function powershell(): string {
  const configured = process.env.SCREENER_POWERSHELL?.trim();
  if (configured) return configured;
  return join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function sourceHTML(): string {
  return [
    "<!doctype html><title>" + SOURCE_TITLE + "</title>",
    "<style>html,body,canvas{margin:0;width:100%;height:100%;overflow:hidden;background:#101b29}</style>",
    "<canvas width=\"1280\" height=\"720\"></canvas>",
    "<script>",
    "const canvas=document.querySelector('canvas');",
    "const context=canvas.getContext('2d');",
    "let frame=0;",
    "function draw(){",
    "const hue=(frame*3)%360;",
    "context.fillStyle='hsl('+hue+' 70% 45%)';",
    "context.fillRect(0,0,canvas.width,canvas.height);",
    "context.fillStyle='#fff';",
    "context.fillRect((frame*17)%1080,180,200,360);",
    "context.font='64px sans-serif';",
    "context.fillText(String(frame),48,96);",
    "frame+=1;requestAnimationFrame(draw);",
    "}draw();",
    "</script>",
  ].join("");
}

function startPageServer(port: number) {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(sourceHTML());
  });
  return new Promise<{ close(): Promise<void> }>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(port, "127.0.0.1", () => {
      resolveServer({
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }),
      });
    });
  });
}

function observeCapture(
  child: ChildProcessWithoutNullStreams,
  evidence: CaptureEvidence,
): void {
  let buffered = Buffer.alloc(0);
  let framesAtRequest = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 28) {
      if (buffered.subarray(0, 4).toString("ascii") !== "SMED" || buffered[4] !== 1) {
        child.kill();
        return;
      }
      const kind = buffered[5]!;
      const flags = buffered[6]!;
      const size = buffered.readUInt32BE(24);
      const maximum = kind === 3 ? 4 * 1024 : 1024 * 1024;
      if (size === 0 || size > maximum) {
        child.kill();
        return;
      }
      if (buffered.length < 28 + size) return;
      const payload = buffered.subarray(28, 28 + size);
      buffered = buffered.subarray(28 + size);
      if (kind === 3) {
        const state = JSON.parse(payload.toString("utf8")) as { state?: string };
        evidence.starting ||= state.state === "starting";
        evidence.active ||= state.state === "active";
      } else if (kind === 2) {
        evidence.frames += 1;
        if (!evidence.keyFrameRequested && evidence.frames >= 5) {
          evidence.keyFrameRequested = true;
          framesAtRequest = evidence.frames;
          child.stdin.write("K");
        } else if (evidence.keyFrameRequested && evidence.frames > framesAtRequest && flags === 1) {
          evidence.recoveryFrame = true;
        }
      }
    }
  });
}

function observeAudioCapture(
  child: ChildProcessWithoutNullStreams,
  evidence: CaptureEvidence,
): void {
  let buffered = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 28) {
      if (buffered.subarray(0, 4).toString("ascii") !== "SMED" || buffered[4] !== 1) {
        child.kill();
        return;
      }
      const kind = buffered[5]!;
      const size = buffered.readUInt32BE(24);
      const maximum = kind === 3 ? 4 * 1024 : 1024 * 1024;
      if (size === 0 || size > maximum || buffered.length < 28 + size) {
        if (size === 0 || size > maximum) child.kill();
        return;
      }
      const payload = buffered.subarray(28, 28 + size);
      buffered = buffered.subarray(28 + size);
      if (kind === 3) {
        const state = JSON.parse(payload.toString("utf8")) as {
          state?: string;
          audio?: boolean;
        };
        evidence.audioReady ||= state.state === "active" && state.audio === true;
      } else if (kind === 1) {
        evidence.audioFrames += 1;
        for (let offset = 0; offset + 1 < payload.length; offset += 2) {
          if (payload.readInt16LE(offset) !== 0) {
            evidence.audioNonZeroSamples += 1;
          }
        }
      }
    }
  });
}

async function stopCapture(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error("Native capture exited unsuccessfully");
    return;
  }
  child.stdin.write("\n");
  const code = await withDeadline(
    () => new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
    Date.now() + 3_000,
  );
  if (code !== 0) throw new Error("Native capture did not stop cleanly");
}

async function readEndpoint(child: ChildProcessWithoutNullStreams): Promise<Endpoint> {
  let buffered = "";
  return withDeadline(
    () => new Promise<Endpoint>((resolveEndpoint, rejectEndpoint) => {
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString();
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        child.stdout.off("data", onData);
        try {
          resolveEndpoint(decodeClientEndpoint(buffered.slice(0, newline)));
        } catch (error) {
          rejectEndpoint(error);
        }
      };
      child.stdout.on("data", onData);
      child.once("error", rejectEndpoint);
      child.once("exit", (code) => {
        rejectEndpoint(new Error("Client exited before readiness (" + String(code) + ")"));
      });
    }),
    Date.now() + 10_000,
  );
}

async function browserMediaGate(input: {
  endpoint: Endpoint;
  sourceTitle: string;
  sourceKind: "window" | "display";
  stunUrl: string;
}): Promise<MediaEvidence> {
  let socket: WebSocket | null = null;
  const peers: RTCPeerConnection[] = [];
  const result: MediaEvidence = {
    captureActive: false,
    connected: false,
    connectedEdges: 0,
    frames: 0,
    edgeFrames: [],
    audioPackets: 0,
    edgeAudioPackets: [],
    audioEnergy: 0,
    edgeAudioEnergy: [],
    audioSamples: 0,
    edgeAudioSamples: [],
    audioBytes: 0,
    edgeAudioBytes: [],
    audioAvailable: false,
    width: 0,
    height: 0,
    localType: null,
    remoteType: null,
    nativeCandidateTypes: [],
    liveProfileUpdated: false,
    pausedProfileUpdated: false,
    error: null,
  };
  try {
    const healthResponse = await fetch(input.endpoint.url + "/health", {
      cache: "no-store",
      targetAddressSpace: "loopback",
    } as RequestInit);
    const health = await healthResponse.json();
    if (
      health.protocol !== 7 ||
      health.service !== "screener-client" ||
      health.instanceToken !== input.endpoint.instanceToken ||
      health.nativeMedia?.video !== true ||
      health.nativeMedia?.hardwareH264 !== true
    ) {
      throw new Error("Native Client health is not ready");
    }
    result.audioAvailable = input.sourceKind === "window"
      ? health.nativeMedia.processAudio === true
      : health.nativeMedia.systemAudio === true;

    socket = new WebSocket(
      "ws://127.0.0.1:" + input.endpoint.port + "/control",
      ["screener-client-v8." + input.endpoint.instanceToken],
    );
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = window.setTimeout(
        () => rejectOpen(new Error("Native control open timed out")),
        5_000,
      );
      socket!.onopen = () => {
        window.clearTimeout(timer);
        resolveOpen();
      };
      socket!.onerror = () => {
        window.clearTimeout(timer);
        rejectOpen(new Error("Native control failed to open"));
      };
    });

    let requestSequence = 0;
    let eventError: Error | null = null;
    const edges = new Map<string, {
      peer: RTCPeerConnection;
      video: HTMLVideoElement;
      stream: MediaStream;
      connected: boolean;
      remoteDescriptionSet: boolean;
      queuedCandidates: Array<RTCIceCandidateInit | null>;
    }>();
    const pending = new Map<string, {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: number;
    }>();
    const request = (type: string, fields: Record<string, unknown> = {}) => {
      requestSequence += 1;
      const id = "request_" + String(requestSequence).padStart(8, "0");
      return new Promise<any>((resolveRequest, rejectRequest) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error("Native request timed out: " + type));
        }, 8_000);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        socket!.send(JSON.stringify({ version: 8, id, type, ...fields }));
      });
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "string") {
        const active = pending.get(message.id);
        if (active) {
          pending.delete(message.id);
          window.clearTimeout(active.timer);
          active.resolve(message);
        }
        return;
      }
      if (message.type === "capture-state" && message.state === "active") {
        result.captureActive = true;
      } else if (message.type === "edge-state") {
        const edge = edges.get(message.connectionId);
        if (edge) edge.connected = message.state === "connected";
      } else if (message.type === "edge-path") {
        result.localType = message.localType;
        result.remoteType = message.remoteType;
      } else if (message.type === "edge-candidate") {
        const candidate = message.candidate as RTCIceCandidateInit | null;
        const fields = typeof candidate?.candidate === "string"
          ? candidate.candidate.split(/\s+/)
          : [];
        const typeIndex = fields.indexOf("typ");
        if (typeIndex >= 0 && fields[typeIndex + 1] &&
            !result.nativeCandidateTypes.includes(fields[typeIndex + 1]!)) {
          result.nativeCandidateTypes.push(fields[typeIndex + 1]!);
        }
        const edge = edges.get(message.connectionId);
        if (edge?.remoteDescriptionSet) {
          void edge.peer.addIceCandidate(candidate).catch((error) => {
            eventError = error instanceof Error ? error : new Error(String(error));
          });
        } else if (edge) {
          edge.queuedCandidates.push(candidate);
        }
      } else if (message.type === "share-ended" && message.failed) {
        eventError = new Error("Native share ended unexpectedly");
      }
    };
    socket.onclose = () => {
      for (const active of pending.values()) {
        window.clearTimeout(active.timer);
        active.reject(new Error("Native control closed"));
      }
      pending.clear();
    };

    const ready = await request("hello");
    if (ready.type !== "ready") throw new Error("Native hello was rejected");
    const options = await request("capture-options");
    const adapter = options.adapters?.find(
      (candidate: { hardwareH264?: unknown[] }) => candidate.hardwareH264?.length,
    );
    const encoder = adapter?.hardwareH264?.[0];
    const sources = await request("list-sources");
    const target = sources.sources?.find(
      (candidate: { kind?: string; title?: string }) =>
        candidate.kind === input.sourceKind &&
        (input.sourceKind === "display" ||
          candidate.title?.includes(input.sourceTitle)),
    );
    if (!adapter || !encoder || !target) {
      throw new Error("Native capture selection is unavailable");
    }

    const shareId = "share_gate_0001";
    const connectionId = "edge_gate_0001";
    const started = await request("start-share", {
      shareId,
      codec: "h264",
      source: target,
      audio: result.audioAvailable,
      adapterIndex: adapter.index,
      encoderIndex: encoder.index,
      edgeCapacity: 2,
      profile: {
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "balanced",
        screenAudioQuality: "music",
      },
    });
    if (started.shareId !== shareId || started.audio !== result.audioAvailable) {
      throw new Error("Native share audio capability was not reported consistently");
    }

    const connectEdge = async (nextConnectionId: string) => {
      const peer = new RTCPeerConnection();
      peers.push(peer);
      if (result.audioAvailable) {
        peer.addTransceiver("audio", { direction: "recvonly" });
      }
      const video = document.createElement("video");
      video.autoplay = true;
      video.volume = 0.001;
      video.playsInline = true;
      document.body.append(video);
      const stream = new MediaStream();
      video.srcObject = stream;
      const edge = {
        peer,
        video,
        stream,
        connected: false,
        remoteDescriptionSet: false,
        queuedCandidates: [] as Array<RTCIceCandidateInit | null>,
      };
      edges.set(nextConnectionId, edge);
      peer.ontrack = (event) => {
        if (!stream.getTrackById(event.track.id)) {
          stream.addTrack(event.track);
        }
        void video.play();
      };
      peer.onicecandidate = (event) => {
        void request("edge-candidate", {
          shareId,
          connectionId: nextConnectionId,
          candidate: event.candidate?.toJSON() ?? null,
        }).catch((error) => {
          eventError = error instanceof Error ? error : new Error(String(error));
        });
      };
      const offer = await request("prepare-edge", {
        shareId,
        connectionId: nextConnectionId,
        iceServers: [{ urls: [input.stunUrl] }],
      });
      await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      edge.remoteDescriptionSet = true;
      for (const candidate of edge.queuedCandidates.splice(0)) {
        await peer.addIceCandidate(candidate);
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await request("edge-answer", {
        shareId,
        connectionId: nextConnectionId,
        sdp: answer.sdp,
      });
    };
    await Promise.all([
      connectEdge(connectionId),
      connectEdge("edge_gate_0002"),
    ]);

    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      if (eventError) throw eventError;
      result.connectedEdges = [...edges.values()].filter((edge) => edge.connected).length;
      result.connected = result.connectedEdges === 2;
      result.edgeFrames = [...edges.values()].map(
        (edge) => edge.video.getVideoPlaybackQuality().totalVideoFrames,
      );
      result.frames = Math.min(...result.edgeFrames);
      result.edgeAudioPackets = [];
      result.edgeAudioEnergy = [];
      result.edgeAudioSamples = [];
      result.edgeAudioBytes = [];
      for (const edge of edges.values()) {
        let packets = 0;
        let energy = 0;
        let samples = 0;
        let bytes = 0;
        for (const [, report] of await edge.peer.getStats()) {
          if (report.type === "inbound-rtp" &&
              (report.kind === "audio" || report.mediaType === "audio")) {
            packets = Math.max(packets, Number(report.packetsReceived) || 0);
            energy = Math.max(energy, Number(report.totalAudioEnergy) || 0);
            samples = Math.max(samples, Number(report.totalSamplesReceived) || 0);
            bytes = Math.max(bytes, Number(report.bytesReceived) || 0);
          }
        }
        result.edgeAudioPackets.push(packets);
        result.edgeAudioEnergy.push(energy);
        result.edgeAudioSamples.push(samples);
        result.edgeAudioBytes.push(bytes);
      }
      result.audioPackets = result.edgeAudioPackets.length > 0
        ? Math.min(...result.edgeAudioPackets)
        : 0;
      result.audioEnergy = result.edgeAudioEnergy.length > 0
        ? Math.min(...result.edgeAudioEnergy)
        : 0;
      result.audioSamples = result.edgeAudioSamples.length > 0
        ? Math.min(...result.edgeAudioSamples)
        : 0;
      result.audioBytes = result.edgeAudioBytes.length > 0
        ? Math.min(...result.edgeAudioBytes)
        : 0;
      const videos = [...edges.values()].map((edge) => edge.video);
      result.width = videos.every((video) => video.videoWidth === 1280) ? 1280 : 0;
      result.height = videos.every((video) => video.videoHeight === 720) ? 720 : 0;
      if (
        result.captureActive &&
        result.connected &&
        result.frames >= 30 &&
        (!result.audioAvailable ||
          (result.audioPackets > 10 && result.audioEnergy > 0)) &&
        result.width === 1280 &&
        result.height === 720 &&
        result.nativeCandidateTypes.includes("srflx")
      ) {
        break;
      }
      await new Promise((resolveWait) => window.setTimeout(resolveWait, 100));
    }
    if (
      !result.captureActive ||
      !result.connected ||
      result.frames < 30 ||
      (result.audioAvailable &&
        (result.audioPackets <= 10 || result.audioEnergy <= 0)) ||
      result.width !== 1280 ||
      result.height !== 720 ||
      !result.nativeCandidateTypes.includes("srflx")
    ) {
      throw new Error("Native H264 did not reach decoded Browser video");
    }

    const videos = [...edges.values()].map((edge) => edge.video);
    const framesBeforeLiveUpdate = Math.min(
      ...videos.map((video) => video.getVideoPlaybackQuality().totalVideoFrames),
    );
    const liveUpdate = await request("update-share", {
      shareId,
      profile: {
        resolution: "1440p",
        maxFramerate: 60,
        maxBitrate: 12_000_000,
        degradationPreference: "maintain-framerate",
        screenAudioQuality: "very-high",
      },
    });
    const liveDeadline = performance.now() + 15_000;
    while (performance.now() < liveDeadline) {
      const frames = Math.min(
        ...videos.map((video) => video.getVideoPlaybackQuality().totalVideoFrames),
      );
      result.liveProfileUpdated = liveUpdate.type === "share-updated" &&
        videos.every((video) => video.videoWidth === 2560 && video.videoHeight === 1440) &&
        frames >= framesBeforeLiveUpdate + 10;
      if (result.liveProfileUpdated) break;
      await new Promise((resolveWait) => window.setTimeout(resolveWait, 100));
    }
    if (!result.liveProfileUpdated) {
      throw new Error("Native live profile update did not reach both Viewers");
    }

    await request("pause-share", { shareId, paused: true });
    const pausedUpdate = await request("update-share", {
      shareId,
      profile: {
        resolution: "480p",
        maxFramerate: 15,
        maxBitrate: 2_000_000,
        degradationPreference: "maintain-resolution",
        screenAudioQuality: "saver",
      },
    });
    const framesBeforeResume = Math.min(
      ...videos.map((video) => video.getVideoPlaybackQuality().totalVideoFrames),
    );
    await request("pause-share", { shareId, paused: false });
    const resumeDeadline = performance.now() + 15_000;
    while (performance.now() < resumeDeadline) {
      const frames = Math.min(
        ...videos.map((video) => video.getVideoPlaybackQuality().totalVideoFrames),
      );
      result.pausedProfileUpdated = pausedUpdate.type === "share-updated" &&
        videos.every((video) => video.videoWidth === 854 && video.videoHeight === 480) &&
        frames >= framesBeforeResume + 10;
      if (result.pausedProfileUpdated) {
        result.frames = frames;
        result.width = 854;
        result.height = 480;
        break;
      }
      await new Promise((resolveWait) => window.setTimeout(resolveWait, 100));
    }
    if (!result.pausedProfileUpdated) {
      throw new Error("Native paused profile update did not resume both Viewers");
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const peer of peers) peer.close();
    socket?.close(1000, "gate complete");
  }
  return result;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The native capture gate currently requires Windows");
  }
  if (process.env.SCREENER_CLIENT_MEDIA_GATE !== "true") {
    throw new Error("SCREENER_CLIENT_MEDIA_GATE=true is required");
  }
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");

  const profile = await mkdtemp(join(tmpdir(), "screener-client-media-"));
  // Keep network-capable binaries at a stable repository path. Windows
  // associates its firewall decision with the full executable path; the
  // disposable Browser profile remains in the system temp directory.
  const buildRoot = BUILD_ROOT;
  await mkdir(buildRoot, { recursive: true });
  const pagePort = await reservePort();
  const debugPort = await reservePort();
  let server: Awaited<ReturnType<typeof startPageServer>> | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let capture: ChildProcessWithoutNullStreams | null = null;
  let audioCapture: ChildProcessWithoutNullStreams | null = null;
  let client: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let clientPort = 0;
  let browser: string | null = null;
  const evidence: CaptureEvidence = {
    starting: false,
    active: false,
    frames: 0,
    keyFrameRequested: false,
    recoveryFrame: false,
    audioReady: false,
    audioFrames: 0,
    audioNonZeroSamples: 0,
  };
  let media: MediaEvidence = {
    captureActive: false,
    connected: false,
    connectedEdges: 0,
    frames: 0,
    edgeFrames: [],
    width: 0,
    height: 0,
    localType: null,
    remoteType: null,
    nativeCandidateTypes: [],
    liveProfileUpdated: false,
    pausedProfileUpdated: false,
    error: "not run",
    audioPackets: 0,
    edgeAudioPackets: [],
    audioEnergy: 0,
    edgeAudioEnergy: [],
    audioSamples: 0,
    edgeAudioSamples: [],
    audioBytes: 0,
    edgeAudioBytes: [],
    audioAvailable: false,
  };
  let error: string | null = null;
  let cleanup = {
    browserExited: false,
    nativeExited: false,
    serverClosed: false,
    portsClosed: false,
    profileRemoved: false,
  };
  try {
    run(powershell(), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(ROOT, "native", "client", "platform", "windows", "capture", "build.ps1"),
      "-OutputDirectory",
      buildRoot,
    ]);
    const executable = join(buildRoot, "screener-client-capture.exe");
    const probe = JSON.parse(run(executable, ["--probe"])) as Probe;
    const adapter = probe.adapters.find((candidate) => candidate.hardwareH264.length > 0);
    const encoder = adapter?.hardwareH264[0];
    if (probe.protocol !== 4 || !adapter || !encoder) {
      throw new Error("No hardware H264 capture path is available");
    }

    server = await startPageServer(pagePort);
    chrome = spawn(chromePath, [
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-logging",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      "about:blank",
    ], { stdio: "pipe", windowsHide: true });
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    browser = version.Browser;
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 10_000);
    const sourcePage = await createPage(
      cdp,
      "http://127.0.0.1:" + pagePort + "/source",
      undefined,
      true,
    );
    const audioState = await evaluate<string>(
      cdp,
      sourcePage,
      `(() => {
        const context = new AudioContext();
        const gain = context.createGain();
        gain.gain.value = 0.05;
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 440;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        globalThis.__screenerAudioGate = { context, oscillator };
        return context.resume().then(() => context.state);
      })()`,
      Date.now() + 5_000,
    );
    if (audioState !== "running") {
      throw new Error("Browser could not start the selected-window audio source");
    }
    const targets = JSON.parse(run(executable, ["--list"])) as WindowTarget[];
    const sourceKind: "window" | "display" =
      process.env.SCREENER_CLIENT_MEDIA_SOURCE === "display"
        ? "display"
        : "window";
    const target = targets.find(
      (candidate) => candidate.kind === sourceKind &&
        (sourceKind === "display" || candidate.title.includes(SOURCE_TITLE)),
    );
    if (!target) throw new Error("The animated capture target was not enumerated");

    capture = spawn(executable, [
      "--capture-video",
      target.kind,
      target.sourceId,
      String(target.pid ?? 0),
      target.creationTime ?? "0",
      "--adapter-index",
      String(adapter.index),
      "--mft-index",
      String(encoder.index),
      "--width",
      "1280",
      "--height",
      "720",
      "--fps",
      "30",
      "--bitrate",
      "3000000",
      "--preference",
      "balanced",
      "--codec",
      "h264",
      "--protocol-v4",
    ], { stdio: "pipe", windowsHide: true });
    capture.stderr.resume();
    observeCapture(capture, evidence);
    await waitForSample(
      async () => ({ ...evidence }),
      (sample) =>
        sample.starting && sample.active && sample.frames >= 30 &&
        sample.keyFrameRequested && sample.recoveryFrame,
      15_000,
    );
    await stopCapture(capture);
    capture = null;

    const audioAvailable = sourceKind === "window"
      ? probe.processAudio
      : probe.systemAudio;
    if (audioAvailable) {
      audioCapture = spawn(executable, [
        "--capture-audio",
        target.kind,
        String(target.pid ?? 0),
        target.creationTime ?? "0",
      ], { stdio: "pipe", windowsHide: true });
      audioCapture.stderr.resume();
      observeAudioCapture(audioCapture, evidence);
      await waitForSample(
        async () => ({ ...evidence }),
        (sample) =>
          sample.audioReady && sample.audioFrames >= 10 &&
          sample.audioNonZeroSamples > 0,
        10_000,
      );
      await stopCapture(audioCapture);
      audioCapture = null;
    }

    const packageRoot = join(buildRoot, "media-package");
    const nativeRoot = join(packageRoot, "runtime", "native");
    await mkdir(nativeRoot, { recursive: true });
    await copyFile(
      executable,
      join(nativeRoot, "screener-client-capture.exe"),
    );
    const clientExecutable = join(packageRoot, "screener-client.exe");
    const go = process.env.SCREENER_GO?.trim() || "go";
    run(
      go,
      ["build", "-trimpath", "-o", clientExecutable, "./cmd/screener-client"],
      join(ROOT, "native", "client"),
    );
    client = spawn(clientExecutable, [
      "--site",
      "http://127.0.0.1:" + pagePort,
      "--config",
      join(profile, "client.json"),
    ], {
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, SCREENER_CLIENT_GATE_NO_BROWSER: "true" },
    });
    client.stderr.resume();
    const endpoint = await readEndpoint(client);
    clientPort = endpoint.port;
    const controlPage = await createPage(
      cdp,
      "http://127.0.0.1:" + pagePort + "/control",
      undefined,
      true,
    );
    media = await evaluate<MediaEvidence>(
      cdp,
      controlPage,
      "((__name) => (" + browserMediaGate.toString() + ")(" + JSON.stringify({
        endpoint,
        sourceTitle: SOURCE_TITLE,
        sourceKind,
        stunUrl: GATE_STUN_URL,
      }) + "))((target) => target)",
      Date.now() + 70_000,
    );
    if (media.error) throw new Error(media.error);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    cleanup = await cleanupRun({
      cdp,
      native: client ?? capture ?? audioCapture,
      chrome,
      server,
      profile,
      ports: [pagePort, debugPort, ...(clientPort ? [clientPort] : [])],
    });
  }
  const passed = error === null && evidence.starting && evidence.active &&
    evidence.frames >= 30 && evidence.recoveryFrame && media.error === null &&
    (evidence.audioFrames === 0 || evidence.audioNonZeroSamples > 0) &&
    media.captureActive && media.connected && media.frames >= 30 &&
    media.connectedEdges === 2 && media.edgeFrames.length === 2 &&
    (!media.audioAvailable ||
      (media.audioPackets > 10 && media.audioEnergy > 0)) &&
    media.liveProfileUpdated && media.pausedProfileUpdated &&
    media.width === 854 && media.height === 480 &&
    media.nativeCandidateTypes.includes("srflx") &&
    cleanup.browserExited && cleanup.nativeExited && cleanup.serverClosed &&
    cleanup.portsClosed && cleanup.profileRemoved;
  process.stdout.write(JSON.stringify({ passed, browser, capture: evidence, media, cleanup, error }) + "\n");
  if (!passed) process.exitCode = 1;
}

await main();
