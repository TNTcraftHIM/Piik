import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createScreenerServer, type ScreenerServer } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import {
  ROOM_CAPACITY,
  RoomStore,
  type ConnectedParticipant,
  type ConnectParticipantInput,
  type RoomStoreOptions,
} from "../src/server/room-store";
import {
  SenderStartLedger,
  waitForSenderStart,
  type SenderStartObservation,
} from "./native-one-viewer-ledger";
import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  reservePort,
  waitForSample,
  waitForVersion,
  type PageHandle,
} from "./browser-gate-harness";
import {
  captureOneViewerIdentity,
  finalizeGate,
  hasNoCriticalSenderErrors,
  hasOneViewerPionProof,
  retainsFirstBridgeSend,
  retainsOneViewerIdentity,
  verifyFinalSenderEvidence,
  type OneViewerIdentity,
  type SenderIdentityEvidence,
  type ViewerIdentityEvidence,
} from "./native-one-viewer-gate-core";

type Stage = "preflight" | "sender-start" | "node-host" | "viewer-signal" | "viewer-media" | "cleanup";

interface GateReport {
  schemaVersion: 1;
  status: "passed" | "failed";
  failedStage: Stage | null;
  stages: Record<string, Record<string, boolean | number | string | null> | undefined>;
  limitations: string[];
}

interface SenderSnapshot {
  getDisplayMediaRequested: boolean;
  getDisplayMediaResolved: boolean;
  nativeHardwareStarting: boolean;
  nativeHardwareActive: boolean;
  nativeAdapterLuid: string | null;
  ready: number;
  configAccepted: number;
  encoderInstances: number;
  encoderOutputs: number;
  encoderErrors: number;
  fatalEvents: number;
  bridgeGeneration: number;
  binarySendAttempts: number;
  binarySendSucceeded: number;
  binarySendFailed: number;
  diagnosticsObserved: boolean;
  postSendDiagnosticsObserved: boolean;
  postSendDiagnosticsSequence: number;
  activeViewers: number;
  maxPeers: number;
  config: {
    codec: string | null;
    videoSource: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrate: number | null;
    encoderInstances: number | null;
  } | null;
  media: {
    framesWritten: number;
    sourceRtpPacketsWritten: number;
    sourceRtpBytesWritten: number;
  } | null;
  peers: Array<{
    slot: number;
    edgeGeneration: number;
    connectionState: string;
    iceConnectionState: string;
    route: string;
    packetsSent: number;
    bytesSent: number;
  }>;
}

type GateMode = "vp8" | "h264" | "native-h264";

export function parseGateMode(value: string | undefined): GateMode {
  const normalized = value?.trim();
  return normalized === "h264" || normalized === "native-h264" ? normalized : "vp8";
}

interface ViewerSnapshot {
  signaling: {
    authenticateSent: number;
    authenticatedReceived: number;
    offersReceived: number;
    answersSent: number;
    candidatesReceived: number;
    candidatesSent: number;
  };
  identity: ViewerIdentityEvidence;
  connectionState: string;
  iceConnectionState: string;
  packetsReceived: number;
  bytesReceived: number;
  framesDecoded: number;
  videoReadyState: number;
  videoWidth: number;
  videoHeight: number;
  videoCurrentTime: number;
  renderedFrames: number;
  audioTrackCount: number;
  audioPacketsReceived: number;
  audioBytesReceived: number;
}

const root = resolve(import.meta.dirname, "..");

class ObservedRoomStore extends RoomStore {
  constructor(options: RoomStoreOptions, private readonly onHostAuthenticated: () => void) {
    super(options);
  }

  override connectParticipant(input: ConnectParticipantInput): ConnectedParticipant {
    const participant = super.connectParticipant(input);
    if (input.role === "host") this.onHostAuthenticated();
    return participant;
  }
}

function observeNodeStages(server: ScreenerServer, ledger: SenderStartLedger): void {
  server.httpServer.prependListener("request", (request, response) => {
    const path = new URL(request.url ?? "/", "http://gate.invalid").pathname;
    if (request.method === "POST" && path === "/api/site-access") {
      response.once("finish", () => {
        if (response.statusCode === 200) ledger.record({ siteAccessAccepted: true });
      });
    } else if (request.method === "POST" && path === "/api/rooms") {
      response.once("finish", () => {
        if (response.statusCode === 201) ledger.record({ roomCreated: true });
      });
    }
  });
}

function senderStartObservation(
  snapshot: SenderSnapshot,
  expectedCodec = "vp8",
  expectedVideoSource = "browser",
): Partial<SenderStartObservation> {
  const nativeWindow = expectedVideoSource === "native-window-h264";
  return {
    getDisplayMediaRequested: snapshot.getDisplayMediaRequested,
    getDisplayMediaResolved: snapshot.getDisplayMediaResolved,
    bridgeConnected: snapshot.ready > 0,
    fixedHighConfigured: snapshot.configAccepted > 0 &&
      snapshot.config?.codec === expectedCodec && snapshot.config.videoSource === expectedVideoSource &&
      snapshot.config.width === 1280 &&
      snapshot.config.height === 720 && snapshot.config.fps === 30 &&
      snapshot.config.bitrate === 3_000_000 && snapshot.config.encoderInstances === 1,
    firstEncodedChunk: nativeWindow
      ? snapshot.nativeHardwareActive && (snapshot.media?.framesWritten ?? 0) > 0
      : snapshot.encoderOutputs > 0,
    bridgeGeneration: snapshot.bridgeGeneration,
    binarySendAttempts: snapshot.binarySendAttempts,
    binarySendSucceeded: snapshot.binarySendSucceeded,
    binarySendFailed: snapshot.binarySendFailed,
    encoderInstances: snapshot.encoderInstances,
    diagnosticsObserved: snapshot.diagnosticsObserved,
    postSendDiagnosticsObserved: snapshot.postSendDiagnosticsObserved,
    postSendDiagnosticsSequence: snapshot.postSendDiagnosticsSequence,
    encoderErrors: snapshot.encoderErrors,
    fatalEvents: snapshot.fatalEvents,
    ...(snapshot.media === null ? {} : {
      framesWritten: snapshot.media.framesWritten,
      sourceRtpPacketsWritten: snapshot.media.sourceRtpPacketsWritten,
      sourceRtpBytesWritten: snapshot.media.sourceRtpBytesWritten,
    }),
  };
}

function retainsExpectedBridge(snapshot: SenderSnapshot, nativeWindow: boolean): boolean {
  return nativeWindow
    ? snapshot.bridgeGeneration === 1 && snapshot.binarySendFailed === 0
    : retainsFirstBridgeSend(snapshot);
}

function nativeSenderStartComplete(
  snapshot: SenderSnapshot,
  ledger: SenderStartObservation,
): boolean {
  return !snapshot.getDisplayMediaRequested && !snapshot.getDisplayMediaResolved &&
    snapshot.nativeHardwareStarting && snapshot.nativeHardwareActive &&
    typeof snapshot.nativeAdapterLuid === "string" && snapshot.nativeAdapterLuid.length > 0 &&
    snapshot.encoderInstances === 0 && snapshot.encoderErrors === 0 && snapshot.fatalEvents === 0 &&
    snapshot.config?.videoSource === "native-window-h264" &&
    ledger.siteAccessAccepted && ledger.roomCreated && ledger.hostWssAuthenticated &&
    ledger.bridgeConnected && ledger.fixedHighConfigured && ledger.firstEncodedChunk &&
    ledger.bridgeGeneration === 1 && ledger.binarySendFailed === 0 &&
    ledger.diagnosticsObserved && ledger.framesWritten > 0 &&
    ledger.sourceRtpPacketsWritten > 0 && ledger.sourceRtpBytesWritten > 0;
}

function requiredEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appendLedgerRecord(path: string, record: object): void {
  const descriptor = openSync(path, "a");
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const chromePath = requiredEnvironmentPath("SCREENER_NATIVE_GATE_CHROME");
  const goPath = process.env.SCREENER_NATIVE_GATE_GO?.trim() || "go";
  const gateMode = parseGateMode(process.env.SCREENER_NATIVE_GATE_CODEC);
  const nativeWindow = gateMode === "native-h264";
  const gateCodec = gateMode === "vp8" ? "vp8" : "h264";
  const gateVideoSource = nativeWindow ? "native-window-h264" : "browser";
  const nativeHelperPath = nativeWindow
    ? requiredEnvironmentPath("SCREENER_WINDOW_CAPTURE_HELPER")
    : null;
  const windowTargetTitle = process.env.SCREENER_NATIVE_GATE_WINDOW_TARGET_TITLE?.trim() ||
    (nativeWindow ? "Native Gate Source" : "");
  const accessKey = randomBytes(9).toString("base64url");
  const report: GateReport = {
    schemaVersion: 1,
    status: "failed",
    failedStage: "preflight",
    stages: {},
    limitations: [
      "This is an optional Native research probe and is not part of Web acceptance.",
      nativeWindow
        ? "The source is a real animated top-level Chrome window captured through WGC, not a game workload."
        : "The source is a real animated Chrome tab captured through getDisplayMedia, not a game workload.",
      nativeWindow
        ? "Hardware status is the helper's hardware-only MF contract; physical VideoEncode use requires correlated OS telemetry."
        : "This run proves one WebCodecs object, not one physical or hardware encoder.",
      windowTargetTitle
        ? "The loopback run does not prove public STUN, SFU, restrictive networks, packaging, or endurance."
        : "The loopback run does not prove public STUN, SFU, restrictive networks, audio, packaging, or endurance.",
    ],
  };
  let server: ScreenerServer | null = null;
  let native: ChildProcessWithoutNullStreams | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpConnection | null = null;
  let profile: string | null = null;
  let ledgerPath: string | null = null;
  let appPort: number | null = null;
  let debugPort: number | null = null;
  let nativePort: number | null = null;
  let senderPage: PageHandle | null = null;
  let gateSucceeded = false;
  const senderLedger = new SenderStartLedger((record) => {
    if (!ledgerPath) return;
    appendLedgerRecord(ledgerPath, record);
  });

  try {
    appPort = await reservePort();
    debugPort = await reservePort();
    profile = await mkdtemp(join(tmpdir(), "screener-native-one-viewer-"));
    ledgerPath = join(profile, "sender-start-ledger.jsonl");
    writeFileSync(ledgerPath, "", { encoding: "utf8", flag: "wx" });
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const config = loadConfig({
      NODE_ENV: "development",
      PORT: String(appPort),
      LISTEN_HOST: "127.0.0.1",
      PUBLIC_BASE_URL: baseUrl,
      ALLOWED_ORIGINS: baseUrl,
      SITE_ACCESS_PASSWORD: accessKey,
      PEER_ASSISTED_MEDIA: "true",
      STUN_URLS: "",
    });
    const roomStore = new ObservedRoomStore({
      leaseMs: config.roomLeaseMs,
      maxRooms: ROOM_CAPACITY,
      maxViewersPerRoom: config.maxViewersPerRoom,
    }, () => senderLedger.record({ hostWssAuthenticated: true }));
    server = await createScreenerServer({ config, roomStore });
    observeNodeStages(server, senderLedger);
    await server.listen(appPort, "127.0.0.1");

    native = spawn(goPath, ["run", "./cmd/screener-one-viewer-gate"], {
      cwd: join(root, "native", "sender"),
      stdio: "pipe",
      windowsHide: true,
    });
    native.stderr.resume();
    const launchUrl = await readLaunchUrl(native);
    nativePort = Number(new URL(launchUrl).port) || null;
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
      "--auto-select-tab-capture-source-by-title=Native Gate Source",
      "--window-size=1280,900",
      "about:blank",
    ], { stdio: "pipe", windowsHide: true });
    chrome.stdout.resume();
    chrome.stderr.resume();
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 5_000);
    report.stages.preflight = {
      serverInMemory: true,
      peerAssistedEnabled: config.peerAssistedMedia,
      oneViewerOnly: true,
      videoSource: gateVideoSource,
      nativeHelperConfigured: !nativeWindow || nativeHelperPath !== null,
      chromeMajor: Number(version.Browser.match(/Chrome\/(\d+)/)?.[1] ?? 0),
    };
    report.failedStage = "sender-start";

    await createPage(cdp, animatedSourceUrl(), undefined, nativeWindow);
    const activeSenderPage = await createPage(cdp, launchUrl, senderProbe(), nativeWindow);
    senderPage = activeSenderPage;
    let windowTargetId = "";
    if (windowTargetTitle) {
      await waitForSample(
        (deadline) => evaluate<string>(cdp!, activeSenderPage,
          `([...document.querySelector('#window-target').options].find((option) => option.text.includes(${JSON.stringify(windowTargetTitle)}))?.value || '')`, deadline),
        Boolean,
        5_000,
      );
      windowTargetId = await evaluate<string>(cdp, activeSenderPage,
        `([...document.querySelector('#window-target').options].find((option) => option.text.includes(${JSON.stringify(windowTargetTitle)}))?.value || '')`, Date.now() + 2_000);
    }
    await evaluate<void>(cdp, activeSenderPage, `(() => {
      document.querySelector('#server-url').value = ${JSON.stringify(baseUrl)};
      document.querySelector('#password').value = ${JSON.stringify(accessKey)};
      document.querySelector('#codec').value = ${JSON.stringify(gateMode)};
      document.querySelector('#window-target').value = ${JSON.stringify(windowTargetId)};
      document.querySelector('#start').click();
    })()`, Date.now() + 5_000);
    if (nativeWindow) {
      await waitForSample(async (deadline) => {
        const snapshot = await senderSnapshot(cdp!, activeSenderPage, deadline);
        senderLedger.record(senderStartObservation(snapshot, gateCodec, gateVideoSource));
        return { snapshot, ledger: senderLedger.snapshot() };
      }, ({ snapshot, ledger }) => nativeSenderStartComplete(snapshot, ledger), 20_000);
    } else {
      await waitForSenderStart(
        async (deadline) => senderStartObservation(
          await senderSnapshot(cdp!, activeSenderPage, deadline), gateCodec, gateVideoSource,
        ),
        senderLedger,
        { timeoutMs: 20_000 },
      );
    }
    const senderReady = await senderSnapshot(cdp, activeSenderPage, Date.now() + 3_000);
    const senderStartChecks = {
      correctVideoSource: senderReady.config?.videoSource === gateVideoSource,
      currentBridge: retainsExpectedBridge(senderReady, nativeWindow),
      noCriticalErrors: senderReady.encoderErrors === 0 && senderReady.fatalEvents === 0,
      ...(nativeWindow ? {
        noBrowserCapture: !senderReady.getDisplayMediaRequested && !senderReady.getDisplayMediaResolved,
        nativeHardwareStarting: senderReady.nativeHardwareStarting,
        nativeHardwareActive: senderReady.nativeHardwareActive,
        noBrowserVideoEncoder: senderReady.encoderInstances === 0,
      } : { oneEncoderObject: senderReady.encoderInstances === 1 }),
    };
    report.stages["sender-start"] = {
      ...senderLedger.snapshot(), ...senderStartChecks,
      adapterLuid: nativeWindow ? senderReady.nativeAdapterLuid : null,
    };
    requireChecks(senderStartChecks);
    report.failedStage = "node-host";
    const inviteUrl = await evaluate<string>(cdp, activeSenderPage,
      `document.querySelector('#invite-link').href`, Date.now() + 3_000);
    const invite = new URL(inviteUrl);
    const roomId = invite.pathname.match(/^\/r\/([1-9][0-9]{0,11})$/)?.[1] ?? "";
    const viewerGrant = new URLSearchParams(invite.hash.slice(1)).get("v") ?? "";
    const nodeHost = {
      privateGrantBoundToRoom: new RegExp(`^g1\\.${roomId}\\.[1-9][0-9]{0,12}\\.[A-Za-z0-9_-]{43}$`).test(viewerGrant),
      provisionalRandomRoom: roomId !== "1",
    };
    report.stages["node-host"] = nodeHost;
    requireChecks(nodeHost);

    report.failedStage = "viewer-signal";
    const viewerPage = await createPage(cdp, inviteUrl, viewerProbe());
    let identity: OneViewerIdentity | null = null;
    await waitForSample(async (deadline) => ({
      viewer: await viewerSnapshot(cdp!, viewerPage, deadline),
      sender: await senderSnapshot(cdp!, activeSenderPage, deadline),
    }), ({ viewer, sender }) => {
      identity = captureOneViewerIdentity(viewer.identity, senderIdentity(sender));
      const checks = {
        viewerAuthenticated: viewer.signaling.authenticateSent === 1 &&
          viewer.signaling.authenticatedReceived === 1,
        peerJoined: sender.activeViewers === 1 && roomStore.getConnectedViewers(roomId).length === 1,
        offerAnswer: viewer.signaling.offersReceived >= 1 && viewer.signaling.answersSent >= 1,
        iceExchange: viewer.signaling.candidatesReceived >= 1 && viewer.signaling.candidatesSent >= 1,
        connected: viewer.connectionState === "connected" &&
          ["connected", "completed"].includes(viewer.iceConnectionState),
        pionConnected: sender.peers.length === 1 && sender.peers[0]?.connectionState === "connected" &&
          ["connected", "completed"].includes(sender.peers[0]?.iceConnectionState ?? ""),
        sameGeneration: identity !== null,
        sameBridge: retainsExpectedBridge(sender, nativeWindow),
        edgeBound: sender.maxPeers <= 1 && sender.peers.length === 1,
      };
      report.stages["viewer-signal"] = {
        ...checks,
        offersReceived: viewer.signaling.offersReceived,
        answersSent: viewer.signaling.answersSent,
        candidatesReceived: viewer.signaling.candidatesReceived,
        candidatesSent: viewer.signaling.candidatesSent,
        socketOrdinal: identity?.socketOrdinal ?? 0,
        authGeneration: identity?.authGeneration ?? 0,
        connectionOrdinal: identity?.connectionOrdinal ?? 0,
        pcOrdinal: identity?.pcOrdinal ?? 0,
        trackOrdinal: identity?.trackOrdinal ?? 0,
        pionSlot: identity?.pionSlot ?? -1,
        pionEdgeGeneration: identity?.pionEdgeGeneration ?? 0,
      };
      return Object.values(checks).every(Boolean);
    }, 20_000);

    report.failedStage = "viewer-media";
    if (!identity) throw new Error("Viewer generation was not established");
    const mediaBaselineDeadline = Date.now() + 3_000;
    const [beforeViewer, beforeSender] = await Promise.all([
      viewerSnapshot(cdp, viewerPage, mediaBaselineDeadline),
      senderSnapshot(cdp, activeSenderPage, mediaBaselineDeadline),
    ]);
    if (!retainsOneViewerIdentity(identity, beforeViewer.identity, senderIdentity(beforeSender))) {
      throw new Error("Viewer generation changed before media sampling");
    }
    await waitForSample(async (deadline) => ({
      viewer: await viewerSnapshot(cdp!, viewerPage, deadline),
      sender: await senderSnapshot(cdp!, activeSenderPage, deadline),
    }), ({ viewer, sender }) => {
      const sameGeneration = retainsOneViewerIdentity(identity!, viewer.identity, senderIdentity(sender));
      const pionOutbound = hasOneViewerPionProof(sameGeneration, {
        viewerPackets: beforeViewer.packetsReceived, viewerDecoded: beforeViewer.framesDecoded,
        viewerRendered: beforeViewer.renderedFrames, pionPackets: beforeSender.peers[0]?.packetsSent ?? 0,
        pionBytes: beforeSender.peers[0]?.bytesSent ?? 0,
      }, {
        viewerPackets: viewer.packetsReceived, viewerDecoded: viewer.framesDecoded,
        viewerRendered: viewer.renderedFrames, pionPackets: sender.peers[0]?.packetsSent ?? 0,
        pionBytes: sender.peers[0]?.bytesSent ?? 0,
      });
      const checks = {
        inboundPackets: viewer.packetsReceived > beforeViewer.packetsReceived,
        inboundBytes: viewer.bytesReceived > beforeViewer.bytesReceived,
        decodedFrames: viewer.framesDecoded > beforeViewer.framesDecoded,
        videoReady: viewer.videoReadyState >= 2 && viewer.videoWidth > 0 && viewer.videoHeight > 0,
        playbackClock: viewer.videoCurrentTime > beforeViewer.videoCurrentTime,
        renderedFrames: viewer.renderedFrames > beforeViewer.renderedFrames,
        pionOutbound,
        sameGeneration,
        sameBridge: retainsExpectedBridge(sender, nativeWindow),
        criticalErrors: sender.fatalEvents === 0 && sender.encoderErrors === 0,
        ...(nativeWindow ? {
          nativeHardwareActive: sender.nativeHardwareActive,
          noBrowserCapture: !sender.getDisplayMediaRequested && !sender.getDisplayMediaResolved,
          noBrowserVideoEncoder: sender.encoderInstances === 0,
        } : { oneEncoderObject: sender.encoderInstances === 1 }),
        ...(windowTargetTitle ? {
          audioTrack: viewer.audioTrackCount === 1,
          audioInbound: viewer.audioPacketsReceived > beforeViewer.audioPacketsReceived,
        } : {}),
      };
      report.stages["viewer-media"] = {
        ...checks,
        packetDelta: viewer.packetsReceived - beforeViewer.packetsReceived,
        byteDelta: viewer.bytesReceived - beforeViewer.bytesReceived,
        decodedDelta: viewer.framesDecoded - beforeViewer.framesDecoded,
        renderedDelta: viewer.renderedFrames - beforeViewer.renderedFrames,
        audioPacketDelta: viewer.audioPacketsReceived - beforeViewer.audioPacketsReceived,
        pionPacketDelta: (sender.peers[0]?.packetsSent ?? 0) - (beforeSender.peers[0]?.packetsSent ?? 0),
        pionByteDelta: (sender.peers[0]?.bytesSent ?? 0) - (beforeSender.peers[0]?.bytesSent ?? 0),
        pionPacketsSent: sender.peers[0]?.packetsSent ?? 0,
        pionBytesSent: sender.peers[0]?.bytesSent ?? 0,
        pcOrdinal: viewer.identity.pcOrdinal,
        pionSlot: sender.peers[0]?.slot ?? -1,
        pionEdgeGeneration: sender.peers[0]?.edgeGeneration ?? 0,
        route: safeRoute(sender.peers[0]?.route),
        videoWidth: viewer.videoWidth,
        videoHeight: viewer.videoHeight,
      };
      return Object.values(checks).every(Boolean);
    }, 10_000);
    const finalSender = await senderSnapshot(cdp, activeSenderPage, Date.now() + 3_000);
    const finalChecks = {
      finalBridge: retainsExpectedBridge(finalSender, nativeWindow),
      finalCriticalErrors: hasNoCriticalSenderErrors(finalSender),
      finalVideoSource: finalSender.config?.videoSource === gateVideoSource,
      ...(nativeWindow ? {
        finalNativeHardwareActive: finalSender.nativeHardwareActive,
        finalNoBrowserVideoEncoder: finalSender.encoderInstances === 0,
      } : {}),
    };
    report.stages["viewer-media"] = { ...report.stages["viewer-media"], ...finalChecks };
    requireChecks(finalChecks);
    gateSucceeded = true;
  } catch {
    // The bounded report retains only the first stage and sanitized counters.
  } finally {
    let finalSenderEvidence = false;
    const finalCdp = cdp;
    const finalSenderPage = senderPage;
    if (finalCdp && finalSenderPage) {
      finalSenderEvidence = await verifyFinalSenderEvidence(
        () => senderSnapshot(finalCdp, finalSenderPage, Date.now() + 1_000),
        (snapshot) => {
          senderLedger.record(senderStartObservation(snapshot, gateCodec, gateVideoSource));
          return senderLedger.snapshot();
        },
      );
    }
    report.stages["sender-start"] = {
      ...report.stages["sender-start"],
      ...senderLedger.snapshot(),
    };
    gateSucceeded = gateSucceeded && finalSenderEvidence;
    await finalizeGate(report, gateSucceeded, () => cleanupRun({
      cdp, native, chrome, server, profile,
      ports: [appPort, debugPort, nativePort].filter((port): port is number => port !== null),
    }));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  }
}

export function senderProbe(): string {
  return `(() => {
    const state = { getDisplayMediaRequested: false, getDisplayMediaResolved: false,
      nativeHardwareStarting: false, nativeHardwareActive: false,
      nativeAdapterLuid: null,
      ready: 0, configAccepted: 0,
      encoderInstances: 0, encoderOutputs: 0, encoderErrors: 0, fatalEvents: 0,
      bridgeGeneration: 0, binarySendAttempts: 0, binarySendSucceeded: 0, binarySendFailed: 0,
      diagnosticsObserved: false, postSendDiagnosticsObserved: false,
      postSendDiagnosticsSequence: 0,
      activeViewers: 0, maxPeers: 0, edgeGeneration: 0, activeEdgeSlot: null,
      config: null, media: null, peers: [] };
    const finite = (value) => Number.isFinite(value) ? value : 0;
    const mark = (key) => { state[key] = 1; };
    let activeBridgeSocket = null;
    const nativeGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: (...args) => {
        state.getDisplayMediaRequested = true;
        return nativeGetDisplayMedia(...args).then((stream) => {
          state.getDisplayMediaResolved = true;
          return stream;
        });
      },
    });
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class GateWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.__gateMedia = new URL(String(args[0]), location.href).pathname === '/media';
        if (!this.__gateMedia) return;
        state.bridgeGeneration = Math.min(2, state.bridgeGeneration + 1);
        this.__gateBridgeGeneration = state.bridgeGeneration;
        activeBridgeSocket = state.bridgeGeneration === 1 ? this : null;
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.kind === 'ready') state.ready += 1;
          if (message.kind === 'config-accepted') state.configAccepted += 1;
          if (message.kind === 'fatal') mark('fatalEvents');
          if (message.kind === 'native-video-state' && message.status?.hardwareOnly === true) {
            if (message.status.state === 'starting' && Number.isFinite(message.status.adapterIndex) &&
                typeof message.status.adapterName === 'string' && message.status.adapterName.length > 0 &&
                typeof message.status.adapterLuid === 'string' && message.status.adapterLuid.length > 0 &&
                Number.isFinite(message.status.mftIndex) &&
                typeof message.status.mftName === 'string' && message.status.mftName.length > 0 &&
                typeof message.status.mftClsid === 'string' && message.status.mftClsid.length > 0) {
              state.nativeHardwareStarting = true;
              state.nativeAdapterLuid = message.status.adapterLuid;
            }
            if (message.status.state === 'active' && state.nativeHardwareStarting &&
                message.status.profileLevelId === '42c01f' && message.status.width === 1280 &&
                message.status.height === 720 && message.status.fps === 30) {
              state.nativeHardwareActive = true;
            }
          }
          if (message.kind === 'ready' || message.kind === 'viewer-count') {
            state.activeViewers = finite(message.activeViewers);
          }
          if (message.kind === 'diagnostics') {
            state.diagnosticsObserved = true;
            if (state.binarySendSucceeded > 0) {
              state.postSendDiagnosticsObserved = true;
              state.postSendDiagnosticsSequence = Math.min(2, state.postSendDiagnosticsSequence + 1);
            }
            state.media = message.media ? {
              framesWritten: finite(message.media.framesWritten),
              sourceRtpPacketsWritten: finite(message.media.sourceRtpPacketsWritten),
              sourceRtpBytesWritten: finite(message.media.sourceRtpBytesWritten),
            } : null;
            const peers = Array.isArray(message.peers) ? message.peers.slice(0, 3) : [];
            const nextSlot = peers.length === 1 ? finite(peers[0].slot) : null;
            if (nextSlot !== null && nextSlot !== state.activeEdgeSlot) state.edgeGeneration += 1;
            state.activeEdgeSlot = nextSlot;
            state.peers = peers.map((peer) => ({
              slot: finite(peer.slot), edgeGeneration: state.edgeGeneration,
              connectionState: String(peer.connectionState || 'unknown'),
              iceConnectionState: String(peer.iceConnectionState || 'unknown'),
              route: String(peer.route || 'unknown'),
              packetsSent: finite(peer.packetsSent), bytesSent: finite(peer.bytesSent),
            }));
            state.maxPeers = Math.max(state.maxPeers, state.peers.length);
          }
        });
      }
      send(value) {
        if (this.__gateMedia && this === activeBridgeSocket &&
            this.__gateBridgeGeneration === 1 && value instanceof ArrayBuffer) {
          mark('binarySendAttempts');
          try {
            const result = super.send(value);
            mark('binarySendSucceeded');
            return result;
          } catch (error) {
            mark('binarySendFailed');
            throw error;
          }
        }
        if (this.__gateMedia) {
          if (typeof value === 'string') {
            let message; try { message = JSON.parse(value); } catch { message = null; }
            if (message?.kind === 'config') state.config = {
              codec: typeof message.codec === 'string' ? message.codec : null,
              videoSource: typeof message.videoSource === 'string' ? message.videoSource : null,
              width: finite(message.width), height: finite(message.height), fps: finite(message.fps),
              bitrate: finite(message.bitrate), encoderInstances: finite(message.encoderInstances),
            };
          }
        }
        return super.send(value);
      }
    };
    if (typeof globalThis.VideoEncoder === 'function') {
      const NativeVideoEncoder = globalThis.VideoEncoder;
      globalThis.VideoEncoder = new Proxy(NativeVideoEncoder, {
        construct(Target, args) {
          const init = args[0] || {};
          const wrapped = { ...init,
            output: (...values) => { state.encoderOutputs += 1; return init.output(...values); },
            error: (...values) => { mark('encoderErrors'); return init.error(...values); },
          };
          const encoder = Reflect.construct(Target, [wrapped], Target);
          state.encoderInstances += 1;
          return encoder;
        },
        get(Target, property, receiver) {
          const value = Reflect.get(Target, property, receiver);
          return typeof value === 'function' && property === 'isConfigSupported' ? value.bind(Target) : value;
        },
      });
    }
    Object.defineProperty(globalThis, '__NATIVE_ONE_VIEWER_GATE__', {
      value: { snapshot: () => structuredClone(state) }, configurable: false,
    });
  })();`;
}

function viewerProbe(): string {
  return `(() => {
    const state = { signaling: { authenticateSent: 0, authenticatedReceived: 0,
      offersReceived: 0, answersSent: 0, candidatesReceived: 0, candidatesSent: 0 },
      socketCount: 0, socketSequence: 0, logicalSocketCount: 0,
      authenticateSocketOrdinal: 0, authSocketOrdinal: 0, logicalAuthSocketOrdinal: 0,
      authGeneration: 0,
      connectionIds: [], activeConnectionId: null, preOfferConnectionId: null,
      consistent: true, pendingOffer: null,
      pcs: [], boundPcOrdinal: 0, boundConnectionOrdinal: 0, boundSocketOrdinal: 0,
      boundAuthGeneration: 0, trackCount: 0, trackOrdinal: 0, trackPcOrdinal: 0,
      audioTrackCount: 0,
      renderedFrames: 0, observedVideo: null };
    const connectionOrdinal = (value) => {
      let index = state.connectionIds.indexOf(value);
      if (index < 0) { state.connectionIds.push(value); index = state.connectionIds.length - 1; }
      return index + 1;
    };
    const inspect = (data, direction, socketOrdinal) => {
      if (typeof data !== 'string') return;
      let message; try { message = JSON.parse(data); } catch { return; }
      if (direction === 'out' && message.type === 'authenticate') {
        state.signaling.authenticateSent += 1; state.authenticateSocketOrdinal = socketOrdinal; return;
      }
      if (direction === 'in' && message.type === 'authenticated') {
        state.signaling.authenticatedReceived += 1;
        const activeMediaStarted = state.activeConnectionId !== null || state.boundPcOrdinal > 0;
        if (state.authGeneration === 0) {
          state.authGeneration = 1;
          state.logicalSocketCount = 1;
          state.logicalAuthSocketOrdinal = 1;
        } else if (activeMediaStarted) {
          state.authGeneration += 1;
          state.logicalSocketCount += 1;
          state.logicalAuthSocketOrdinal = state.logicalSocketCount;
          state.consistent = false;
        }
        state.authSocketOrdinal = socketOrdinal;
        if (state.authenticateSocketOrdinal !== socketOrdinal) state.consistent = false;
        return;
      }
      if (message.type !== 'signal' || !message.payload) return;
      const rawConnectionId = message.payload.connectionId;
      if (typeof rawConnectionId !== 'string' || state.authSocketOrdinal !== socketOrdinal) {
        state.consistent = false; return;
      }
      const ordinal = connectionOrdinal(rawConnectionId);
      const inboundOffer = direction === 'in' && message.payload.kind === 'description' &&
        message.payload.description?.type === 'offer';
      if (state.activeConnectionId === null) {
        if (inboundOffer) {
          if (state.preOfferConnectionId !== null && state.preOfferConnectionId !== rawConnectionId) {
            state.consistent = false;
          }
          state.activeConnectionId = rawConnectionId;
        } else if (state.preOfferConnectionId === null) {
          // Pion may trickle a candidate before the offer write reaches the Viewer.
          state.preOfferConnectionId = rawConnectionId;
        } else if (state.preOfferConnectionId !== rawConnectionId) {
          state.consistent = false;
        }
      }
      if (state.activeConnectionId !== rawConnectionId) state.consistent = false;
      if (inboundOffer) {
        state.signaling.offersReceived += 1;
        state.pendingOffer = { rawConnectionId, ordinal, socketOrdinal, authGeneration: state.authGeneration };
      }
      if (direction === 'out' && message.payload.kind === 'description' && message.payload.description?.type === 'answer') {
        state.signaling.answersSent += 1;
        if (state.boundConnectionOrdinal !== ordinal || state.boundSocketOrdinal !== socketOrdinal ||
            state.boundAuthGeneration !== state.authGeneration) state.consistent = false;
      }
      if (direction === 'in' && message.payload.kind === 'candidate') state.signaling.candidatesReceived += 1;
      if (direction === 'out' && message.payload.kind === 'candidate') state.signaling.candidatesSent += 1;
    };
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class GateWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.__gateSignal = new URL(String(args[0]), location.href).pathname === '/signal';
        if (this.__gateSignal) {
          this.__gateSocketOrdinal = ++state.socketSequence;
          this.addEventListener('message', (event) => inspect(event.data, 'in', this.__gateSocketOrdinal));
        }
      }
      send(value) {
        if (this.__gateSignal) inspect(value, 'out', this.__gateSocketOrdinal);
        return super.send(value);
      }
    };
    const NativePeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = class GatePeerConnection extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        state.pcs.push(this);
        this.__gatePcOrdinal = state.pcs.length;
        this.addEventListener('track', (event) => {
          if (event.track?.kind === 'audio') { state.audioTrackCount += 1; return; }
          if (event.track?.kind !== 'video') return;
          state.trackCount += 1; state.trackOrdinal = state.trackCount;
          state.trackPcOrdinal = this.__gatePcOrdinal;
        });
      }
      async setRemoteDescription(description) {
        const result = await super.setRemoteDescription(description);
        if (description?.type === 'offer') {
          const offer = state.pendingOffer;
          if (!offer || offer.rawConnectionId !== state.activeConnectionId) state.consistent = false;
          else {
            state.boundPcOrdinal = this.__gatePcOrdinal;
            state.boundConnectionOrdinal = offer.ordinal;
            state.boundSocketOrdinal = offer.socketOrdinal;
            state.boundAuthGeneration = offer.authGeneration;
          }
        }
        return result;
      }
    };
    async function snapshot() {
      const video = document.querySelector('.remote-stage video');
      if (video && state.observedVideo !== video && typeof video.requestVideoFrameCallback === 'function') {
        state.observedVideo = video;
        const frame = () => { state.renderedFrames += 1; video.requestVideoFrameCallback(frame); };
        video.requestVideoFrameCallback(frame);
      }
      const pc = state.pcs[state.boundPcOrdinal - 1];
      let packetsReceived = 0, bytesReceived = 0, framesDecoded = 0;
      let audioPacketsReceived = 0, audioBytesReceived = 0;
      if (pc) {
        const stats = await pc.getStats();
        stats.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video' && entry.isRemote !== true) {
            packetsReceived += finite(entry.packetsReceived);
            bytesReceived += finite(entry.bytesReceived);
            framesDecoded += finite(entry.framesDecoded);
          }
          if (entry.type === 'inbound-rtp' && entry.kind === 'audio' && entry.isRemote !== true) {
            audioPacketsReceived += finite(entry.packetsReceived);
            audioBytesReceived += finite(entry.bytesReceived);
          }
        });
      }
      const activeOrdinal = state.activeConnectionId === null ? 0 :
        state.connectionIds.indexOf(state.activeConnectionId) + 1;
      const identity = { socketCount: state.logicalSocketCount,
        socketOrdinal: state.logicalAuthSocketOrdinal,
        authGeneration: state.authGeneration, connectionCount: state.connectionIds.length,
        connectionOrdinal: activeOrdinal, pcCount: state.pcs.length, pcOrdinal: state.boundPcOrdinal,
        trackCount: state.trackCount, trackOrdinal: state.trackOrdinal,
        consistent: state.consistent && state.boundConnectionOrdinal === activeOrdinal &&
          state.boundSocketOrdinal === state.authSocketOrdinal &&
          state.boundAuthGeneration === state.authGeneration && state.trackPcOrdinal === state.boundPcOrdinal };
      return { signaling: structuredClone(state.signaling), identity,
        connectionState: pc?.connectionState || 'none',
        iceConnectionState: pc?.iceConnectionState || 'none', packetsReceived, bytesReceived, framesDecoded,
        videoReadyState: finite(video?.readyState), videoWidth: finite(video?.videoWidth),
        videoHeight: finite(video?.videoHeight), videoCurrentTime: finite(video?.currentTime),
        renderedFrames: state.renderedFrames, audioTrackCount: state.audioTrackCount,
        audioPacketsReceived, audioBytesReceived };
    }
    const finite = (value) => Number.isFinite(value) ? value : 0;
    Object.defineProperty(globalThis, '__NATIVE_VIEWER_GATE__', {
      value: { snapshot }, configurable: false,
    });
  })();`;
}

function senderSnapshot(cdp: CdpConnection, page: PageHandle, deadline: number): Promise<SenderSnapshot> {
  return evaluate(cdp, page, "globalThis.__NATIVE_ONE_VIEWER_GATE__.snapshot()", deadline);
}

function viewerSnapshot(cdp: CdpConnection, page: PageHandle, deadline: number): Promise<ViewerSnapshot> {
  return evaluate(cdp, page, "globalThis.__NATIVE_VIEWER_GATE__.snapshot()", deadline);
}

function senderIdentity(sender: SenderSnapshot): SenderIdentityEvidence {
  const peer = sender.peers[0];
  return { peerCount: sender.peers.length, maxPeers: sender.maxPeers,
    slot: peer?.slot ?? -1, edgeGeneration: peer?.edgeGeneration ?? 0 };
}

function requireChecks(checks: Record<string, boolean>): void {
  if (!Object.values(checks).every(Boolean)) throw new Error("Gate check failed");
}

function safeRoute(value: string | undefined): string {
  return new Set(["direct-udp", "direct-tcp"])
    .has(value ?? "") ? value! : "unknown";
}

async function readLaunchUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  let buffer = "";
  return new Promise((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => rejectUrl(new Error("Native runner startup timed out")), 20_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(buffer.slice(0, end)) as { launchUrl?: unknown };
        if (typeof parsed.launchUrl !== "string") throw new Error();
        resolveUrl(parsed.launchUrl);
      } catch {
        rejectUrl(new Error("Native runner handoff was invalid"));
      }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      rejectUrl(new Error("Native runner exited before handoff"));
    });
  });
}

export function animatedSourceUrl(): string {
  const html = `<!doctype html><title>Native Gate Source</title><canvas width="1280" height="720"></canvas>
    <script>const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();g.gain.value=.02;
    o.connect(g).connect(a.destination);o.start();
    const c=document.querySelector('canvas'),x=c.getContext('2d');let f=0;
    setInterval(()=>{f++;x.fillStyle='hsl('+f%360+' 80% 35%)';x.fillRect(0,0,1280,720);
    x.fillStyle='white';x.fillRect(f*13%1280,0,20,720);x.font='64px monospace';x.fillText(f,40,90)},33);<\/script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
