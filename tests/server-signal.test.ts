import { connect } from "node:net";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES,
  MAX_SIGNAL_BYTES,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  SIGNALING_PROTOCOL,
  decodeServerMessage,
  type ParentEdgeQualityProof,
  type Role,
  type ServerMessage,
  type ViewerQualityEvidenceMetrics,
} from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import { RoomDatabase } from "../src/server/room-database.ts";
import { RoomStore, type CreatedRoom } from "../src/server/room-store.ts";
import { SignalingServer } from "../src/server/signaling.ts";
import type { SfuTokenIssuer } from "../src/server/livekit-token.ts";
import { HybridMediaRouter } from "../src/server/hybrid-media-router.ts";

const allowedOrigin = "http://allowed.test";
const defaultQualitySettings = {
  resolution: "1080p",
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "balanced",
  videoCodec: "automatic",
  screenAudioQuality: "music",
} as const;
const balancedQualitySettings = {
  resolution: "1080p",
  maxFramerate: 30,
  maxBitrate: 5_000_000,
  degradationPreference: "balanced",
  screenAudioQuality: "saver",
} as const;
const lowQualitySettings = {
  resolution: "720p",
  maxFramerate: 30,
  maxBitrate: 3_000_000,
  degradationPreference: "maintain-resolution",
  screenAudioQuality: "very-high",
} as const;
let runningServer: ScreenerServer | undefined;

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
});

class MessageInbox {
  private readonly messages: ServerMessage[] = [];
  private readonly ignoredTypes = new Set<ServerMessage["type"]>();
  private readonly waiters: Array<{
    type: ServerMessage["type"];
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = decodeServerMessage(data.toString());
      if (this.ignoredTypes.has(message.type)) {
        return;
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex === -1) {
        this.messages.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
  }

  next<Type extends ServerMessage["type"]>(
    type: Type,
    timeoutMs = 1_000,
  ): Promise<Extract<ServerMessage, { type: Type }>> {
    const existingIndex = this.messages.findIndex((message) => message.type === type);
    if (existingIndex !== -1) {
      const [message] = this.messages.splice(existingIndex, 1);
      return Promise.resolve(message as Extract<ServerMessage, { type: Type }>);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex !== -1) {
          this.waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({
        type,
        resolve: (message) =>
          resolve(message as Extract<ServerMessage, { type: Type }>),
        reject,
        timer,
      });
    });
  }

  async expectNone(timeoutMs: number): Promise<void> {
    if (this.messages.length > 0) {
      throw new Error(`Unexpected message: ${this.messages[0].type}`);
    }
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    if (this.messages.length > 0) {
      throw new Error(`Unexpected message: ${this.messages[0].type}`);
    }
  }

  ignore(type: ServerMessage["type"]): void {
    this.ignoredTypes.add(type);
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.type === type) {
        this.messages.splice(index, 1);
      }
    }
  }
}

interface TestClient {
  socket: WebSocket;
  inbox: MessageInbox;
}

interface SignalHarness {
  baseUrl: string;
  webSocketUrl: string;
  roomStore: RoomStore;
  room: CreatedRoom;
  database?: RoomDatabase;
}

function testConfig(): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    listenHost: "127.0.0.1",
    publicBaseUrl: new URL("https://share.example.test"),
    allowedOrigins: new Set([allowedOrigin]),
    roomTtlMs: 14_400_000,
    maxRooms: 10,
    maxViewersPerRoom: 8,
    peerAssistedMedia: false,
    endpointMediaCopyCapacity: 2,
    stunUrls: [],
  };
}

async function startHarness(
  overrides: {
    authenticationTimeoutMs?: number;
    viewerDisconnectGraceMs?: number;
    maxViewersPerRoom?: number;
    maxSignalConnections?: number;
    maxUnauthenticatedSignalConnections?: number;
    siteAccessPassword?: string;
    persistent?: boolean;
    provisionalHostClaimSeconds?: number;
    peerAssistedMedia?: boolean;
    endpointMediaCopyCapacity?: number;
    stunUrls?: readonly string[];
    now?: () => number;
  } = {},
): Promise<SignalHarness> {
  const config = testConfig();
  config.siteAccessPassword = overrides.siteAccessPassword;
  config.peerAssistedMedia = overrides.peerAssistedMedia ?? false;
  config.endpointMediaCopyCapacity =
    overrides.endpointMediaCopyCapacity ?? 2;
  config.stunUrls = overrides.stunUrls ?? [];
  const maxViewersPerRoom = overrides.maxViewersPerRoom ?? 8;
  config.maxViewersPerRoom = maxViewersPerRoom;
  const database = overrides.persistent ? new RoomDatabase(":memory:") : undefined;
  const roomStore = new RoomStore({
    ttlMs: config.roomTtlMs,
    maxRooms: config.maxRooms,
    maxViewersPerRoom,
    database,
    now: overrides.now,
  });
  const room = roomStore.createRoom(
    "private-link",
    overrides.provisionalHostClaimSeconds,
  );
  runningServer = await createScreenerServer({
    config,
    roomStore,
    serveFrontend: false,
    now: overrides.now,
    authenticationTimeoutMs: overrides.authenticationTimeoutMs ?? 500,
    viewerDisconnectGraceMs: overrides.viewerDisconnectGraceMs ?? 50,
    heartbeatIntervalMs: 60_000,
    cleanupIntervalMs: 60_000,
    maxSignalConnections: overrides.maxSignalConnections,
    maxUnauthenticatedSignalConnections:
      overrides.maxUnauthenticatedSignalConnections,
  });
  const port = await runningServer.listen(0, "127.0.0.1");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    webSocketUrl: `ws://127.0.0.1:${port}/signal`,
    roomStore,
    room,
    database,
  };
}

function viewerQualityEvidence(
  connectionId: string,
  routeRevision: number,
  sequence: number,
  bitrateKbps = 7_500,
) {
  return {
    type: "viewer-quality-evidence",
    guard: { connectionId, routeRevision },
    sequence,
    windowMs: 2_000,
    metrics: {
      width: 1_920,
      height: 1_080,
      framesPerSecond: 60,
      bitrateKbps,
      packetsReceivedDelta: 1_500,
      packetsLostDelta: 2,
      jitterMs: 3.5,
      framesDecodedDelta: 120,
      framesDroppedDelta: 1,
      decodeMsPerFrame: 2.4,
      freezeCountDelta: 0,
      freezeDurationMsDelta: 0,
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      codecParameters:
        "packetization-mode=1; level-asymmetry-allowed=1",
    },
  } as const;
}

function viewerQualityEvidenceWithMetrics(
  connectionId: string,
  routeRevision: number,
  sequence: number,
  metrics: Partial<ViewerQualityEvidenceMetrics>,
) {
  const evidence = viewerQualityEvidence(
    connectionId,
    routeRevision,
    sequence,
  );
  return {
    ...evidence,
    metrics: { ...evidence.metrics, ...metrics },
  };
}

async function correlateParentEdgeQualityEvidence(
  parent: TestClient,
  proof: ParentEdgeQualityProof = {
    kind: "remote-loss",
    packetsSentDelta: 100,
    remotePacketsLostDelta: 30,
  },
) {
  const viewerEvidence = await parent.inbox.next("viewer-quality-evidence");
  parent.socket.send(
    JSON.stringify({
      type: "parent-edge-quality-evidence",
      viewerPeerId: viewerEvidence.viewerPeerId,
      guard: viewerEvidence.guard,
      viewerSequence: viewerEvidence.sequence,
      proof,
    }),
  );
  return viewerEvidence;
}

async function sendTestOffer(
  source: TestClient,
  target: TestClient,
  targetPeerId: string,
  connectionId: string,
) {
  source.socket.send(
    JSON.stringify({
      type: "signal",
      targetPeerId,
      payload: {
        kind: "description",
        connectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }),
  );
  return target.inbox.next("signal");
}

async function startRelayRelativeFpsFixture(
  prefix: string,
  now: () => number,
  options: {
    alternateRelayCapacity?: 0 | 1 | 2;
    issueSfuToken?: (peerId: string) => Promise<string>;
    onSfuTokenIssue?: () => void;
    prepareTimeoutMs?: number;
    hostFirstCandidate?: boolean;
    hostShareGeneration?: string;
    secondChild?: boolean;
    selectedEdgeTurn?: boolean;
    sfu?: boolean;
  } = {},
) {
  const harness = options.sfu
      ? await startSfuHarness({
        now,
        prepareTimeoutMs: options.prepareTimeoutMs,
        selectedEdgeTurn: options.selectedEdgeTurn,
        tokenIssuer: {
          issueToken: async ({ peerId }) => {
            options.onSfuTokenIssue?.();
            return options.issueSfuToken?.(peerId) ?? `token-${peerId}`;
          },
        },
      })
    : await startHarness({ peerAssistedMedia: true, now });
  const host = await openClient(harness.webSocketUrl);
  const hostAuth = peerAssisted(
    await authenticate(
      host,
      harness.room,
      "host",
      `${prefix}-host`,
      1,
      options.hostShareGeneration,
    ),
  );
  const parent = await openClient(harness.webSocketUrl);
  const parentAuth = peerAssisted(
    await authenticate(
      parent,
      harness.room,
      "viewer",
      `${prefix}-parent`,
      options.secondChild || options.hostFirstCandidate ? 2 : 1,
    ),
  );
  const releasedHostSlot = options.hostFirstCandidate
    ? await openClient(harness.webSocketUrl)
    : undefined;
  if (releasedHostSlot) {
    await authenticate(
      releasedHostSlot,
      harness.room,
      "viewer",
      `${prefix}-released-host-slot`,
      0,
    );
  }
  const alternate = await openClient(harness.webSocketUrl);
  const alternateAuth = peerAssisted(
    await authenticate(
      alternate,
      harness.room,
      "viewer",
      `${prefix}-alternate`,
      options.alternateRelayCapacity ?? 1,
    ),
  );
  const child = await openClient(harness.webSocketUrl);
  const childAuth = peerAssisted(
    await authenticate(child, harness.room, "viewer", `${prefix}-child`, 0),
  );
  const secondChild = options.secondChild
    ? await openClient(harness.webSocketUrl)
    : undefined;
  const secondChildAuth = secondChild
    ? peerAssisted(
        await authenticate(
          secondChild,
          harness.room,
          "viewer",
          `${prefix}-second-child`,
          0,
        ),
      )
    : undefined;
  expect(parentAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: hostAuth.peerId,
  });
  expect(alternateAuth.routeAssignment.upstream).toEqual({ kind: "peer",
    peerId: options.hostFirstCandidate ? parentAuth.peerId : hostAuth.peerId });
  expect(childAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: parentAuth.peerId,
  });
  expect(secondChildAuth?.routeAssignment.upstream).toEqual(
    secondChildAuth
      ? { kind: "peer", peerId: parentAuth.peerId }
      : undefined,
  );
  let routeRevision = secondChildAuth?.routeRevision ?? childAuth.routeRevision;
  if (secondChildAuth) {
    await nextActiveRouteRevision(child, routeRevision);
  }
  if (releasedHostSlot) {
    releasedHostSlot.socket.close();
    const [releasedRoute] = await Promise.all([
      nextActiveRouteAfter(child, routeRevision),
      nextActiveRouteAfter(host, routeRevision),
      nextActiveRouteAfter(parent, routeRevision),
      nextActiveRouteAfter(alternate, routeRevision),
    ]);
    routeRevision = releasedRoute.revision;
  }

  const parentConnectionId = `${prefix}_parent_connection`;
  await sendTestOffer(host, parent, parentAuth.peerId, parentConnectionId);

  const childConnectionId = `${prefix}_child_connection`;
  await sendTestOffer(parent, child, childAuth.peerId, childConnectionId);

  const secondChildConnectionId = `${prefix}_second_child_connection`;
  if (secondChild && secondChildAuth) {
    await sendTestOffer(
      parent,
      secondChild,
      secondChildAuth.peerId,
      secondChildConnectionId,
    );
  }

  return {
    alternate,
    alternateAuth,
    child,
    childAuth,
    childConnectionId,
    harness,
    host,
    hostAuth,
    parent,
    parentAuth,
    parentConnectionId,
    routeRevision,
    secondChild,
    secondChildAuth,
    secondChildConnectionId,
  };
}

async function correlateRelayParentInboundFps(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  framesPerSecond: number,
  sequence = 0,
) {
  fixture.parent.socket.send(
    JSON.stringify(
      viewerQualityEvidenceWithMetrics(
        fixture.parentConnectionId,
        fixture.routeRevision,
        sequence,
        { framesPerSecond },
      ),
    ),
  );
  while (true) {
    const evidence = await fixture.host.inbox.next("viewer-quality-evidence");
    if (evidence.viewerPeerId !== fixture.parentAuth.peerId) {
      continue;
    }
    fixture.host.socket.send(
      JSON.stringify({
        type: "parent-edge-quality-evidence",
        viewerPeerId: evidence.viewerPeerId,
        guard: evidence.guard,
        viewerSequence: evidence.sequence,
        proof: { kind: "sending", packetsSentDelta: 1_500 },
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return;
  }
}

async function correlateRelayChildFps(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  sequence: number,
  framesPerSecond: number,
  child = fixture.child,
  connectionId = fixture.childConnectionId,
) {
  child.socket.send(
    JSON.stringify(
      viewerQualityEvidenceWithMetrics(
        connectionId,
        fixture.routeRevision,
        sequence,
        { framesPerSecond },
      ),
    ),
  );
  await correlateParentEdgeQualityEvidence(fixture.parent, {
    kind: "sender-limited",
    packetsSentDelta: 1_500,
    reason: "bandwidth",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function confirmRelayChildRelativeFps(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  child: TestClient,
  connectionId: string,
  advanceWindow: () => void,
) {
  for (let sequence = 0; sequence < 3; sequence += 1) {
    await correlateRelayChildFps(
      fixture,
      sequence,
      10,
      child,
      connectionId,
    );
    if (sequence < 2) advanceWindow();
  }
}

async function confirmRelayParentChildRelativeFps(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  childIndex: 0 | 1,
  advanceWindow: () => void,
) {
  const child = childIndex === 0 ? fixture.child : fixture.secondChild!;
  const connectionId = childIndex === 0
    ? fixture.childConnectionId
    : fixture.secondChildConnectionId;
  await correlateRelayParentInboundFps(fixture, 30, childIndex);
  await confirmRelayChildRelativeFps(
    fixture,
    child,
    connectionId,
    advanceWindow,
  );
}

async function confirmRelayChildSevere(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  child: TestClient,
  connectionId: string,
  advanceWindow: () => void,
) {
  for (let sequence = 0; sequence < 3; sequence += 1) {
    child.socket.send(JSON.stringify(viewerQualityEvidenceWithMetrics(
      connectionId,
      fixture.routeRevision,
      sequence,
      { framesDecodedDelta: 0 },
    )));
    await correlateParentEdgeQualityEvidence(fixture.parent);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (sequence < 2) advanceWindow();
  }
}

async function prepareHostParentQualityProbe(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  advanceWindow: () => void,
  connectionId: string,
) {
  fixture.alternate.socket.close();
  const [current] = await Promise.all([
    nextActiveRouteAfter(fixture.child, fixture.routeRevision),
    nextActiveRouteAfter(fixture.parent, fixture.routeRevision),
    nextActiveRouteAfter(fixture.host, fixture.routeRevision),
  ]);
  fixture.routeRevision = current.revision;
  await confirmRelayChildSevere(
    fixture,
    fixture.child,
    fixture.childConnectionId,
    advanceWindow,
  );
  const [viewerPrepare, hostPrepare] = await Promise.all([
    nextPreparedRoute(fixture.child),
    nextPreparedRoute(fixture.host),
  ]);
  expect(viewerPrepare.assignment.upstream).toEqual({
    kind: "peer",
    peerId: fixture.hostAuth.peerId,
  });
  expect(hostPrepare.revision).toBe(viewerPrepare.revision);
  await sendTestOffer(
    fixture.host,
    fixture.child,
    fixture.childAuth.peerId,
    connectionId,
  );
  return { viewerPrepare, hostPrepare };
}

async function reconnectRelayQualityEdges(
  fixture: Awaited<ReturnType<typeof startRelayRelativeFpsFixture>>,
  suffix: string,
) {
  const secondChild = fixture.secondChild!;
  const secondChildAuth = fixture.secondChildAuth!;
  fixture.parentConnectionId = `${suffix}_parent_connection`;
  await sendTestOffer(
    fixture.host,
    fixture.parent,
    fixture.parentAuth.peerId,
    fixture.parentConnectionId,
  );
  fixture.secondChildConnectionId = `${suffix}_second_child_connection`;
  await sendTestOffer(
    fixture.parent,
    secondChild,
    secondChildAuth.peerId,
    fixture.secondChildConnectionId,
  );
}

async function startSfuHarness(options: {
  tokenIssuer: SfuTokenIssuer;
  selectedEdgeTurn?: boolean;
  persistent?: boolean;
  prepareTimeoutMs?: number;
  maxRoots?: number;
  endpointMediaCopyCapacity?: number;
  viewerDisconnectGraceMs?: number;
  stunUrls?: readonly string[];
  now?: () => number;
}): Promise<SignalHarness> {
  const roomStore = new RoomStore({
    ttlMs: 14_400_000,
    maxRooms: 10,
    maxViewersPerRoom: 8,
    database: options.persistent ? new RoomDatabase(":memory:") : undefined,
  });
  if (options.persistent) {
    roomStore.createRoom();
  }
  const room = roomStore.createRoom();
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const signaling = new SignalingServer({
    server: httpServer,
    roomStore,
    peerAssistedMedia: true,
    endpointMediaCopyCapacity:
      options.endpointMediaCopyCapacity ?? 2,
    sfuFallback: {
      url: "wss://sfu.example.test",
      tokenIssuer: options.tokenIssuer,
      maxRoots: options.maxRoots ?? 2,
      prepareTimeoutMs: options.prepareTimeoutMs,
    },
    ...(options.selectedEdgeTurn
      ? {
          selectedEdgeTurn: {
            urls: ["turn:turn.example.test:3478?transport=udp"],
            sharedSecret: "t".repeat(32),
            credentialTtlSeconds: 120,
          },
        }
      : {}),
    ice: {
      stunUrls: options.stunUrls ?? [],
    },
    allowedOrigins: new Set([allowedOrigin]),
    siteAccessAtUpgrade: () => true,
    publicBaseUrl: new URL("https://share.example.test"),
    now: options.now,
    authenticationTimeoutMs: 500,
    viewerDisconnectGraceMs: options.viewerDisconnectGraceMs ?? 50,
    heartbeatIntervalMs: 60_000,
    cleanupIntervalMs: 60_000,
  });
  runningServer = {
    httpServer,
    roomStore,
    listen: (port = 0, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("Test HTTP server has no TCP address"));
            return;
          }
          resolve(address.port);
        });
      }),
    async close() {
      await signaling.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      roomStore.close();
    },
  };
  const port = await runningServer.listen();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    webSocketUrl: `ws://127.0.0.1:${port}/signal`,
    roomStore,
    room,
  };
}

async function openClient(
  webSocketUrl: string,
  cookie?: string,
): Promise<TestClient> {
  const socket = new WebSocket(webSocketUrl, {
    origin: allowedOrigin,
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox: new MessageInbox(socket) };
}

async function rejectedUpgradeStatus(
  webSocketUrl: string,
  origin = allowedOrigin,
): Promise<number | undefined> {
  const socket = new WebSocket(webSocketUrl, { origin });
  socket.on("error", () => {
    // The HTTP status is asserted through unexpected-response below.
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => reject(new Error("WebSocket upgrade unexpectedly succeeded")));
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      resolve(status);
    });
  });
}

async function rawUpgradeResponse(
  webSocketUrl: string,
  requestTarget: string,
): Promise<string> {
  const url = new URL(webSocketUrl);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(Number(url.port), url.hostname);
    socket.setTimeout(2_000, () => socket.destroy(new Error("Raw upgrade timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${requestTarget} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Origin: ${allowedOrigin}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

async function authenticate(
  client: TestClient,
  room: CreatedRoom,
  role: Role,
  clientId: string,
  relayCapacity: 0 | 1 | 2 | 3 | null = 1,
  shareGeneration?: string,
  presence: {
    displayName?: string;
    viewerPresence?: true;
    viewerPasswordSettings?: true;
    viewerPassword?: string;
    sharingPaused?: boolean;
  } = {},
) {
  client.socket.send(
    JSON.stringify(
      role === "host"
          ? {
            type: "authenticate",
            protocol: SIGNALING_PROTOCOL,
            roomId: room.roomId,
            role,
            token: room.hostToken,
            clientId,
            ...(shareGeneration ? { shareGeneration } : {}),
            ...(presence.sharingPaused !== undefined
              ? { sharingPaused: presence.sharingPaused }
              : {}),
            ...(presence.viewerPresence ? { viewerPresence: true } : {}),
            ...(presence.viewerPasswordSettings
              ? { viewerPasswordSettings: true }
              : {}),
            ...(presence.displayName
              ? { displayName: presence.displayName }
              : {}),
          }
        : {
            type: "authenticate",
            protocol: SIGNALING_PROTOCOL,
            roomId: room.roomId,
            role,
            clientId,
            ...(presence.viewerPassword
              ? { viewerPassword: presence.viewerPassword }
              : room.viewerGrant
                ? { viewerGrant: room.viewerGrant }
                : {}),
            ...(presence.displayName
              ? { displayName: presence.displayName }
              : {}),
            ...(presence.viewerPresence ? { viewerPresence: true } : {}),
          },
    ),
  );
  const authenticated = await client.inbox.next("authenticated");
  if (
    role === "viewer" &&
    relayCapacity !== null &&
    "mediaMode" in authenticated
  ) {
    client.socket.send(
      JSON.stringify({
        type: "relay-capacity",
        downstreamEdges: relayCapacity,
      }),
    );
  }
  return authenticated;
}

function peerAssisted(
  message: Extract<ServerMessage, { type: "authenticated" }>,
) {
  if (!("mediaMode" in message)) {
    throw new Error("Expected a peer-assisted authenticated message");
  }
  return message;
}

async function nextActiveRouteAfter(
  client: TestClient,
  revision: number,
) {
  while (true) {
    const message = await client.inbox.next("route-update");
    if (message.phase === "active" && message.revision > revision) {
      return message;
    }
  }
}

async function nextViewerPresenceMatching(
  client: TestClient,
  predicate: (
    message: Extract<ServerMessage, { type: "viewer-presence" }>,
  ) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = await client.inbox.next("viewer-presence");
    if (predicate(message)) {
      return message;
    }
  }
  throw new Error("Viewer presence did not reach the expected state");
}

function viewerPresenceEntries(
  message: Extract<ServerMessage, { type: "viewer-presence" }>,
) {
  return message.viewers.filter((participant) => participant.role === "viewer");
}

function hostPresenceEntry(
  message: Extract<ServerMessage, { type: "viewer-presence" }>,
) {
  return message.viewers.find((participant) => participant.role === "host");
}

async function nextPreparedRoute(client: TestClient) {
  while (true) {
    const message = await client.inbox.next("route-update");
    if (message.phase === "prepare") {
      return message;
    }
  }
}

async function completePreparedPeerMigration(
  viewer: TestClient,
  newParent: TestClient,
  viewerPeerId: string,
  newParentPeerId: string,
  previousRevision: number,
  connectionId: string,
) {
  const [viewerPrepare, parentPrepare] = await Promise.all([
    nextPreparedRoute(viewer),
    nextPreparedRoute(newParent),
  ]);
  expect(viewerPrepare).toMatchObject({
    phase: "prepare",
    assignment: { upstream: { kind: "peer", peerId: newParentPeerId } },
  });
  expect(parentPrepare.revision).toBe(viewerPrepare.revision);
  await sendTestOffer(newParent, viewer, viewerPeerId, connectionId);
  viewer.socket.send(JSON.stringify({
    type: "signal",
    targetPeerId: newParentPeerId,
    payload: {
      kind: "description",
      connectionId,
      description: { type: "answer", sdp: "v=0\r\n" },
    },
  }));
  expect(await newParent.inbox.next("signal")).toMatchObject({
    fromPeerId: viewerPeerId,
  });
  viewer.socket.send(JSON.stringify({
    type: "route-ready",
    revision: viewerPrepare.revision,
    phase: "prepare",
  }));
  return nextActiveRouteAfter(viewer, previousRevision);
}

async function nextActiveRouteRevision(client: TestClient, revision: number) {
  while (true) {
    const message = await client.inbox.next("route-update");
    if (message.phase === "active" && message.revision === revision) {
      return message;
    }
  }
}

async function prepareFallbackForTwoViewers(
  webSocketUrl: string,
  room: CreatedRoom,
  prefix: string,
  shareGeneration?: string,
  options: { viewerParentSibling?: boolean } = {},
) {
  const host = await openClient(webSocketUrl);
  const hostAuth = peerAssisted(
    await authenticate(
      host,
      room,
      "host",
      `${prefix}-host-client`,
      1,
      shareGeneration,
    ),
  );
  const failedViewer = await openClient(webSocketUrl);
  const failedAuth = peerAssisted(
    await authenticate(
      failedViewer,
      room,
      "viewer",
      `${prefix}-failed-client`,
      options.viewerParentSibling ? 0 : 1,
    ),
  );
  const rootViewer = await openClient(webSocketUrl);
  const rootAuth = peerAssisted(
    await authenticate(
      rootViewer,
      room,
      "viewer",
      `${prefix}-root-client`,
      options.viewerParentSibling ? 2 : 1,
    ),
  );
  let rootSibling: TestClient | undefined;
  let rootSiblingAuth:
    | ReturnType<typeof peerAssisted>
    | undefined;
  if (options.viewerParentSibling) {
    rootSibling = await openClient(webSocketUrl);
    rootSiblingAuth = peerAssisted(
      await authenticate(
        rootSibling,
        room,
        "viewer",
        `${prefix}-root-sibling-client`,
        0,
      ),
    );
    expect(rootSiblingAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: rootAuth.peerId,
    });
  }
  const directRoute = rootSiblingAuth
    ? await nextActiveRouteRevision(
        failedViewer,
        rootSiblingAuth.routeRevision,
      )
    : await nextActiveRouteAfter(failedViewer, failedAuth.routeRevision);
  host.socket.send(
    JSON.stringify({
      type: "signal",
      targetPeerId: failedAuth.peerId,
      payload: {
        kind: "description",
        connectionId: `${prefix}-direct-connection`,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }),
  );
  await failedViewer.inbox.next("signal");
  failedViewer.socket.send(
    JSON.stringify({
      type: "route-failed",
      revision: directRoute.revision,
      phase: "active",
      connectionId: `${prefix}-direct-connection`,
    }),
  );
  const reparented = await nextActiveRouteAfter(
    failedViewer,
    directRoute.revision,
  );
  rootViewer.socket.send(
    JSON.stringify({
      type: "signal",
      targetPeerId: failedAuth.peerId,
      payload: {
        kind: "description",
        connectionId: `${prefix}-deep-connection`,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }),
  );
  await failedViewer.inbox.next("signal");
  failedViewer.socket.send(
    JSON.stringify({
      type: "route-failed",
      revision: reparented.revision,
      phase: "active",
      connectionId: `${prefix}-deep-connection`,
    }),
  );
  const hostPrepare = await nextPreparedRoute(host);
  const rootPrepare = await nextPreparedRoute(failedViewer);
  await host.inbox.next("sfu-config");
  await failedViewer.inbox.next("sfu-config");
  return {
    host,
    hostAuth,
    failedViewer,
    failedAuth,
    rootViewer,
    rootAuth,
    rootSibling,
    rootSiblingAuth,
    hostPrepare,
    rootPrepare,
  };
}

async function failSingleViewerDirect(
  webSocketUrl: string,
  room: CreatedRoom,
  prefix: string,
  hostPresence = false,
) {
  const host = await openClient(webSocketUrl);
  const hostAuth = peerAssisted(
    await authenticate(
      host,
      room,
      "host",
      `${prefix}-host`,
      1,
      `${prefix}-share`,
      hostPresence ? { viewerPresence: true } : {},
    ),
  );
  const viewer = await openClient(webSocketUrl);
  const viewerAuth = peerAssisted(
    await authenticate(viewer, room, "viewer", `${prefix}-viewer`),
  );
  const oldConnectionId = `${prefix}-direct-connection`;
  host.socket.send(JSON.stringify({
    type: "signal",
    targetPeerId: viewerAuth.peerId,
    payload: {
      kind: "description",
      connectionId: oldConnectionId,
      description: { type: "offer", sdp: "v=0\r\n" },
    },
  }));
  await viewer.inbox.next("signal");
  viewer.socket.send(JSON.stringify({
    type: "route-failed",
    revision: viewerAuth.routeRevision,
    phase: "active",
    connectionId: oldConnectionId,
  }));
  return { host, hostAuth, viewer, viewerAuth, oldConnectionId };
}

async function activateSingleViewerSfu(
  webSocketUrl: string,
  room: CreatedRoom,
  prefix: string,
  hostPresence = false,
) {
  const direct = await failSingleViewerDirect(
    webSocketUrl,
    room,
    prefix,
    hostPresence,
  );
  const { host, viewer } = direct;
  const hostPrepare = await nextPreparedRoute(host);
  const viewerPrepare = await nextPreparedRoute(viewer);
  await Promise.all([host.inbox.next("sfu-config"), viewer.inbox.next("sfu-config")]);
  for (const client of [host, viewer]) {
    client.socket.send(JSON.stringify({
      type: "route-ready",
      revision: viewerPrepare.revision,
      phase: "prepare",
    }));
  }
  await Promise.all([
    nextActiveRouteRevision(host, hostPrepare.revision),
    nextActiveRouteRevision(viewer, viewerPrepare.revision),
  ]);
  return { ...direct, revision: viewerPrepare.revision };
}

async function prepareSfuHostParentQualityProbe(
  harness: SignalHarness,
  active: Awaited<ReturnType<typeof activateSingleViewerSfu>>,
  prefix: string,
  advanceWindow: () => void,
) {
  active.viewer.socket.send(JSON.stringify({
    type: "relay-capacity",
    downstreamEdges: 0,
  }));
  const parent = await openClient(harness.webSocketUrl);
  const parentAuth = peerAssisted(await authenticate(
    parent,
    harness.room,
    "viewer",
    `${prefix}-parent`,
    1,
  ));
  expect(parentAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: active.hostAuth.peerId,
  });
  const hostFiller = await openClient(harness.webSocketUrl);
  await authenticate(
    hostFiller,
    harness.room,
    "viewer",
    `${prefix}-filler`,
    0,
  );
  const child = await openClient(harness.webSocketUrl);
  const childAuth = peerAssisted(await authenticate(
    child,
    harness.room,
    "viewer",
    `${prefix}-child`,
    0,
  ));
  expect(childAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: parentAuth.peerId,
  });
  hostFiller.socket.close();
  const current = await nextActiveRouteAfter(child, childAuth.routeRevision);
  await Promise.all([
    nextActiveRouteRevision(active.host, current.revision),
    nextActiveRouteRevision(active.viewer, current.revision),
    nextActiveRouteRevision(parent, current.revision),
  ]);

  await sendTestOffer(
    active.host,
    parent,
    parentAuth.peerId,
    `${prefix}_parent_connection`,
  );
  const childConnectionId = `${prefix}_child_connection`;
  await sendTestOffer(parent, child, childAuth.peerId, childConnectionId);
  for (let sequence = 0; sequence < 3; sequence += 1) {
    child.socket.send(JSON.stringify(viewerQualityEvidenceWithMetrics(
      childConnectionId,
      current.revision,
      sequence,
      { framesDecodedDelta: 0 },
    )));
    await correlateParentEdgeQualityEvidence(parent);
    advanceWindow();
  }
  const [childPrepare, hostPrepare] = await Promise.all([
    nextPreparedRoute(child),
    nextPreparedRoute(active.host),
  ]);
  expect(childPrepare.assignment.upstream).toEqual({
    kind: "peer",
    peerId: active.hostAuth.peerId,
  });
  expect(hostPrepare.revision).toBe(childPrepare.revision);
  return {
    child,
    childPrepare,
    current,
    hostPrepare,
    parentAuth,
  };
}

async function prepareTwoSelectedPeerEdgeCandidates(
  webSocketUrl: string,
  room: CreatedRoom,
  prefix: string,
) {
  const host = await openClient(webSocketUrl);
  const hostAuth = peerAssisted(await authenticate(
    host,
    room,
    "host",
    `${prefix}-host`,
    1,
    `${prefix}-share`,
  ));
  const firstParent = await openClient(webSocketUrl);
  const firstParentAuth = peerAssisted(await authenticate(
    firstParent,
    room,
    "viewer",
    `${prefix}-first-parent`,
    1,
  ));
  const secondParent = await openClient(webSocketUrl);
  const secondParentAuth = peerAssisted(await authenticate(
    secondParent,
    room,
    "viewer",
    `${prefix}-second-parent`,
    1,
  ));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const firstViewer = await openClient(webSocketUrl);
  const firstAuth = peerAssisted(await authenticate(
    firstViewer,
    room,
    "viewer",
    `${prefix}-first-viewer`,
    0,
  ));
  const secondViewer = await openClient(webSocketUrl);
  const secondAuth = peerAssisted(await authenticate(
    secondViewer,
    room,
    "viewer",
    `${prefix}-second-viewer`,
    0,
  ));
  expect(firstAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: firstParentAuth.peerId,
  });
  expect(secondAuth.routeAssignment.upstream).toEqual({
    kind: "peer",
    peerId: secondParentAuth.peerId,
  });
  const firstCurrent = await nextActiveRouteAfter(
    firstViewer,
    firstAuth.routeRevision,
  );
  expect(firstCurrent.revision).toBe(secondAuth.routeRevision);

  const firstConnectionId = `${prefix}-first-edge`;
  const secondConnectionId = `${prefix}-second-edge`;
  await sendTestOffer(
    firstParent,
    firstViewer,
    firstAuth.peerId,
    firstConnectionId,
  );
  await sendTestOffer(
    secondParent,
    secondViewer,
    secondAuth.peerId,
    secondConnectionId,
  );
  return {
    host,
    hostAuth,
    firstParent,
    firstParentAuth,
    firstViewer,
    firstAuth,
    firstConnectionId,
    secondParent,
    secondParentAuth,
    secondViewer,
    secondAuth,
    secondConnectionId,
    revision: firstCurrent.revision,
  };
}

function failPeerEdgeCandidate(
  viewer: TestClient,
  revision: number,
  connectionId: string,
): void {
  viewer.socket.send(JSON.stringify({
    type: "route-failed",
    revision,
    phase: "active",
    connectionId,
  }));
}

async function startPeerSelectedCandidate(
  viewer: TestClient,
  parent: TestClient,
  revision: number,
  connectionId: string,
) {
  failPeerEdgeCandidate(viewer, revision, connectionId);
  const [viewerGrant, parentGrant] = await Promise.all([
    viewer.inbox.next("selected-edge-turn"),
    parent.inbox.next("selected-edge-turn"),
  ]);
  expect(parentGrant).toEqual(viewerGrant);
  if (viewerGrant.edgeKind !== "peer-selected") {
    throw new Error("expected a peer-selected grant");
  }
  return viewerGrant;
}

async function failActiveSfuRoot(client: TestClient, revision: number) {
  client.socket.send(JSON.stringify({
    type: "refresh-sfu",
    revision,
  }));
  await client.inbox.next("sfu-config");
  client.socket.send(JSON.stringify({
    type: "route-failed",
    revision,
    phase: "active",
    connectionId: null,
  }));
}

function requestHealthyReselection(client: TestClient, revision: number): void {
  client.socket.send(JSON.stringify({
    type: "sfu-reselection-ready",
    revision,
  }));
}

async function startPeerSelectedTurn(
  viewer: TestClient,
  parent: TestClient,
  revision: number,
) {
  await failActiveSfuRoot(viewer, revision);
  const [viewerGrant, parentGrant] = await Promise.all([
    viewer.inbox.next("selected-edge-turn"),
    parent.inbox.next("selected-edge-turn"),
  ]);
  expect(parentGrant).toEqual(viewerGrant);
  if (viewerGrant.edgeKind !== "peer-selected") {
    throw new Error("expected a peer-selected grant");
  }
  return viewerGrant;
}

async function exhaustDeepViewerPeerRoutes(
  webSocketUrl: string,
  room: CreatedRoom,
  prefix: string,
) {
  const host = await openClient(webSocketUrl);
  const hostAuth = peerAssisted(
    await authenticate(host, room, "host", `${prefix}-host`),
  );
  const firstRoot = await openClient(webSocketUrl);
  const firstRootAuth = peerAssisted(
    await authenticate(firstRoot, room, "viewer", `${prefix}-root-a`),
  );
  const secondRoot = await openClient(webSocketUrl);
  const secondRootAuth = peerAssisted(
    await authenticate(secondRoot, room, "viewer", `${prefix}-root-b`),
  );
  const failedViewer = await openClient(webSocketUrl);
  const failedAuth = peerAssisted(
    await authenticate(failedViewer, room, "viewer", `${prefix}-failed`),
  );

  firstRoot.socket.send(
    JSON.stringify({
      type: "signal",
      targetPeerId: failedAuth.peerId,
      payload: {
        kind: "description",
        connectionId: `${prefix}-edge-a`,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }),
  );
  await failedViewer.inbox.next("signal");
  failedViewer.socket.send(
    JSON.stringify({
      type: "route-failed",
      revision: failedAuth.routeRevision,
      phase: "active",
      connectionId: `${prefix}-edge-a`,
    }),
  );
  const reparented = await nextActiveRouteAfter(
    failedViewer,
    failedAuth.routeRevision,
  );
  expect(reparented.assignment.upstream).toEqual({
    kind: "peer",
    peerId: secondRootAuth.peerId,
  });

  secondRoot.socket.send(
    JSON.stringify({
      type: "signal",
      targetPeerId: failedAuth.peerId,
      payload: {
        kind: "description",
        connectionId: `${prefix}-edge-b`,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }),
  );
  await failedViewer.inbox.next("signal");
  failedViewer.socket.send(
    JSON.stringify({
      type: "route-failed",
      revision: reparented.revision,
      phase: "active",
      connectionId: `${prefix}-edge-b`,
    }),
  );

  return {
    host,
    hostAuth,
    firstRoot,
    firstRootAuth,
    secondRoot,
    secondRootAuth,
    failedViewer,
    failedAuth,
  };
}

async function closeClient(client: TestClient): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
  client.socket.close();
  await closed;
}

describe("WebSocket signaling", () => {
  it("answers only opted-in current sockets and rate-limits each socket", async () => {
    let now = Date.now();
    const harness = await startHarness({ now: () => now });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "challenge-host");

    host.socket.send(
      JSON.stringify({ type: "signaling-challenge", sequence: 7 }),
    );
    expect(await host.inbox.next("signaling-challenge-response")).toEqual({
      type: "signaling-challenge-response",
      sequence: 7,
    });

    host.socket.send(
      JSON.stringify({ type: "signaling-challenge", sequence: 8 }),
    );
    await host.inbox.expectNone(40);

    now += 1_000;
    host.socket.send(
      JSON.stringify({ type: "signaling-challenge", sequence: 9 }),
    );
    expect(await host.inbox.next("signaling-challenge-response")).toEqual({
      type: "signaling-challenge-response",
      sequence: 9,
    });
  });

  it("keeps the exact Native Host wire unchanged without a presence opt-in", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "native-compatible-host");
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "native-compatible-viewer",
      1,
      undefined,
      { displayName: "移动观众" },
    );

    await host.inbox.next("peer-joined");
    await host.inbox.expectNone(40);

    host.socket.send(
      JSON.stringify({ type: "set-viewer-password", password: "unused" }),
    );
    expect(await host.inbox.next("error")).toMatchObject({
      code: "FORBIDDEN",
    });
    host.socket.send(
      JSON.stringify({ type: "set-display-name", displayName: "Native 不应改名" }),
    );
    expect(await host.inbox.next("error")).toMatchObject({
      code: "FORBIDDEN",
    });
    await host.inbox.expectNone(40);
  });

  it("lets an opted-in Web Host set and remove room password access", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "password-settings-host",
      1,
      undefined,
      { viewerPasswordSettings: true },
    );
    expect("viewerPasswordEnabled" in hostAuth).toBe(false);
    expect(await host.inbox.next("viewer-password-updated")).toEqual({
      type: "viewer-password-updated",
      enabled: false,
    });

    host.socket.send(
      JSON.stringify({
        type: "set-viewer-password",
        password: "easy-password",
      }),
    );
    expect(await host.inbox.next("viewer-password-updated")).toEqual({
      type: "viewer-password-updated",
      enabled: true,
    });

    const wrongViewer = await openClient(harness.webSocketUrl);
    wrongViewer.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        clientId: "wrong-password-viewer",
        viewerPassword: "wrong-password",
      }),
    );
    expect(await wrongViewer.inbox.next("error")).toMatchObject({
      code: "INVALID_TOKEN",
    });

    const passwordViewer = await openClient(harness.webSocketUrl);
    await expect(
      authenticate(
        passwordViewer,
        harness.room,
        "viewer",
        "password-viewer",
        1,
        undefined,
        { viewerPassword: "easy-password" },
      ),
    ).resolves.toMatchObject({ role: "viewer" });
    await host.inbox.next("peer-joined");

    host.socket.send(
      JSON.stringify({ type: "set-viewer-password", password: null }),
    );
    expect(await host.inbox.next("viewer-password-updated")).toEqual({
      type: "viewer-password-updated",
      enabled: false,
    });

    const grantViewer = await openClient(harness.webSocketUrl);
    await expect(
      authenticate(
        grantViewer,
        harness.room,
        "viewer",
        "grant-after-password-removal",
      ),
    ).resolves.toMatchObject({ role: "viewer" });
    await host.inbox.next("peer-joined");

    const removedPasswordViewer = await openClient(harness.webSocketUrl);
    removedPasswordViewer.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        clientId: "removed-password-viewer",
        viewerPassword: "easy-password",
      }),
    );
    expect(await removedPasswordViewer.inbox.next("error")).toMatchObject({
      code: "INVALID_TOKEN",
    });
  });

  it("reports every online Viewer without expanding the Host media fanout", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "presence-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);

    const viewerNames = ["阿明", "阿青", undefined] as const;
    const viewers: TestClient[] = [];
    for (const [index, displayName] of viewerNames.entries()) {
      const viewer = await openClient(harness.webSocketUrl);
      viewers.push(viewer);
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        `presence-viewer-${index}`,
        1,
        undefined,
        displayName ? { displayName } : {},
      );
    }

    const full = await nextViewerPresenceMatching(
      host,
      (message) =>
        viewerPresenceEntries(message).length === 3 &&
        viewerPresenceEntries(message).some(
          (viewer) =>
            viewer.upstream.kind === "peer" &&
            viewer.upstream.peerId !== hostAuth.peerId,
        ),
    );
    expect(viewerPresenceEntries(full).map((viewer) => viewer.displayName)).toEqual([
      "阿明",
      "阿青",
      "访客",
    ]);
    expect(
      viewerPresenceEntries(full).filter(
        (viewer) =>
          viewer.upstream.kind === "peer" &&
          viewer.upstream.peerId === hostAuth.peerId,
      ),
    ).toHaveLength(2);
    const relay = viewerPresenceEntries(full).find(
      (viewer) =>
        viewer.upstream.kind === "peer" &&
        viewer.upstream.peerId !== hostAuth.peerId,
    )!;
    const relayParentPeerId =
      relay.upstream.kind === "peer" ? relay.upstream.peerId : null;
    expect(
      viewerPresenceEntries(full).some(
        (viewer) => viewer.peerId === relayParentPeerId,
      ),
    ).toBe(true);

    viewers[2].socket.send(
      JSON.stringify({ type: "set-display-name", displayName: "后来改名" }),
    );
    const renamed = await nextViewerPresenceMatching(host, (message) =>
      viewerPresenceEntries(message).some(
        (viewer) => viewer.displayName === "后来改名",
      ),
    );
    expect(viewerPresenceEntries(renamed)).toHaveLength(3);

    await closeClient(viewers[2]);
    const afterDisconnect = await nextViewerPresenceMatching(
      host,
      (message) => viewerPresenceEntries(message).length === 2,
    );
    expect(
      viewerPresenceEntries(afterDisconnect).map((viewer) => viewer.displayName),
    ).toEqual([
      "阿明",
      "阿青",
    ]);
  });

  it("shares an opted-in Host name with Host and Viewer roster subscribers", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "named-host-client",
      1,
      undefined,
      { viewerPresence: true, displayName: "原始分享者" },
    );
    const initial = await host.inbox.next("viewer-presence");
    expect(hostPresenceEntry(initial)).toMatchObject({
      role: "host",
      peerId: hostAuth.peerId,
      displayName: "原始分享者",
      upstream: { kind: "none" },
    });

    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "named-viewer-client",
      1,
      undefined,
      { viewerPresence: true, displayName: "观看者" },
    );
    const viewerSnapshot = await nextViewerPresenceMatching(
      viewer,
      (message) => hostPresenceEntry(message)?.displayName === "原始分享者",
    );
    expect(hostPresenceEntry(viewerSnapshot)?.peerId).toBe(hostAuth.peerId);
    expect(
      viewerPresenceEntries(viewerSnapshot).some(
        (entry) => entry.peerId === viewerAuth.peerId,
      ),
    ).toBe(true);

    const hostSnapshot = await nextViewerPresenceMatching(
      host,
      (message) =>
        hostPresenceEntry(message)?.displayName === "原始分享者" &&
        viewerPresenceEntries(message).length === 1,
    );
    expect(hostPresenceEntry(hostSnapshot)?.peerId).toBe(hostAuth.peerId);

    host.socket.send(
      JSON.stringify({ type: "set-display-name", displayName: "改名后的分享者" }),
    );
    const renamedViewer = await nextViewerPresenceMatching(
      viewer,
      (message) => hostPresenceEntry(message)?.displayName === "改名后的分享者",
    );
    expect(hostPresenceEntry(renamedViewer)?.peerId).toBe(hostAuth.peerId);
    const renamedHost = await nextViewerPresenceMatching(
      host,
      (message) => hostPresenceEntry(message)?.displayName === "改名后的分享者",
    );
    expect(hostPresenceEntry(renamedHost)?.peerId).toBe(hostAuth.peerId);
  });

  it("replaces an opted-in Viewer roster after another Viewer leaves", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "viewer-roster-host");

    const subscriber = await openClient(harness.webSocketUrl);
    const subscriberAuth = await authenticate(
      subscriber,
      harness.room,
      "viewer",
      "viewer-roster-subscriber",
      1,
      undefined,
      { viewerPresence: true, displayName: "订阅者" },
    );
    await nextViewerPresenceMatching(
      subscriber,
      (message) => viewerPresenceEntries(message).length === 1,
    );

    const other = await openClient(harness.webSocketUrl);
    const otherAuth = await authenticate(
      other,
      harness.room,
      "viewer",
      "viewer-roster-other",
      1,
      undefined,
      { displayName: "另一位" },
    );
    const joined = await nextViewerPresenceMatching(
      subscriber,
      (message) => viewerPresenceEntries(message).length === 2,
    );
    expect(viewerPresenceEntries(joined).map((viewer) => viewer.peerId)).toEqual([
      subscriberAuth.peerId,
      otherAuth.peerId,
    ]);

    await closeClient(other);
    const left = await nextViewerPresenceMatching(
      subscriber,
      (message) => viewerPresenceEntries(message).length === 1,
    );
    expect(viewerPresenceEntries(left).map((viewer) => viewer.peerId)).toEqual([
      subscriberAuth.peerId,
    ]);
  });

  it("clears a disconnected Host name and publishes the replacement name", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 40 });
    const firstHost = await openClient(harness.webSocketUrl);
    const firstAuth = await authenticate(
      firstHost,
      harness.room,
      "host",
      "replaceable-host-client",
      1,
      undefined,
      { viewerPresence: true, displayName: "旧分享者" },
    );
    await firstHost.inbox.next("viewer-presence");

    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "replacement-roster-viewer",
      1,
      undefined,
      { viewerPresence: true },
    );
    await nextViewerPresenceMatching(
      viewer,
      (message) => hostPresenceEntry(message)?.displayName === "旧分享者",
    );

    await closeClient(firstHost);
    await viewer.inbox.next("host-status");
    const offline = await nextViewerPresenceMatching(
      viewer,
      (message) => hostPresenceEntry(message) === undefined,
    );
    expect(offline.viewers.some((entry) => entry.role === "host")).toBe(false);
    expect(viewerPresenceEntries(offline)).toMatchObject([
      { peerId: viewerAuth.peerId, upstream: { kind: "none" } },
    ]);

    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = await authenticate(
      replacement,
      harness.room,
      "host",
      "replaceable-host-client",
      1,
      undefined,
      { viewerPresence: true, displayName: "新分享者" },
    );
    expect(replacementAuth.peerId).toBe(firstAuth.peerId);
    const online = await nextViewerPresenceMatching(
      viewer,
      (message) => hostPresenceEntry(message)?.displayName === "新分享者",
    );
    expect(hostPresenceEntry(online)?.peerId).toBe(firstAuth.peerId);
    await closeClient(replacement);
    await closeClient(viewer);
  });

  it("publishes one empty Viewer roster after ordinary rotate and revoke", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "ordinary-access-presence-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);

    const firstViewer = await openClient(harness.webSocketUrl);
    const firstViewerAuth = await authenticate(
      firstViewer,
      harness.room,
      "viewer",
      "ordinary-access-presence-viewer-1",
      1,
      undefined,
      { displayName: "第一位" },
    );
    expect((await host.inbox.next("peer-joined")).peerId).toBe(
      firstViewerAuth.peerId,
    );
    expect(viewerPresenceEntries(await host.inbox.next("viewer-presence"))).toEqual([
      {
        role: "viewer",
        peerId: firstViewerAuth.peerId,
        displayName: "第一位",
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      },
    ]);

    const firstClosed = new Promise<number>((resolve) =>
      firstViewer.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(
      JSON.stringify({ type: "set-viewer-access", action: "rotate" }),
    );
    expect(await firstViewer.inbox.next("viewer-access-revoked")).toMatchObject({
      viewerAuthorizationGeneration:
        firstViewerAuth.viewerAuthorizationGeneration,
    });
    expect(await firstClosed).toBe(4004);
    expect((await host.inbox.next("peer-left")).peerId).toBe(
      firstViewerAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);
    const rotated = await host.inbox.next("viewer-access-updated");
    await host.inbox.expectNone(30);

    const rotatedGrant = new URLSearchParams(
      new URL(rotated.inviteUrl!).hash.slice(1),
    ).get("v");
    expect(rotatedGrant).toBeTruthy();
    const rotatedRoom = {
      ...harness.room,
      viewerGrant: rotatedGrant,
    } satisfies CreatedRoom;
    const secondViewer = await openClient(harness.webSocketUrl);
    const secondViewerAuth = await authenticate(
      secondViewer,
      rotatedRoom,
      "viewer",
      "ordinary-access-presence-viewer-2",
      1,
      undefined,
      { displayName: "第二位" },
    );
    expect((await host.inbox.next("peer-joined")).peerId).toBe(
      secondViewerAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toHaveLength(1);

    const secondClosed = new Promise<number>((resolve) =>
      secondViewer.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(
      JSON.stringify({ type: "set-viewer-access", action: "revoke" }),
    );
    await secondViewer.inbox.next("viewer-access-revoked");
    expect(await secondClosed).toBe(4004);
    expect((await host.inbox.next("peer-left")).peerId).toBe(
      secondViewerAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);
    expect(await host.inbox.next("viewer-access-updated")).toMatchObject({
      viewerPolicy: "private-link",
      inviteUrl: null,
    });
    await host.inbox.expectNone(30);
  });

  it("requires site access for code-only Viewers while accepting room grants", async () => {
    const siteAccessPassword = "protected-instance-password";
    const harness = await startHarness({ siteAccessPassword });

    const viewer = await openClient(harness.webSocketUrl);
    await expect(
      authenticate(viewer, harness.room, "viewer", "viewer-client-protected"),
    ).resolves.toMatchObject({ role: "viewer" });

    const unauthorizedHost = await openClient(harness.webSocketUrl);
    unauthorizedHost.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "host",
        token: harness.room.hostToken,
        clientId: "host-client-without-admission",
      }),
    );
    await expect(unauthorizedHost.inbox.next("error")).resolves.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    const login = await fetch(`${harness.baseUrl}/api/site-access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${siteAccessPassword}`,
        Origin: allowedOrigin,
      },
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const viewerWithHostCookie = await openClient(harness.webSocketUrl, cookie);
    viewerWithHostCookie.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        clientId: "viewer-with-host-cookie",
      }),
    );
    await expect(viewerWithHostCookie.inbox.next("error")).resolves.toMatchObject({
      code: "INVALID_TOKEN",
    });

    const publicRoom = harness.roomStore.createRoom("public-watch");
    const publicWithoutSiteAccess = await openClient(harness.webSocketUrl);
    publicWithoutSiteAccess.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: publicRoom.roomId,
        role: "viewer",
        clientId: "public-viewer-without-site-access",
      }),
    );
    await expect(
      publicWithoutSiteAccess.inbox.next("error"),
    ).resolves.toMatchObject({ code: "INVALID_TOKEN" });

    const publicWithForgedGrant = await openClient(harness.webSocketUrl);
    publicWithForgedGrant.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: publicRoom.roomId,
        role: "viewer",
        clientId: "public-viewer-with-forged-grant",
        viewerGrant: `g1.${publicRoom.roomId}.1893456000.${"x".repeat(43)}`,
      }),
    );
    await expect(
      publicWithForgedGrant.inbox.next("error"),
    ).resolves.toMatchObject({ code: "INVALID_TOKEN" });

    const publicWithSiteAccess = await openClient(harness.webSocketUrl, cookie);
    await expect(
      authenticate(
        publicWithSiteAccess,
        publicRoom,
        "viewer",
        "public-viewer-with-site-access",
      ),
    ).resolves.toMatchObject({ role: "viewer" });

    const passwordRoom = harness.roomStore.createRoom("private-link");
    harness.roomStore.connectParticipant({
      roomId: passwordRoom.roomId,
      role: "host",
      token: passwordRoom.hostToken,
      clientId: "password-room-setup",
      sessionId: "password-room-setup-session",
    });
    await harness.roomStore.setViewerPassword(
      passwordRoom.roomId,
      "room-password",
      "password-room-setup-session",
    );

    const passwordWithoutSiteAccess = await openClient(harness.webSocketUrl);
    passwordWithoutSiteAccess.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: passwordRoom.roomId,
        role: "viewer",
        clientId: "password-viewer-without-site-access",
        viewerPassword: "room-password",
      }),
    );
    await expect(
      passwordWithoutSiteAccess.inbox.next("error"),
    ).resolves.toMatchObject({ code: "INVALID_TOKEN" });

    const passwordWithSiteAccess = await openClient(harness.webSocketUrl, cookie);
    await expect(
      authenticate(
        passwordWithSiteAccess,
        passwordRoom,
        "viewer",
        "password-viewer-with-site-access",
        1,
        undefined,
        { viewerPassword: "room-password" },
      ),
    ).resolves.toMatchObject({ role: "viewer" });

    const host = await openClient(harness.webSocketUrl, cookie);
    await expect(
      authenticate(host, harness.room, "host", "host-client-protected"),
    ).resolves.toMatchObject({ role: "host" });
  });

  it("rearms an in-memory provisional room lease only after Host disconnect", async () => {
    let now = Date.UTC(2026, 7, 20, 12);
    const harness = await startHarness({
      persistent: true,
      provisionalHostClaimSeconds: 300,
      now: () => now,
    });
    expect(harness.database!.loadRooms()).toEqual([]);
    const host = await openClient(harness.webSocketUrl);
    const authenticated = await authenticate(
      host,
      harness.room,
      "host",
      "provisional-host",
    );
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(viewer, harness.room, "viewer", "provisional-viewer");
    await host.inbox.next("peer-joined");

    now += 301_000;
    expect(harness.roomStore.expireRooms()).toEqual([]);
    await closeClient(host);
    await viewer.inbox.next("host-status");
    expect(harness.roomStore.getConnectedHost(harness.room.roomId)).toBeUndefined();
    expect(harness.roomStore.expireRooms(now + 299_999)).toEqual([]);
    const expired = harness.roomStore.expireRooms(now + 300_001);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ roomId: harness.room.roomId });
    expect(expired[0]?.sessionIds).toHaveLength(1);
    await closeClient(viewer);
    expect(authenticated.role).toBe("host");
    expect(harness.database!.loadRooms()).toEqual([]);
  });

  it("leaves established authorization and media untouched when access persistence fails", async () => {
    const harness = await startHarness({ persistent: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "persistence-failure-host",
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "persistence-failure-viewer",
    );
    await host.inbox.next("peer-joined");
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "persistence-failure-edge",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    const update = vi
      .spyOn(harness.roomStore, "setViewerAccess")
      .mockImplementationOnce(() => {
        throw new Error("simulated database write failure");
      });
    host.socket.send(
      JSON.stringify({ type: "set-viewer-access", action: "rotate" }),
    );
    expect(await host.inbox.next("error")).toMatchObject({ code: "SERVER_ERROR" });
    await expect(
      viewer.inbox.next("viewer-access-revoked", 30),
    ).rejects.toThrow("Timed out");

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "persistence-failure-edge",
          candidate: null,
        },
      }),
    );
    expect(await viewer.inbox.next("signal")).toMatchObject({
      fromPeerId: hostAuth.peerId,
      payload: { connectionId: "persistence-failure-edge" },
    });
    update.mockRestore();

    const secondViewer = await openClient(harness.webSocketUrl);
    expect(
      await authenticate(
        secondViewer,
        harness.room,
        "viewer",
        "persistence-failure-new-viewer",
      ),
    ).toMatchObject({
      viewerAuthorizationGeneration:
        viewerAuth.viewerAuthorizationGeneration,
    });
  });

  it("strongly rotates and revokes every Viewer generation and media edge", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
    });
    const peers = await exhaustDeepViewerPeerRoutes(
      harness.webSocketUrl,
      harness.room,
      "access-generation",
    );
    const hostPrepare = await nextPreparedRoute(peers.host);
    const branchPrepare = await nextPreparedRoute(peers.secondRoot);
    const failedPrepare = await nextPreparedRoute(peers.failedViewer);
    await peers.host.inbox.next("sfu-config");
    await peers.secondRoot.inbox.next("sfu-config");
    await peers.failedViewer.inbox.next("sfu-config");
    for (const [client, revision] of [
      [peers.host, hostPrepare.revision],
      [peers.secondRoot, branchPrepare.revision],
      [peers.failedViewer, failedPrepare.revision],
    ] as const) {
      client.socket.send(
        JSON.stringify({ type: "route-ready", revision, phase: "prepare" }),
      );
    }
    const hostActive = await nextActiveRouteAfter(
      peers.host,
      hostPrepare.revision - 1,
    );
    expect(hostActive.assignment.sfuPublicationGeneration).toBeTruthy();

    const revokedViewers = [
      peers.firstRoot,
      peers.secondRoot,
      peers.failedViewer,
    ];
    const closeCodes = revokedViewers.map(
      (viewer) =>
        new Promise<number>((resolve) =>
          viewer.socket.once("close", (code) => resolve(code)),
        ),
    );
    for (const viewer of revokedViewers) {
      viewer.socket.on("message", (data) => {
        if (
          decodeServerMessage(data.toString()).type === "viewer-access-revoked" &&
          viewer.socket.readyState === WebSocket.OPEN
        ) {
          viewer.socket.send(
            JSON.stringify({
              type: "signal",
              targetPeerId: peers.hostAuth.peerId,
              payload: {
                kind: "candidate",
                connectionId: "stale-revoked-generation",
                candidate: null,
              },
            }),
          );
        }
      });
    }

    peers.host.socket.send(
      JSON.stringify({ type: "set-viewer-access", action: "rotate" }),
    );
    for (const viewer of revokedViewers) {
      expect(await viewer.inbox.next("viewer-access-revoked")).toEqual({
        type: "viewer-access-revoked",
        viewerAuthorizationGeneration:
          peers.firstRootAuth.viewerAuthorizationGeneration,
      });
    }
    expect(await Promise.all(closeCodes)).toEqual([4004, 4004, 4004]);
    expect(harness.roomStore.getConnectedViewers(harness.room.roomId)).toEqual(
      [],
    );

    let finalHostRoute = hostActive;
    for (let change = 0; change < 6; change += 1) {
      if (
        finalHostRoute.assignment.childPeerIds.length === 0 &&
        finalHostRoute.assignment.sfuPublicationGeneration === null
      ) {
        break;
      }
      finalHostRoute = await nextActiveRouteAfter(
        peers.host,
        finalHostRoute.revision,
      );
    }
    expect(finalHostRoute.assignment).toMatchObject({
      childPeerIds: [],
      sfuPublicationGeneration: null,
    });
    await expect(peers.host.inbox.next("signal", 30)).rejects.toThrow(
      "Timed out",
    );

    const rotated = await peers.host.inbox.next("viewer-access-updated");
    expect(rotated.viewerPolicy).toBe("private-link");
    expect(rotated.viewerAuthorizationGeneration).not.toBe(
      peers.firstRootAuth.viewerAuthorizationGeneration,
    );
    const inviteUrl = new URL(rotated.inviteUrl!);
    const rotatedGrant = new URLSearchParams(inviteUrl.hash.slice(1)).get("v");
    expect(rotatedGrant).toBeTruthy();

    const oldGrantViewer = await openClient(harness.webSocketUrl);
    oldGrantViewer.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        viewerGrant: harness.room.viewerGrant,
        clientId: "old-generation-viewer",
      }),
    );
    expect(await oldGrantViewer.inbox.next("error")).toMatchObject({
      code: "INVALID_TOKEN",
    });

    const rotatedRoom = {
      ...harness.room,
      viewerGrant: rotatedGrant,
    } satisfies CreatedRoom;
    const currentViewer = await openClient(harness.webSocketUrl);
    const currentAuth = await authenticate(
      currentViewer,
      rotatedRoom,
      "viewer",
      "current-generation-viewer",
    );
    expect(currentAuth.viewerAuthorizationGeneration).toBe(
      rotated.viewerAuthorizationGeneration,
    );

    const currentClosed = new Promise<number>((resolve) =>
      currentViewer.socket.once("close", (code) => resolve(code)),
    );
    peers.host.socket.send(
      JSON.stringify({ type: "set-viewer-access", action: "revoke" }),
    );
    expect(await currentViewer.inbox.next("viewer-access-revoked")).toMatchObject({
      viewerAuthorizationGeneration: rotated.viewerAuthorizationGeneration,
    });
    expect(await currentClosed).toBe(4004);
    expect(await peers.host.inbox.next("viewer-access-updated")).toMatchObject({
      viewerPolicy: "private-link",
      inviteUrl: null,
    });
  });

  it("lets viewers arrive first and replays their snapshot when the host joins", async () => {
    const harness = await startHarness();
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "viewer-client-early",
    );
    expect(viewerAuth.hostOnline).toBe(false);
    expect("mediaMode" in viewerAuth).toBe(false);
    expect("routeRevision" in viewerAuth).toBe(false);

    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    expect((await host.inbox.next("peer-joined")).peerId).toBe(viewerAuth.peerId);
    expect(await viewer.inbox.next("host-status")).toEqual({
      type: "host-status",
      online: true,
      paused: false,
    });
  });

  it("snapshots intentional pause across Viewer replacement and clears it on resume and stop", async () => {
    const harness = await startHarness();
    const shareGeneration = "pause_share_generation_12345678";
    const host = await openClient(harness.webSocketUrl);
    let activeHost = host;
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "pause-host-client",
      1,
      shareGeneration,
    );
    expect(hostAuth).not.toHaveProperty("hostPaused");
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "pause-viewer-client",
    );
    expect(viewerAuth.hostPaused).toBe(false);
    await host.inbox.next("peer-joined");

    host.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: true,
      }),
    );
    expect(await viewer.inbox.next("host-status")).toEqual({
      type: "host-status",
      online: true,
      paused: true,
    });

    await closeClient(host);
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: false,
      paused: false,
    });
    activeHost = await openClient(harness.webSocketUrl);
    await authenticate(
      activeHost,
      harness.room,
      "host",
      "pause-host-client",
      1,
      shareGeneration,
      { sharingPaused: true },
    );
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: true,
    });

    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = await authenticate(
      replacement,
      harness.room,
      "viewer",
      "pause-viewer-client",
    );
    expect(replacementAuth.hostPaused).toBe(true);

    activeHost.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: false,
      }),
    );
    expect(await replacement.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: false,
    });

    activeHost.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: true,
      }),
    );
    expect(await replacement.inbox.next("host-status")).toMatchObject({
      paused: true,
    });
    activeHost.socket.send(
      JSON.stringify({ type: "stop-sharing", shareGeneration }),
    );
    await replacement.inbox.next("sharing-stopped");
    expect(await replacement.inbox.next("host-status")).toMatchObject({
      online: false,
      paused: false,
    });

    const nextHost = await openClient(harness.webSocketUrl);
    await authenticate(
      nextHost,
      harness.room,
      "host",
      "pause-host-client",
      1,
      "next_pause_share_generation_12345678",
    );
    await replacement.inbox.next("sharing-stopped");
    expect(await replacement.inbox.next("host-status")).toMatchObject({
      online: false,
      paused: false,
    });
    expect(await replacement.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: false,
    });
  });

  it("advances a provisional peer route when the host arrives after viewers", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "early-relay-viewer",
      ),
    );
    expect(viewerAuth).toMatchObject({
      routeRevision: 0,
      routeAssignment: { upstream: { kind: "none" } },
    });

    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "early-relay-host"),
    );
    expect(hostAuth.routeRevision).toBeGreaterThan(viewerAuth.routeRevision);
    expect(await nextActiveRouteAfter(viewer, viewerAuth.routeRevision)).toMatchObject({
      revision: hostAuth.routeRevision,
      assignment: {
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      },
    });
  });

  it("authenticates a persistent room without a room expiry", async () => {
    const harness = await startHarness({ persistent: true });
    expect(harness.room).toMatchObject({ roomId: "1", expiresAt: null });

    const viewer = await openClient(harness.webSocketUrl);
    const authenticated = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "viewer-persistent-room",
    );
    expect(authenticated.roomExpiresAt).toBeNull();
    expect(authenticated.hostOnline).toBe(false);
  });

  it("synchronizes strict last-wins quality settings across a peer-assisted room", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-host"),
    );
    expect(hostAuth.qualitySettings).toEqual(defaultQualitySettings);

    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(viewer, harness.room, "viewer", "quality-viewer"),
    );
    expect(viewerAuth.qualitySettings).toEqual(defaultQualitySettings);
    await host.inbox.next("media-assignment");

    host.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: balancedQualitySettings,
      }),
    );
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: balancedQualitySettings,
    });
    host.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: lowQualitySettings,
      }),
    );
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: lowQualitySettings,
    });

    const lateViewer = await openClient(harness.webSocketUrl);
    const lateViewerAuth = peerAssisted(
      await authenticate(
        lateViewer,
        harness.room,
        "viewer",
        "quality-viewer-late",
      ),
    );
    expect(lateViewerAuth.qualitySettings).toEqual(lowQualitySettings);
    await host.inbox.next("media-assignment");

    viewer.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: defaultQualitySettings,
      }),
    );
    expect((await viewer.inbox.next("error")).code).toBe("FORBIDDEN");
    await lateViewer.inbox.expectNone(30);
  });

  it("uses only explicitly advertised viewer relay slots without moving healthy edges", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "capacity-host"),
    );
    const first = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        first,
        harness.room,
        "viewer",
        "capacity-first",
        null,
      ),
    );
    const second = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        second,
        harness.room,
        "viewer",
        "capacity-second",
        null,
      ),
    );
    const pending = await openClient(harness.webSocketUrl);
    const pendingAuth = peerAssisted(
      await authenticate(
        pending,
        harness.room,
        "viewer",
        "capacity-pending",
        null,
      ),
    );

    expect(firstAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect("sfuStandbyUrl" in firstAuth).toBe(false);
    expect(secondAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(pendingAuth.routeAssignment.upstream).toEqual({ kind: "none" });

    first.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 1 }),
    );
    const pendingRoute = await nextActiveRouteAfter(
      pending,
      pendingAuth.routeRevision,
    );
    expect(pendingRoute.assignment.upstream).toEqual({
      kind: "peer",
      peerId: firstAuth.peerId,
    });
    const secondRoute = await nextActiveRouteAfter(
      second,
      secondAuth.routeRevision,
    );
    expect(secondRoute.assignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });

    host.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 1 }),
    );
    expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");
  });

  it("applies capacity three to Viewer authentication and reconciliation", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      endpointMediaCopyCapacity: 3,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "release-cap-host"),
    );
    const relay = await openClient(harness.webSocketUrl);
    const relayAuth = peerAssisted(
      await authenticate(
        relay,
        harness.room,
        "viewer",
        "release-cap-relay",
        3,
      ),
    );
    const sibling = await openClient(harness.webSocketUrl);
    const siblingAuth = peerAssisted(
      await authenticate(
        sibling,
        harness.room,
        "viewer",
        "release-cap-sibling",
        2,
      ),
    );
    const child = await openClient(harness.webSocketUrl);
    const childAuth = peerAssisted(
      await authenticate(
        child,
        harness.room,
        "viewer",
        "release-cap-child",
        0,
      ),
    );
    const siblingChild = await openClient(harness.webSocketUrl);
    const siblingChildAuth = peerAssisted(
      await authenticate(
        siblingChild,
        harness.room,
        "viewer",
        "release-cap-sibling-child",
        0,
      ),
    );
    const pending = await openClient(harness.webSocketUrl);
    const pendingAuth = peerAssisted(
      await authenticate(
        pending,
        harness.room,
        "viewer",
        "release-cap-pending",
        0,
      ),
    );

    expect(relayAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(siblingAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(childAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(siblingChildAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: relayAuth.peerId,
    });
    expect(pendingAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: relayAuth.peerId,
    });

    const replacementRelay = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(
      await authenticate(
        replacementRelay,
        harness.room,
        "viewer",
        "release-cap-relay",
        null,
      ),
    );
    expect(replacementAuth.peerId).toBe(relayAuth.peerId);
    expect(replacementAuth.routeAssignment).toMatchObject({
      upstream: { kind: "peer", peerId: hostAuth.peerId },
      childPeerIds: [siblingChildAuth.peerId, pendingAuth.peerId],
    });

    replacementRelay.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 3 }),
    );
    await pending.inbox.expectNone(40);
    await replacementRelay.inbox.expectNone(40);
  });

  it("rescues an unassigned relay in one bounded route generation", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "rescue-host"),
    );
    const first = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        first,
        harness.room,
        "viewer",
        "rescue-first",
        null,
      ),
    );
    const second = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        second,
        harness.room,
        "viewer",
        "rescue-second",
        null,
      ),
    );
    const relay = await openClient(harness.webSocketUrl);
    const relayAuth = peerAssisted(
      await authenticate(
        relay,
        harness.room,
        "viewer",
        "rescue-relay",
        null,
      ),
    );
    expect(relayAuth.routeAssignment.upstream).toEqual({ kind: "none" });

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "admission-rescue-old-generation",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await first.inbox.next("signal");

    relay.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 1 }),
    );
    const [hostRoute, firstRoute, secondRoute, relayRoute] = await Promise.all([
      nextActiveRouteAfter(host, relayAuth.routeRevision),
      nextActiveRouteAfter(first, relayAuth.routeRevision),
      nextActiveRouteAfter(second, relayAuth.routeRevision),
      nextActiveRouteAfter(relay, relayAuth.routeRevision),
    ]);

    expect(
      new Set([
        hostRoute.revision,
        firstRoute.revision,
        secondRoute.revision,
        relayRoute.revision,
      ]),
    ).toEqual(new Set([relayAuth.routeRevision + 1]));
    expect(hostRoute.assignment).toMatchObject({
      upstream: { kind: "none" },
      childPeerIds: [secondAuth.peerId, relayAuth.peerId],
      sfuPublicationGeneration: null,
    });
    expect(firstRoute.assignment).toMatchObject({
      upstream: { kind: "peer", peerId: relayAuth.peerId },
      childPeerIds: [],
    });
    expect(secondRoute.assignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(relayRoute.assignment).toMatchObject({
      upstream: { kind: "peer", peerId: hostAuth.peerId },
      childPeerIds: [firstAuth.peerId],
    });
    expect(hostRoute.assignment.childPeerIds).toHaveLength(2);
    expect(relayRoute.assignment.childPeerIds).toHaveLength(1);

    first.inbox.ignore("route-update");
    first.inbox.ignore("media-assignment");
    first.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: firstRoute.revision,
        phase: "active",
        connectionId: "admission-rescue-old-generation",
      }),
    );
    await first.inbox.expectNone(30);
  });

  it("keeps the P2P authenticated wire unchanged and forbids profile updates", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "p2p-quality-host",
    );
    expect("mediaMode" in hostAuth).toBe(false);
    expect("qualitySettings" in hostAuth).toBe(false);
    expect("sfuStandbyUrl" in hostAuth).toBe(false);

    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "p2p-quality-viewer",
    );
    expect("mediaMode" in viewerAuth).toBe(false);
    expect("qualitySettings" in viewerAuth).toBe(false);
    expect("sfuStandbyUrl" in viewerAuth).toBe(false);
    await host.inbox.next("peer-joined");

    host.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: balancedQualitySettings,
      }),
    );
    expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");
    viewer.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: lowQualitySettings,
      }),
    );
    expect((await viewer.inbox.next("error")).code).toBe("FORBIDDEN");
    viewer.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 1 }),
    );
    expect((await viewer.inbox.next("error")).code).toBe("FORBIDDEN");
    await viewer.inbox.expectNone(30);
  });

  it("enables hybrid routing for every room while ordinary ICE stays STUN-only", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { issueToken: async () => "unused-test-token" },
      stunUrls: ["stun:stun.example.test:3478"],
    });
    const ordinaryRoom = harness.roomStore.createRoom();

    const hybridHost = await openClient(harness.webSocketUrl);
    const hybridHostAuth = peerAssisted(
      await authenticate(
        hybridHost,
        harness.room,
        "host",
        "allowlisted-host",
      ),
    );
    expect(hybridHostAuth.sfuStandbyUrl).toBe("wss://sfu.example.test");
    expect(hybridHostAuth.iceConfig).toEqual({
      iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
    });

    const ordinaryHost = await openClient(harness.webSocketUrl);
    const ordinaryHostAuth = peerAssisted(
      await authenticate(
        ordinaryHost,
        ordinaryRoom,
        "host",
        "ordinary-host",
      ),
    );
    expect(ordinaryHostAuth.mediaMode).toBe("peer-assisted");
    expect(ordinaryHostAuth.sfuStandbyUrl).toBe("wss://sfu.example.test");
    expect(ordinaryHostAuth.iceConfig).toEqual(hybridHostAuth.iceConfig);
    expect(
      ordinaryHostAuth.iceConfig.iceServers.every(
        (server) => !("username" in server) && !("credential" in server),
      ),
    ).toBe(true);

    const ordinaryViewer = await openClient(harness.webSocketUrl);
    const ordinaryViewerAuth = peerAssisted(
      await authenticate(
        ordinaryViewer,
        ordinaryRoom,
        "viewer",
        "ordinary-viewer",
      ),
    );
    expect(ordinaryViewerAuth.mediaMode).toBe("peer-assisted");
    expect(ordinaryViewerAuth.sfuStandbyUrl).toBe("wss://sfu.example.test");
    expect(ordinaryViewerAuth.iceConfig).toEqual(hybridHostAuth.iceConfig);

    await closeClient(hybridHost);
    await closeClient(ordinaryHost);
    await closeClient(ordinaryViewer);
  });

  it("keeps all-room hybrid lifecycles independent", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      viewerDisconnectGraceMs: 500,
    });
    const ordinaryRoom = harness.roomStore.createRoom();

    const hybridHost = await openClient(harness.webSocketUrl);
    const hybridHostAuth = peerAssisted(
      await authenticate(hybridHost, harness.room, "host", "lifecycle-hybrid-host"),
    );
    const hybridViewer = await openClient(harness.webSocketUrl);
    const hybridViewerAuth = peerAssisted(
      await authenticate(
        hybridViewer,
        harness.room,
        "viewer",
        "lifecycle-hybrid-viewer",
      ),
    );
    await hybridHost.inbox.next("media-assignment");
    hybridHost.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: lowQualitySettings,
      }),
    );
    await hybridViewer.inbox.next("quality-settings");

    const ordinaryHost = await openClient(harness.webSocketUrl);
    await authenticate(
      ordinaryHost,
      ordinaryRoom,
      "host",
      "lifecycle-ordinary-host",
    );
    const ordinaryViewer = await openClient(harness.webSocketUrl);
    const ordinaryViewerAuth = peerAssisted(
      await authenticate(
        ordinaryViewer,
        ordinaryRoom,
        "viewer",
        "lifecycle-ordinary-viewer",
      ),
    );
    await ordinaryHost.inbox.next("media-assignment");

    const hybridHostClosed = new Promise<number>((resolve) =>
      hybridHost.socket.once("close", (code) => resolve(code)),
    );
    const ordinaryHostClosed = new Promise<number>((resolve) =>
      ordinaryHost.socket.once("close", (code) => resolve(code)),
    );
    hybridHost.socket.send(JSON.stringify({ type: "stop-sharing" }));
    ordinaryHost.socket.send(JSON.stringify({ type: "stop-sharing" }));
    await hybridViewer.inbox.next("sharing-stopped");
    await hybridViewer.inbox.next("host-status");
    await ordinaryViewer.inbox.next("sharing-stopped");
    await ordinaryViewer.inbox.next("host-status");
    expect(await hybridHostClosed).toBe(1000);
    expect(await ordinaryHostClosed).toBe(1000);

    await closeClient(hybridViewer);
    await closeClient(ordinaryViewer);
    const resumedHybridViewer = await openClient(harness.webSocketUrl);
    const resumedHybridViewerAuth = peerAssisted(
      await authenticate(
        resumedHybridViewer,
        harness.room,
        "viewer",
        "lifecycle-hybrid-viewer",
      ),
    );
    expect(resumedHybridViewerAuth).toMatchObject({
      peerId: hybridViewerAuth.peerId,
      connectionId: null,
      qualitySettings: lowQualitySettings,
    });
    const resumedOrdinaryViewer = await openClient(harness.webSocketUrl);
    const resumedOrdinaryViewerAuth = peerAssisted(
      await authenticate(
        resumedOrdinaryViewer,
        ordinaryRoom,
        "viewer",
        "lifecycle-ordinary-viewer",
      ),
    );
    expect(resumedOrdinaryViewerAuth.peerId).toBe(ordinaryViewerAuth.peerId);
    expect(resumedOrdinaryViewerAuth.connectionId).toBeNull();
    expect(resumedOrdinaryViewerAuth.mediaMode).toBe("peer-assisted");
    expect(resumedOrdinaryViewerAuth.qualitySettings).toEqual(
      defaultQualitySettings,
    );

    const resumedHybridHost = await openClient(harness.webSocketUrl);
    const resumedHybridHostAuth = peerAssisted(
      await authenticate(
        resumedHybridHost,
        harness.room,
        "host",
        "lifecycle-hybrid-host",
      ),
    );
    expect(resumedHybridHostAuth).toMatchObject({
      peerId: hybridHostAuth.peerId,
      qualitySettings: lowQualitySettings,
    });
    const resumedOrdinaryHost = await openClient(harness.webSocketUrl);
    await authenticate(
      resumedOrdinaryHost,
      ordinaryRoom,
      "host",
      "lifecycle-ordinary-host",
    );
    resumedHybridHost.socket.send(JSON.stringify({ type: "abandon-room" }));
    await resumedHybridHost.inbox.next("room-closed");
    await resumedHybridViewer.inbox.next("room-closed");
    expect(harness.roomStore.size).toBe(1);

    resumedOrdinaryHost.socket.send(JSON.stringify({ type: "abandon-room" }));
    await resumedOrdinaryHost.inbox.next("room-closed");
    await resumedOrdinaryViewer.inbox.next("room-closed");
    expect(harness.roomStore.size).toBe(0);
  });

  it("forwards only current, bounded ordinary-P2P viewer C evidence", async () => {
    let now = Date.now();
    const harness = await startHarness({ now: () => now });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "quality-host-client",
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "quality-viewer-client",
    );
    await host.inbox.next("peer-joined");

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_connection_first",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    viewer.socket.send(
      JSON.stringify(viewerQualityEvidence("quality_connection_first", 0, 0)),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toEqual({
      ...viewerQualityEvidence("quality_connection_first", 0, 0),
      viewerPeerId: viewerAuth.peerId,
      parentPeerId: hostAuth.peerId,
    });

    viewer.socket.send(
      JSON.stringify(viewerQualityEvidence("quality_connection_first", 0, 1)),
    );
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_first", 0, 1, 7_000),
      ),
    );
    await host.inbox.expectNone(30);

    now += 2_000;
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_first", 0, 1, 7_000),
      ),
    );
    expect(
      (await host.inbox.next("viewer-quality-evidence")).metrics.bitrateKbps,
    ).toBe(7_000);

    now += 2_000;
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_first", 0, 2, 7_000),
      ),
    );
    expect(
      (await host.inbox.next("viewer-quality-evidence")).metrics.bitrateKbps,
    ).toBe(7_000);

    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_stale", 0, 3, 6_500),
      ),
    );
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_first", 1, 3, 6_500),
      ),
    );
    await host.inbox.expectNone(30);

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_connection_second",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_first", 0, 3, 6_000),
      ),
    );
    await host.inbox.expectNone(30);
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_second", 0, 0, 6_000),
      ),
    );
    expect(
      (await host.inbox.next("viewer-quality-evidence")).guard.connectionId,
    ).toBe("quality_connection_second");

    host.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_second", 0, 1, 5_500),
      ),
    );
    await host.inbox.expectNone(30);

    const replacementViewer = await openClient(harness.webSocketUrl);
    const replacementAuth = await authenticate(
      replacementViewer,
      harness.room,
      "viewer",
      "quality-viewer-client",
    );
    expect(replacementAuth).toMatchObject({
      peerId: viewerAuth.peerId,
      connectionId: "quality_connection_second",
    });
    expect(await host.inbox.next("peer-joined")).toMatchObject({
      peerId: viewerAuth.peerId,
    });
    replacementViewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence("quality_connection_second", 0, 0, 5_000),
      ),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject({
      viewerPeerId: viewerAuth.peerId,
      guard: { connectionId: "quality_connection_second" },
      sequence: 0,
      metrics: { bitrateKbps: 5_000 },
    });
  });

  it("forwards peer-assisted C to the active parent and opted-in Host", async () => {
    let now = 50_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(
        host,
        harness.room,
        "host",
        "peer-quality-host",
        1,
        undefined,
        { viewerPresence: true },
      ),
    );
    host.inbox.ignore("route-update");
    host.inbox.ignore("media-assignment");
    host.inbox.ignore("viewer-presence");
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "peer-quality-viewer",
      ),
    );
    expect(viewerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "peer_quality_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "peer_quality_connection",
          viewerAuth.routeRevision,
          0,
        ),
      ),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject({
      viewerPeerId: viewerAuth.peerId,
      parentPeerId: hostAuth.peerId,
      guard: {
        connectionId: "peer_quality_connection",
        routeRevision: viewerAuth.routeRevision,
      },
    });

    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "peer_quality_connection",
          viewerAuth.routeRevision + 1,
          1,
          7_000,
        ),
      ),
    );
    await host.inbox.expectNone(30);

    viewer.inbox.ignore("route-update");
    viewer.inbox.ignore("media-assignment");
    const secondViewer = await openClient(harness.webSocketUrl);
    await authenticate(
      secondViewer,
      harness.room,
      "viewer",
      "peer-quality-viewer-two",
    );
    const relayChild = await openClient(harness.webSocketUrl);
    const relayChildAuth = peerAssisted(
      await authenticate(
        relayChild,
        harness.room,
        "viewer",
        "peer-quality-relay-child",
      ),
    );
    expect(relayChildAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: viewerAuth.peerId,
    });

    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "peer_quality_connection",
          relayChildAuth.routeRevision,
          1,
          6_500,
        ),
      ),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject({
      viewerPeerId: viewerAuth.peerId,
      guard: {
        connectionId: "peer_quality_connection",
        routeRevision: relayChildAuth.routeRevision,
      },
      sequence: 1,
    });

    viewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: relayChildAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "relay_child_quality_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await relayChild.inbox.next("signal");
    relayChild.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "relay_child_quality_connection",
          relayChildAuth.routeRevision,
          0,
        ),
      ),
    );
    const relayedEvidence = await viewer.inbox.next("viewer-quality-evidence");
    expect(relayedEvidence).toMatchObject({
      viewerPeerId: relayChildAuth.peerId,
      parentPeerId: viewerAuth.peerId,
      guard: {
        connectionId: "relay_child_quality_connection",
        routeRevision: relayChildAuth.routeRevision,
      },
    });
    expect(await host.inbox.next("viewer-quality-evidence")).toEqual(
      relayedEvidence,
    );

    const replaced = harness.roomStore.connectParticipant({
      roomId: harness.room.roomId,
      role: "viewer",
      ...(harness.room.viewerGrant
        ? { viewerGrant: harness.room.viewerGrant }
        : {}),
      clientId: "peer-quality-relay-child",
      sessionId: "peer-quality-relay-child-replacement-session",
    });
    expect(replaced.peerId).toBe(relayChildAuth.peerId);
    now += 2_000;
    relayChild.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "relay_child_quality_connection",
          relayChildAuth.routeRevision,
          1,
        ),
      ),
    );
    await viewer.inbox.expectNone(30);
    await host.inbox.expectNone(30);
  });

  it("correlates B only from the current parent session and C generation", async () => {
    const acceptedParentEvidence = vi.spyOn(
      HybridMediaRouter.prototype,
      "handleParentEdgeQualityEvidence",
    );
    let now = 80_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-guard-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(viewer, harness.room, "viewer", "quality-guard-viewer"),
    );
    const unrelatedParent = await openClient(harness.webSocketUrl);
    const unrelatedParentAuth = peerAssisted(
      await authenticate(
        unrelatedParent,
        harness.room,
        "viewer",
        "quality-guard-unrelated",
      ),
    );
    const active = await nextActiveRouteAfter(
      viewer,
      viewerAuth.routeRevision,
    );
    expect(active.assignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_guard_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    let sequence = 0;
    const sendBadC = async (parent: TestClient = host) => {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_guard_connection",
            active.revision,
            sequence,
            { packetsReceivedDelta: 70, packetsLostDelta: 30 },
          ),
        ),
      );
      sequence += 1;
      return parent.inbox.next("viewer-quality-evidence");
    };
    const parentProof = (
      evidence: Extract<ServerMessage, { type: "viewer-quality-evidence" }>,
    ) => ({
      type: "parent-edge-quality-evidence" as const,
      viewerPeerId: evidence.viewerPeerId,
      guard: evidence.guard,
      viewerSequence: evidence.sequence,
      proof: {
        kind: "remote-loss" as const,
        packetsSentDelta: 100,
        remotePacketsLostDelta: 30,
      },
    });

    let evidence = await sendBadC();
    unrelatedParent.socket.send(JSON.stringify(parentProof(evidence)));
    now += 2_000;

    for (const mutate of [
      (proof: ReturnType<typeof parentProof>) => ({
        ...proof,
        guard: { ...proof.guard, connectionId: "quality_guard_wrong" },
      }),
      (proof: ReturnType<typeof parentProof>) => ({
        ...proof,
        guard: { ...proof.guard, routeRevision: proof.guard.routeRevision + 1 },
      }),
      (proof: ReturnType<typeof parentProof>) => ({
        ...proof,
        viewerSequence: proof.viewerSequence + 1,
      }),
    ]) {
      evidence = await sendBadC();
      host.socket.send(JSON.stringify(mutate(parentProof(evidence))));
      now += 2_000;
    }

    evidence = await sendBadC();
    now += 5_001;
    host.socket.send(JSON.stringify(parentProof(evidence)));

    now += 2_000;
    evidence = await sendBadC();
    const replacementHost = await openClient(harness.webSocketUrl);
    const replacementHostAuth = peerAssisted(
      await authenticate(
        replacementHost,
        harness.room,
        "host",
        "quality-guard-host",
      ),
    );
    expect(replacementHostAuth.peerId).toBe(hostAuth.peerId);
    replacementHost.socket.send(JSON.stringify(parentProof(evidence)));

    expect(acceptedParentEvidence).not.toHaveBeenCalled();
    await expect(viewer.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );

    now += 2_000;
    for (let index = 0; index < 3; index += 1) {
      evidence = await sendBadC(replacementHost);
      const proof = parentProof(evidence);
      replacementHost.socket.send(JSON.stringify(proof));
      if (index === 0) {
        replacementHost.socket.send(JSON.stringify(proof));
      }
      now += 2_000;
    }
    const moved = await completePreparedPeerMigration(
      viewer,
      unrelatedParent,
      viewerAuth.peerId,
      unrelatedParentAuth.peerId,
      active.revision,
      "quality_guard_probe",
    );
    expect(acceptedParentEvidence).toHaveBeenCalledTimes(3);
    expect(moved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: unrelatedParentAuth.peerId,
    });
    acceptedParentEvidence.mockRestore();
  });

  it("does not treat a 30 FPS relay child as bad against a 60 FPS setting", async () => {
    let now = 90_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relative_same_fps",
      () => now,
    );
    await correlateRelayParentInboundFps(fixture, 30);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await correlateRelayChildFps(fixture, sequence, 30);
      now += 2_000;
    }
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
  });

  it("moves a relay child after three corroborated relative-FPS windows", async () => {
    let now = 110_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relative_peer_move",
      () => now,
    );
    await correlateRelayParentInboundFps(fixture, 30);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await correlateRelayChildFps(fixture, sequence, 10);
      now += 2_000;
    }
    const moved = await completePreparedPeerMigration(
      fixture.child,
      fixture.alternate,
      fixture.childAuth.peerId,
      fixture.alternateAuth.peerId,
      fixture.routeRevision,
      "relative_peer_move_probe",
    );
    expect(moved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });

    fixture.child.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: moved.revision,
        phase: "active",
        connectionId: "relative_peer_move_probe",
      }),
    );
    const recovered = await nextActiveRouteAfter(fixture.child, moved.revision);
    expect(recovered.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
  });

  it("uses an eligible Host as the provisional peer parent", async () => {
    let now = 120_000;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_skip_host",
      () => now,
      { alternateRelayCapacity: 0 },
    );
    fixture.alternate.socket.close();
    const [current] = await Promise.all([
      nextActiveRouteAfter(fixture.child, fixture.routeRevision),
      nextActiveRouteAfter(fixture.parent, fixture.routeRevision),
      nextActiveRouteAfter(fixture.host, fixture.routeRevision),
    ]);
    fixture.routeRevision = current.revision;
    const advanceWindow = () => { now += 2_000; };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    const moved = await completePreparedPeerMigration(
      fixture.child,
      fixture.host,
      fixture.childAuth.peerId,
      fixture.hostAuth.peerId,
      fixture.routeRevision,
      "quality_host_probe",
    );
    expect(moved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.hostAuth.peerId,
    });
  });

  it("keeps the old edge when the Host upload budget is already full", async () => {
    let now = 125_000;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_only_host",
      () => now,
      { alternateRelayCapacity: 0 },
    );
    await Promise.all([
      nextActiveRouteRevision(fixture.host, fixture.routeRevision),
      nextActiveRouteRevision(fixture.alternate, fixture.routeRevision),
    ]);
    const advanceWindow = () => { now += 2_000; };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    await expect(fixture.child.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );
  });

  it("rolls a Host-parent probe back only for its exact revision and connection", async () => {
    let now = 126_000;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_host_exact_failure",
      () => now,
      { alternateRelayCapacity: 0 },
    );
    const probeConnectionId = "quality_host_exact_failure_probe";
    const { viewerPrepare } = await prepareHostParentQualityProbe(
      fixture,
      () => { now += 2_000; },
      probeConnectionId,
    );

    for (const [revision, connectionId] of [
      [viewerPrepare.revision - 1, probeConnectionId],
      [viewerPrepare.revision, `${probeConnectionId}-wrong`],
    ] as const) {
      fixture.child.socket.send(JSON.stringify({
        type: "route-failed",
        revision,
        phase: "prepare",
        connectionId,
      }));
    }
    await Promise.all([
      expect(
        fixture.child.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        fixture.host.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
    ]);

    fixture.child.socket.send(JSON.stringify({
      type: "route-failed",
      revision: viewerPrepare.revision,
      phase: "prepare",
      connectionId: probeConnectionId,
    }));
    const [viewerRollback, hostRollback] = await Promise.all([
      nextActiveRouteAfter(fixture.child, viewerPrepare.revision),
      nextActiveRouteAfter(fixture.host, viewerPrepare.revision),
    ]);
    expect(viewerRollback.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    expect(hostRollback.revision).toBe(viewerRollback.revision);
    await expect(
      sendTestOffer(
        fixture.parent,
        fixture.child,
        fixture.childAuth.peerId,
        "quality_host_exact_failure_old_edge",
      ),
    ).resolves.toMatchObject({ fromPeerId: fixture.parentAuth.peerId });
  });

  it("invalidates a Host-parent probe when the Host session is replaced", async () => {
    let now = 127_000;
    const shareGeneration = "quality_host_session_share";
    const fixture = await startRelayRelativeFpsFixture(
      "quality_host_session",
      () => now,
      { alternateRelayCapacity: 0, hostShareGeneration: shareGeneration },
    );
    const { viewerPrepare } = await prepareHostParentQualityProbe(
      fixture,
      () => { now += 2_000; },
      "quality_host_session_probe",
    );
    const oldClosed = new Promise<number>((resolve) =>
      fixture.host.socket.once("close", (code) => resolve(code)),
    );
    const replacement = await openClient(fixture.harness.webSocketUrl);
    const replacementAuth = peerAssisted(await authenticate(
      replacement,
      fixture.harness.room,
      "host",
      "quality_host_session-host",
      1,
      shareGeneration,
    ));
    expect(await oldClosed).toBe(4001);
    expect(replacementAuth.peerId).toBe(fixture.hostAuth.peerId);
    expect(replacementAuth.routeRevision).toBeGreaterThan(viewerPrepare.revision);
    expect(replacementAuth.routeAssignment.childPeerIds).not.toContain(
      fixture.childAuth.peerId,
    );
    const rollback = await nextActiveRouteAfter(
      fixture.child,
      viewerPrepare.revision,
    );
    expect(rollback.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });

    fixture.child.socket.send(JSON.stringify({
      type: "route-ready",
      revision: viewerPrepare.revision,
      phase: "prepare",
    }));
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
  });

  it("invalidates a Host-parent probe when a new share generation starts", async () => {
    let now = 127_500;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_host_share",
      () => now,
      {
        alternateRelayCapacity: 0,
        hostShareGeneration: "quality_host_share_a",
      },
    );
    const { viewerPrepare } = await prepareHostParentQualityProbe(
      fixture,
      () => { now += 2_000; },
      "quality_host_share_probe",
    );
    const oldClosed = new Promise<number>((resolve) =>
      fixture.host.socket.once("close", (code) => resolve(code)),
    );
    const replacement = await openClient(fixture.harness.webSocketUrl);
    const replacementAuth = peerAssisted(await authenticate(
      replacement,
      fixture.harness.room,
      "host",
      "quality_host_share-host",
      1,
      "quality_host_share_b",
    ));
    expect(await oldClosed).toBe(4001);
    expect(replacementAuth.peerId).toBe(fixture.hostAuth.peerId);
    expect(replacementAuth.routeAssignment.childPeerIds).not.toContain(
      fixture.childAuth.peerId,
    );
    await fixture.child.inbox.next("sharing-stopped");
    const nextShareRoute = await nextActiveRouteRevision(
      fixture.child,
      replacementAuth.routeRevision,
    );
    expect(nextShareRoute.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });

    fixture.child.socket.send(JSON.stringify({
      type: "route-ready",
      revision: viewerPrepare.revision,
      phase: "prepare",
    }));
    fixture.child.socket.send(JSON.stringify({
      type: "route-failed",
      revision: viewerPrepare.revision,
      phase: "prepare",
      connectionId: "quality_host_share_probe",
    }));
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
  });

  it("counts an answered Host selected overlay against a quality-probe slot", async () => {
    let now = 128_000;
    const harness = await startSfuHarness({
      now: () => now,
      endpointMediaCopyCapacity: 3,
      tokenIssuer: {
        async issueToken({ peerId }) { return `token-${peerId}`; },
      },
      selectedEdgeTurn: true,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "quality-host-selected-budget",
    );
    active.viewer.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 0,
    }));
    const parent = await openClient(harness.webSocketUrl);
    const parentAuth = peerAssisted(await authenticate(
      parent,
      harness.room,
      "viewer",
      "quality-host-selected-budget-parent",
      1,
    ));
    expect(parentAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const hostFiller = await openClient(harness.webSocketUrl);
    const hostFillerAuth = peerAssisted(await authenticate(
      hostFiller,
      harness.room,
      "viewer",
      "quality-host-selected-budget-filler",
      0,
    ));
    expect(hostFillerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const child = await openClient(harness.webSocketUrl);
    const childAuth = peerAssisted(await authenticate(
      child,
      harness.room,
      "viewer",
      "quality-host-selected-budget-child",
      0,
    ));
    expect(childAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAuth.peerId,
    });

    hostFiller.socket.close();
    const current = await nextActiveRouteAfter(child, childAuth.routeRevision);
    await Promise.all([
      nextActiveRouteRevision(active.host, current.revision),
      nextActiveRouteRevision(active.viewer, current.revision),
      nextActiveRouteRevision(parent, current.revision),
    ]);
    const grant = await startPeerSelectedTurn(
      active.viewer,
      active.host,
      current.revision,
    );
    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    await active.viewer.inbox.next("signal");
    active.viewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.hostAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await active.host.inbox.next("signal");

    await sendTestOffer(
      active.host,
      parent,
      parentAuth.peerId,
      "quality_host_selected_budget_parent_connection",
    );
    const childConnectionId = "quality_host_selected_budget_child_connection";
    await sendTestOffer(parent, child, childAuth.peerId, childConnectionId);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      child.socket.send(JSON.stringify(viewerQualityEvidenceWithMetrics(
        childConnectionId,
        current.revision,
        sequence,
        { framesDecodedDelta: 0 },
      )));
      await correlateParentEdgeQualityEvidence(parent);
      now += 2_000;
    }
    await expect(child.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );

    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: grant.newConnectionId,
        candidate: null,
      },
    }));
    await expect(active.viewer.inbox.next("signal")).resolves.toMatchObject({
      fromPeerId: active.hostAuth.peerId,
      payload: { connectionId: grant.newConnectionId },
    });
  });

  it("keeps an SFU-fed Viewer leaf without outbound relay proof", async () => {
    let now = 128_000;
    const harness = await startSfuHarness({
      now: () => now,
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "quality_only_host_sfu_root",
    );
    active.viewer.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 0,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const parent = await openClient(harness.webSocketUrl);
    const parentAuth = peerAssisted(await authenticate(
      parent, harness.room, "viewer", "quality-sfu-root-parent", 1,
    ));
    expect(parentAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const child = await openClient(harness.webSocketUrl);
    const childAuth = peerAssisted(await authenticate(
      child, harness.room, "viewer", "quality-sfu-root-child", 0,
    ));
    expect(childAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAuth.peerId,
    });

    const parentConnectionId = "quality_sfu_root_parent_connection";
    await sendTestOffer(
      active.host,
      parent,
      parentAuth.peerId,
      parentConnectionId,
    );
    const childConnectionId = "quality_sfu_root_child_connection";
    await sendTestOffer(parent, child, childAuth.peerId, childConnectionId);
    const routeRevision = childAuth.routeRevision;
    active.viewer.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 2,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    for (let sequence = 0; sequence < 3; sequence += 1) {
      child.socket.send(JSON.stringify(viewerQualityEvidenceWithMetrics(
        childConnectionId,
        routeRevision,
        sequence,
        { framesDecodedDelta: 0 },
      )));
      await correlateParentEdgeQualityEvidence(parent);
      now += 2_000;
    }
    await expect(child.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );
    await expect(active.viewer.inbox.next("signal", 40)).rejects.toThrow(
      "Timed out",
    );
  });

  it("keeps the old relay edge when relative FPS has no alternate peer", async () => {
    let now = 130_000;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "relative_no_alternate",
      () => now,
      {
        alternateRelayCapacity: 0,
        onSfuTokenIssue: () => {
          issuedSfuTokens += 1;
        },
        sfu: true,
      },
    );
    await correlateRelayParentInboundFps(fixture, 30);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await correlateRelayChildFps(fixture, sequence, 10);
      now += 2_000;
    }
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      fixture.child.inbox.next("sfu-config", 40),
    ).rejects.toThrow("Timed out");
    await expect(fixture.child.inbox.next("error", 40)).rejects.toThrow(
      "Timed out",
    );
    expect(issuedSfuTokens).toBe(0);

    const activeConnectionId = "relative_no_alternate_still_active";
    fixture.parent.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: fixture.childAuth.peerId,
        payload: {
          kind: "description",
          connectionId: activeConnectionId,
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await fixture.child.inbox.next("signal")).toMatchObject({
      fromPeerId: fixture.parentAuth.peerId,
    });

    for (let sequence = 0; sequence < 3; sequence += 1) {
      fixture.child.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            activeConnectionId,
            fixture.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(fixture.parent);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      now += 2_000;
    }
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      fixture.child.inbox.next("sfu-config", 40),
    ).rejects.toThrow("Timed out");
    expect(issuedSfuTokens).toBe(0);
  });

  describe(
    "capacity-two relay quality coordination",
    () => {
  it("keeps a severe child on its old edge when no peer alternate exists", async () => {
    let now = 142_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_second_severe",
      () => now,
      { alternateRelayCapacity: 0, secondChild: true, sfu: true },
    );
    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    await confirmRelayChildSevere(
      fixture,
      fixture.secondChild!,
      fixture.secondChildConnectionId,
      advanceWindow,
    );

    await expect(
      fixture.secondChild!.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      fixture.secondChild!.inbox.next("sfu-config", 40),
    ).rejects.toThrow("Timed out");
    },
  );

  it("gives a severe trigger the sole alternate before evacuating siblings", async () => {
    let now = 144_000;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_severe_peer_first",
      () => now,
      {
        alternateRelayCapacity: 0,
        onSfuTokenIssue: () => {
          issuedSfuTokens += 1;
        },
        secondChild: true,
        sfu: true,
      },
    );
    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    fixture.alternate.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 1,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await confirmRelayChildSevere(
      fixture,
      fixture.secondChild!,
      fixture.secondChildConnectionId,
      advanceWindow,
    );

    const triggerMoved = await completePreparedPeerMigration(
      fixture.secondChild!,
      fixture.alternate,
      fixture.secondChildAuth!.peerId,
      fixture.alternateAuth.peerId,
      fixture.routeRevision,
      "relay_parent_severe_peer_probe",
    );
    expect(triggerMoved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });
    const siblingStayed = await nextActiveRouteRevision(
      fixture.child,
      triggerMoved.revision,
    );
    expect(siblingStayed.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    expect(issuedSfuTokens).toBe(0);
  });

  it("does not escalate soft quality recovery to SFU or selected TURN", async () => {
    let now = 144_500;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_severe_selected_turn",
      () => now,
      {
        alternateRelayCapacity: 0,
        onSfuTokenIssue: () => { issuedSfuTokens += 1; },
        secondChild: true,
        selectedEdgeTurn: true,
        sfu: true,
      },
    );
    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    await confirmRelayChildSevere(
      fixture,
      fixture.secondChild!,
      fixture.secondChildConnectionId,
      advanceWindow,
    );
    await expect(
      fixture.secondChild!.inbox.next("sfu-config", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      fixture.secondChild!.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
    expect(issuedSfuTokens).toBe(0);
  });

  it("does not drain a relay after two child-scoped quality events", async () => {
    let now = 145_000;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_child_scoped_quality",
      () => now,
      {
        alternateRelayCapacity: 0,
        onSfuTokenIssue: () => {
          issuedSfuTokens += 1;
        },
        secondChild: true,
        sfu: true,
      },
    );
    const secondChild = fixture.secondChild!;

    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    await confirmRelayParentChildRelativeFps(fixture, 1, advanceWindow);

    expect(issuedSfuTokens).toBe(0);
    expect(await sendTestOffer(
      fixture.parent,
      secondChild,
      fixture.secondChildAuth!.peerId,
      "relay_parent_child_scoped_still_active",
    )).toMatchObject({
      fromPeerId: fixture.parentAuth.peerId,
    });

    fixture.child.socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    fixture.parent.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 2 }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const pending = await openClient(fixture.harness.webSocketUrl);
    const pendingAuth = peerAssisted(
      await authenticate(
        pending,
        fixture.harness.room,
        "viewer",
        "relay-parent-child-scoped-pending",
        0,
      ),
    );
    expect(pendingAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
  });

  it("serializes child-scoped migrations through the room cooldown", async () => {
    let now = 180_000;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_peer_only",
      () => now,
      {
        alternateRelayCapacity: 1,
        onSfuTokenIssue: () => {
          issuedSfuTokens += 1;
        },
        secondChild: true,
        sfu: true,
      },
    );
    const secondChild = fixture.secondChild!;

    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    const firstMoved = await completePreparedPeerMigration(
      fixture.child,
      fixture.alternate,
      fixture.childAuth.peerId,
      fixture.alternateAuth.peerId,
      fixture.routeRevision,
      "relay_parent_peer_only_probe",
    );
    expect(firstMoved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });
    fixture.routeRevision = firstMoved.revision;
    const secondAtFirstMove = await nextActiveRouteRevision(
      secondChild,
      firstMoved.revision,
    );
    expect(secondAtFirstMove.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    await confirmRelayParentChildRelativeFps(fixture, 1, advanceWindow);
    await expect(secondChild.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );

    for (let sequence = 2; sequence < 5; sequence += 1) {
      fixture.parent.socket.send(JSON.stringify(viewerQualityEvidenceWithMetrics(
        fixture.parentConnectionId,
        fixture.routeRevision,
        sequence,
        { framesDecodedDelta: 0 },
      )));
      await correlateParentEdgeQualityEvidence(fixture.host);
      now += 2_000;
    }
    expect(issuedSfuTokens).toBe(0);
    await expect(
      fixture.parent.inbox.next("sfu-config", 40),
    ).rejects.toThrow("Timed out");
  });

  it("allows only one peer quality migration per room", async () => {
    let now = 200_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_pending_severe",
      () => now,
      {
        alternateRelayCapacity: 1,
        secondChild: true,
        sfu: true,
      },
    );
    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    await confirmRelayChildSevere(
      fixture,
      fixture.secondChild!,
      fixture.secondChildConnectionId,
      advanceWindow,
    );
    await expect(
      fixture.secondChild!.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    const childActive = await completePreparedPeerMigration(
      fixture.child,
      fixture.alternate,
      fixture.childAuth.peerId,
      fixture.alternateAuth.peerId,
      fixture.routeRevision,
      "relay_parent_pending_probe",
    );
    expect(childActive.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });
    const siblingStayed = await nextActiveRouteRevision(
      fixture.secondChild!,
      childActive.revision,
    );
    expect(siblingStayed.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
  });

  it("does not combine confirmed child events across the five-second gap", async () => {
    let now = 220_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relay_parent_stale_gap",
      () => now,
      { alternateRelayCapacity: 0, secondChild: true },
    );
    const secondChild = fixture.secondChild!;

    const advanceWindow = () => {
      now += 2_000;
    };
    await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);
    now += 5_001;
    fixture.alternate.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 2 }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await confirmRelayParentChildRelativeFps(fixture, 1, advanceWindow);

    const secondMoved = await completePreparedPeerMigration(
      secondChild,
      fixture.alternate,
      fixture.secondChildAuth!.peerId,
      fixture.alternateAuth.peerId,
      fixture.routeRevision,
      "relay_parent_stale_gap_probe",
    );
    expect(secondMoved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });
    const firstStayed = await nextActiveRouteRevision(
      fixture.child,
      secondMoved.revision,
    );
    expect(firstStayed.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
  });

  it.each(["session", "share"] as const)(
    "does not combine confirmed children across a new parent %s",
    async (boundary) => {
      let now = boundary === "session" ? 250_000 : 280_000;
      const prefix = `relay_parent_stale_${boundary}`;
      const fixture = await startRelayRelativeFpsFixture(prefix, () => now, {
        alternateRelayCapacity: 0,
        secondChild: true,
      });
      const secondChild = fixture.secondChild!;

      const advanceWindow = () => {
        now += 2_000;
      };
      await confirmRelayParentChildRelativeFps(fixture, 0, advanceWindow);

      if (boundary === "session") {
        const replacement = await openClient(fixture.harness.webSocketUrl);
        const replacementAuth = peerAssisted(
          await authenticate(
            replacement,
            fixture.harness.room,
            "viewer",
            `${prefix}-parent`,
            2,
          ),
        );
        expect(replacementAuth.peerId).toBe(fixture.parentAuth.peerId);
        fixture.parent = replacement;
        fixture.parentAuth = replacementAuth;
        fixture.routeRevision = replacementAuth.routeRevision;
      } else {
        const replacement = await openClient(fixture.harness.webSocketUrl);
        const replacementAuth = peerAssisted(
          await authenticate(
            replacement,
            fixture.harness.room,
            "host",
            `${prefix}-host`,
            1,
            `${prefix}-next-share`,
          ),
        );
        expect(replacementAuth.peerId).toBe(fixture.hostAuth.peerId);
        fixture.host = replacement;
        fixture.hostAuth = replacementAuth;
        fixture.routeRevision = replacementAuth.routeRevision;
      }
      await reconnectRelayQualityEdges(fixture, `${prefix}_replacement`);
      fixture.alternate.socket.send(
        JSON.stringify({ type: "relay-capacity", downstreamEdges: 2 }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await confirmRelayParentChildRelativeFps(fixture, 1, advanceWindow);

      const secondMoved = await completePreparedPeerMigration(
        secondChild,
        fixture.alternate,
        fixture.secondChildAuth!.peerId,
        fixture.alternateAuth.peerId,
        fixture.routeRevision,
        `${prefix}_probe`,
      );
      expect(secondMoved.assignment.upstream).toEqual({
        kind: "peer",
        peerId: fixture.alternateAuth.peerId,
      });
      const firstChildSignal = await sendTestOffer(
        fixture.parent,
        fixture.child,
        fixture.childAuth.peerId,
        `${prefix}_first_child_still_active`,
      );
      expect(firstChildSignal).toMatchObject({
        fromPeerId: fixture.parentAuth.peerId,
      });
    },
  );

  });

  it("does not apply relative-FPS reparenting to a Host-direct edge", async () => {
    let now = 150_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "relative_host_direct_host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "relative_host_direct_viewer",
        0,
      ),
    );
    const alternate = await openClient(harness.webSocketUrl);
    const alternateAuth = peerAssisted(
      await authenticate(
        alternate,
        harness.room,
        "viewer",
        "relative_host_direct_alternate",
        1,
      ),
    );
    await nextActiveRouteRevision(viewer, alternateAuth.routeRevision);
    expect(viewerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "relative_host_direct_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    for (let sequence = 0; sequence < 3; sequence += 1) {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "relative_host_direct_connection",
            alternateAuth.routeRevision,
            sequence,
            { framesPerSecond: 10 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(host);
      now += 2_000;
    }
    await expect(viewer.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );
  });

  it("requires fresh correlated inbound FPS from the relay parent", async () => {
    let now = 170_000;
    const fixture = await startRelayRelativeFpsFixture(
      "relative_parent_freshness",
      () => now,
    );
    for (let sequence = 0; sequence < 3; sequence += 1) {
      await correlateRelayChildFps(fixture, sequence, 10);
      now += 2_000;
    }
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");

    await correlateRelayParentInboundFps(fixture, 30);
    now += 5_001;
    for (let sequence = 3; sequence < 6; sequence += 1) {
      await correlateRelayChildFps(fixture, sequence, 10);
      now += 2_000;
    }
    await expect(
      fixture.child.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
  });

  it.each(["connection", "revision", "session"] as const)(
    "rejects relative FPS after the relay parent's %s identity changes",
    async (changedIdentity) => {
      let now = 180_000;
      const prefix = `relative_parent_${changedIdentity}`;
      const fixture = await startRelayRelativeFpsFixture(prefix, () => now);
      await correlateRelayParentInboundFps(fixture, 30);
      let routeRevision = fixture.routeRevision;

      if (changedIdentity === "connection") {
        fixture.host.socket.send(
          JSON.stringify({
            type: "signal",
            targetPeerId: fixture.parentAuth.peerId,
            payload: {
              kind: "description",
              connectionId: `${prefix}_replacement_connection`,
              description: { type: "offer", sdp: "v=0\r\n" },
            },
          }),
        );
        await fixture.parent.inbox.next("signal");
      } else if (changedIdentity === "revision") {
        const extra = await openClient(fixture.harness.webSocketUrl);
        const extraAuth = peerAssisted(
          await authenticate(
            extra,
            fixture.harness.room,
            "viewer",
            `${prefix}-extra`,
            0,
          ),
        );
        routeRevision = extraAuth.routeRevision;
        await nextActiveRouteRevision(fixture.child, routeRevision);
      } else {
        const replacement = await openClient(fixture.harness.webSocketUrl);
        const replacementAuth = peerAssisted(
          await authenticate(
            replacement,
            fixture.harness.room,
            "viewer",
            `${prefix}-parent`,
            1,
          ),
        );
        expect(replacementAuth.peerId).toBe(fixture.parentAuth.peerId);
        routeRevision = replacementAuth.routeRevision;
        fixture.parent = replacement;
      }

      for (let sequence = 0; sequence < 3; sequence += 1) {
        fixture.child.socket.send(
          JSON.stringify(
            viewerQualityEvidenceWithMetrics(
              fixture.childConnectionId,
              routeRevision,
              sequence,
              { framesPerSecond: 10 },
            ),
          ),
        );
        await correlateParentEdgeQualityEvidence(fixture.parent, {
          kind: "sender-limited",
          packetsSentDelta: 1_500,
          reason: "bandwidth",
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        now += 2_000;
      }
      await expect(
        fixture.child.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out");
    },
  );

  it("keeps severe zero-decode quality on the old edge without an alternate", async () => {
    let now = 190_000;
    const harness = await startSfuHarness({
      now: () => now,
      tokenIssuer: { issueToken: async ({ peerId }) => `token-${peerId}` },
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "severe_sfu_host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(viewer, harness.room, "viewer", "severe_sfu_viewer", 0),
    );
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "severe_sfu_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    for (let sequence = 0; sequence < 3; sequence += 1) {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "severe_sfu_connection",
            viewerAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(host);
      now += 2_000;
    }
    await expect(viewer.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );
    await expect(viewer.inbox.next("sfu-config", 40)).rejects.toThrow(
      "Timed out",
    );
    expect(hostAuth.routeAssignment.upstream).toEqual({ kind: "none" });
  });

  it("reparents only a viewer subtree after three hard quality windows", async () => {
    let now = 100_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-route-host"),
    );
    host.inbox.ignore("route-update");
    host.inbox.ignore("media-assignment");

    const parentA = await openClient(harness.webSocketUrl);
    const parentAAuth = peerAssisted(
      await authenticate(
        parentA,
        harness.room,
        "viewer",
        "quality-route-parent-a",
      ),
    );
    expect(parentAAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    const parentB = await openClient(harness.webSocketUrl);
    const parentBAuth = peerAssisted(
      await authenticate(
        parentB,
        harness.room,
        "viewer",
        "quality-route-parent-b",
      ),
    );
    expect(parentBAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    const subtreeRoot = await openClient(harness.webSocketUrl);
    const subtreeRootAuth = peerAssisted(
      await authenticate(
        subtreeRoot,
        harness.room,
        "viewer",
        "quality-route-subtree-root",
      ),
    );
    expect(subtreeRootAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAAuth.peerId,
    });
    const alternateParent = await openClient(harness.webSocketUrl);
    const alternateParentAuth = peerAssisted(
      await authenticate(
        alternateParent,
        harness.room,
        "viewer",
        "quality-route-alternate-parent",
      ),
    );
    expect(alternateParentAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: parentBAuth.peerId,
    });
    const subtreeLeaf = await openClient(harness.webSocketUrl);
    const subtreeLeafAuth = peerAssisted(
      await authenticate(
        subtreeLeaf,
        harness.room,
        "viewer",
        "quality-route-subtree-leaf",
        0,
      ),
    );
    expect(subtreeLeafAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: subtreeRootAuth.peerId,
    });
    await nextActiveRouteRevision(
      subtreeRoot,
      subtreeLeafAuth.routeRevision,
    );

    parentA.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: subtreeRootAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_route_parent_a",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await subtreeRoot.inbox.next("signal");

    for (let sequence = 0; sequence < 3; sequence += 1) {
      subtreeRoot.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_route_stale",
            subtreeLeafAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
    }
    await expect(
      subtreeRoot.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");

    for (let sequence = 0; sequence < 3; sequence += 1) {
      subtreeRoot.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_route_parent_a",
            subtreeLeafAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await parentA.inbox.next("viewer-quality-evidence");
      now += 2_000;
    }
    await expect(
      subtreeRoot.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");

    for (let sequence = 3; sequence < 6; sequence += 1) {
      subtreeRoot.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_route_parent_a",
            subtreeLeafAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(parentA, {
        kind: "sending",
        packetsSentDelta: 1_500,
      });
      now += 2_000;
    }
    await expect(
      subtreeRoot.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");

    subtreeRoot.socket.send(
      JSON.stringify(
        viewerQualityEvidenceWithMetrics(
          "quality_route_parent_a",
          subtreeLeafAuth.routeRevision,
          6,
          { packetsReceivedDelta: 70, packetsLostDelta: 30 },
        ),
      ),
    );
    await correlateParentEdgeQualityEvidence(parentA);
    now += 2_000;
    subtreeRoot.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "quality_route_parent_a",
          subtreeLeafAuth.routeRevision,
          7,
        ),
      ),
    );
    await correlateParentEdgeQualityEvidence(parentA);
    now += 2_000;
    subtreeRoot.socket.send(
      JSON.stringify(
        viewerQualityEvidenceWithMetrics(
          "quality_route_parent_a",
          subtreeLeafAuth.routeRevision,
          8,
          { freezeDurationMsDelta: 1_000 },
        ),
      ),
    );
    await correlateParentEdgeQualityEvidence(parentA, {
      kind: "sender-limited",
      packetsSentDelta: 1_500,
      reason: "cpu",
    });
    now += 2_000;
    subtreeRoot.socket.send(
      JSON.stringify(
        viewerQualityEvidenceWithMetrics(
          "quality_route_parent_a",
          subtreeLeafAuth.routeRevision,
          9,
          { freezeDurationMsDelta: 1_000 },
        ),
      ),
    );
    await correlateParentEdgeQualityEvidence(parentA, {
      kind: "sender-limited",
      packetsSentDelta: 1_500,
      reason: "bandwidth",
    });
    await expect(
      subtreeRoot.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");

    now += 2_000;
    subtreeRoot.socket.send(
      JSON.stringify(
        viewerQualityEvidenceWithMetrics(
          "quality_route_parent_a",
          subtreeLeafAuth.routeRevision,
          10,
          { freezeDurationMsDelta: 1_000 },
        ),
      ),
    );
    await correlateParentEdgeQualityEvidence(parentA, {
      kind: "sender-limited",
      packetsSentDelta: 1_500,
      reason: "cpu",
    });
    const movedRoot = await completePreparedPeerMigration(
      subtreeRoot,
      alternateParent,
      subtreeRootAuth.peerId,
      alternateParentAuth.peerId,
      subtreeLeafAuth.routeRevision,
      "quality_route_probe",
    );
    expect(movedRoot.assignment.upstream).toEqual({
      kind: "peer",
      peerId: alternateParentAuth.peerId,
    });
    const movedLeaf = await nextActiveRouteAfter(
      subtreeLeaf,
      subtreeLeafAuth.routeRevision,
    );
    expect(movedLeaf).toMatchObject({
      revision: movedRoot.revision,
      assignment: {
        upstream: { kind: "peer", peerId: subtreeRootAuth.peerId },
      },
    });
    const unchangedBranch = await nextActiveRouteAfter(
      alternateParent,
      subtreeLeafAuth.routeRevision,
    );
    expect(unchangedBranch).toMatchObject({
      revision: movedRoot.revision,
      assignment: {
        upstream: { kind: "peer", peerId: parentBAuth.peerId },
        childPeerIds: [subtreeRootAuth.peerId],
      },
    });
    const unchangedBranchRoot = await nextActiveRouteAfter(
      parentB,
      subtreeLeafAuth.routeRevision,
    );
    expect(unchangedBranchRoot).toMatchObject({
      revision: movedRoot.revision,
      assignment: {
        upstream: { kind: "peer", peerId: hostAuth.peerId },
        childPeerIds: [alternateParentAuth.peerId],
      },
    });

    subtreeRoot.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: subtreeLeafAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_route_leaf",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await subtreeLeaf.inbox.next("signal");
    for (let sequence = 0; sequence < 3; sequence += 1) {
      now += 2_000;
      subtreeLeaf.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_route_leaf",
            movedRoot.revision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(subtreeRoot);
    }
    await expect(
      subtreeLeaf.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      subtreeLeaf.inbox.next("error", 40),
    ).rejects.toThrow("Timed out");

    alternateParent.socket.close();
    const reattachedRoot = await nextActiveRouteAfter(
      subtreeRoot,
      movedRoot.revision,
    );
    expect(reattachedRoot.assignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAAuth.peerId,
    });

    parentA.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: subtreeRootAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_route_reattached",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await subtreeRoot.inbox.next("signal");
    subtreeRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: reattachedRoot.revision,
        phase: "active",
        connectionId: "quality_route_reattached",
      }),
    );
    const recoveredRoot = await nextActiveRouteAfter(
      subtreeRoot,
      reattachedRoot.revision,
    );
    expect(recoveredRoot.assignment.upstream).toEqual({
      kind: "peer",
      peerId: parentBAuth.peerId,
    });
  });

  it("resets a hard-quality streak after a five-second evidence gap", async () => {
    let now = 200_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-gap-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(viewer, harness.room, "viewer", "quality-gap-viewer"),
    );
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_gap_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    const sendBadWindow = async (sequence: number) => {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_gap_connection",
            viewerAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(host);
    };
    await sendBadWindow(0);
    now += 2_000;
    await sendBadWindow(1);
    now += 5_001;
    await sendBadWindow(2);
    await expect(viewer.inbox.next("error", 40)).rejects.toThrow("Timed out");
    now += 2_000;
    await sendBadWindow(3);
    await expect(viewer.inbox.next("error", 40)).rejects.toThrow("Timed out");
    now += 2_000;
    await sendBadWindow(4);
    await expect(viewer.inbox.next("error", 40)).rejects.toThrow("Timed out");
    expect(viewerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
  });

  it("breaks a hard-quality streak when newer C replaces an unmatched window", async () => {
    let now = 225_000;
    const harness = await startHarness({
      peerAssistedMedia: true,
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-pending-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "quality-pending-viewer",
      ),
    );
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_pending_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    const sendBadC = (sequence: number) => {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_pending_connection",
            viewerAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
    };

    sendBadC(0);
    await correlateParentEdgeQualityEvidence(host);
    now += 2_000;

    sendBadC(1);
    await host.inbox.next("viewer-quality-evidence");
    now += 2_000;

    sendBadC(2);
    await correlateParentEdgeQualityEvidence(host);
    now += 2_000;
    sendBadC(3);
    await correlateParentEdgeQualityEvidence(host);
    await expect(viewer.inbox.next("error", 40)).rejects.toThrow("Timed out");

    now += 2_000;
    sendBadC(4);
    await correlateParentEdgeQualityEvidence(host);
    await expect(viewer.inbox.next("error", 40)).rejects.toThrow("Timed out");
    expect(viewerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
  });

  it("keeps the old edge when a peer quality probe fails", async () => {
    let now = 250_000;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_probe_failure",
      () => now,
      { alternateRelayCapacity: 1 },
    );
    const advanceWindow = () => { now += 2_000; };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    const [viewerPrepare, parentPrepare] = await Promise.all([
      nextPreparedRoute(fixture.child),
      nextPreparedRoute(fixture.alternate),
    ]);
    expect(parentPrepare.revision).toBe(viewerPrepare.revision);
    await sendTestOffer(
      fixture.parent,
      fixture.child,
      fixture.childAuth.peerId,
      fixture.childConnectionId,
    );
    const probeConnectionId = "quality_probe_failure_candidate";
    await sendTestOffer(
      fixture.alternate,
      fixture.child,
      fixture.childAuth.peerId,
      probeConnectionId,
    );
    fixture.child.socket.send(JSON.stringify({
      type: "route-failed",
      revision: viewerPrepare.revision,
      phase: "prepare",
      connectionId: probeConnectionId,
    }));
    const rollback = await nextActiveRouteAfter(
      fixture.child,
      viewerPrepare.revision,
    );
    expect(rollback.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    await sendTestOffer(
      fixture.parent,
      fixture.child,
      fixture.childAuth.peerId,
      "quality_probe_failure_old_edge",
    );
  });

  it("keeps the old edge when a peer quality probe times out", async () => {
    let now = 300_000;
    let issuedSfuTokens = 0;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_probe_timeout",
      () => now,
      {
        alternateRelayCapacity: 1,
        onSfuTokenIssue: () => { issuedSfuTokens += 1; },
        prepareTimeoutMs: 20,
        sfu: true,
      },
    );
    const advanceWindow = () => { now += 2_000; };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    const [viewerPrepare, parentPrepare] = await Promise.all([
      nextPreparedRoute(fixture.child),
      nextPreparedRoute(fixture.alternate),
    ]);
    expect(parentPrepare.revision).toBe(viewerPrepare.revision);
    await sendTestOffer(
      fixture.parent,
      fixture.child,
      fixture.childAuth.peerId,
      fixture.childConnectionId,
    );
    const rollback = await nextActiveRouteAfter(
      fixture.child,
      viewerPrepare.revision,
    );
    expect(rollback.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    await expect(fixture.child.inbox.next("sfu-config", 40)).rejects.toThrow(
      "Timed out",
    );
    expect(issuedSfuTokens).toBe(0);
  });

  it("lets another viewer hard failure preempt a soft peer probe", async () => {
    let now = 320_000;
    const fixture = await startRelayRelativeFpsFixture(
      "quality_probe_hard_preemption",
      () => now,
      { alternateRelayCapacity: 1 },
    );
    const advanceWindow = () => { now += 2_000; };
    await confirmRelayChildSevere(
      fixture,
      fixture.child,
      fixture.childConnectionId,
      advanceWindow,
    );
    const [viewerPrepare, parentPrepare] = await Promise.all([
      nextPreparedRoute(fixture.child),
      nextPreparedRoute(fixture.alternate),
    ]);
    expect(parentPrepare.revision).toBe(viewerPrepare.revision);

    fixture.parent.socket.send(JSON.stringify({
      type: "route-failed",
      revision: fixture.routeRevision,
      phase: "active",
      connectionId: fixture.parentConnectionId,
    }));
    const [softRollback, candidateRollback, hardRollback] = await Promise.all([
      nextActiveRouteAfter(fixture.child, viewerPrepare.revision),
      nextActiveRouteAfter(fixture.alternate, viewerPrepare.revision),
      nextActiveRouteAfter(fixture.parent, viewerPrepare.revision),
    ]);
    expect(softRollback.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.parentAuth.peerId,
    });
    expect(candidateRollback.revision).toBe(softRollback.revision);
    expect(hardRollback.revision).toBe(softRollback.revision);

    const hardMoved = await nextActiveRouteAfter(
      fixture.parent,
      hardRollback.revision,
    );
    expect(hardMoved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: fixture.alternateAuth.peerId,
    });
  });

  it("rejects viewer C evidence above the byte cap", async () => {
    const harness = await startHarness();
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "oversized-quality-viewer",
    );
    const closed = new Promise<number>((resolve) =>
      viewer.socket.once("close", (code) => resolve(code)),
    );
    const valid = JSON.stringify(
      viewerQualityEvidence("oversized_quality_connection", 0, 0),
    );

    viewer.socket.send(
      `${valid}${" ".repeat(MAX_VIEWER_QUALITY_EVIDENCE_BYTES + 1)}`,
    );

    expect(await viewer.inbox.next("error")).toMatchObject({
      code: "INVALID_MESSAGE",
    });
    expect(await closed).toBe(1008);
  });

  it("rejects parent B evidence above the byte cap", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "oversized-parent-host");
    const closed = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    const valid = JSON.stringify({
      type: "parent-edge-quality-evidence",
      viewerPeerId: "oversized_parent_viewer",
      guard: {
        connectionId: "oversized_parent_connection",
        routeRevision: 0,
      },
      viewerSequence: 0,
      proof: { kind: "sending", packetsSentDelta: 1 },
    });

    host.socket.send(
      `${valid}${" ".repeat(MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES + 1)}`,
    );
    expect(await host.inbox.next("error")).toMatchObject({
      code: "INVALID_MESSAGE",
    });
    expect(await closed).toBe(1008);
  });

  it("routes offer and answer only between the host and the targeted viewer", async () => {
    const harness = await startHarness();
    const secondRoom = harness.roomStore.createRoom();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(host, harness.room, "host", "host-client-a");
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(viewer, harness.room, "viewer", "viewer-client-a");
    await host.inbox.next("peer-joined");
    const foreignViewer = await openClient(harness.webSocketUrl);
    const foreignAuth = await authenticate(
      foreignViewer,
      secondRoom,
      "viewer",
      "viewer-client-b",
    );

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "connection-a",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await viewer.inbox.next("signal")).toMatchObject({
      fromPeerId: hostAuth.peerId,
      payload: { description: { type: "offer" } },
    });

    viewer.socket.send(
      JSON.stringify({
        type: "signal",
        payload: {
          kind: "description",
          connectionId: "connection-a",
          description: { type: "answer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await host.inbox.next("signal")).toMatchObject({
      fromPeerId: viewerAuth.peerId,
      payload: { description: { type: "answer" } },
    });

    viewer.socket.send(
      JSON.stringify({
        type: "signal",
        payload: {
          kind: "description",
          connectionId: "connection-b",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect((await viewer.inbox.next("error")).code).toBe("FORBIDDEN");

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: foreignAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "connection-a",
          candidate: null,
        },
      }),
    );
    expect((await host.inbox.next("error")).code).toBe("PEER_NOT_FOUND");
    await foreignViewer.inbox.expectNone(30);
  });

  it("assigns a bounded peer relay tree and authorizes only direct media edges", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const secondRoom = harness.roomStore.createRoom();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "relay-host"),
    );
    expect(hostAuth.mediaAssignment).toEqual({
      parentPeerId: null,
      childPeerIds: [],
    });
    expect(hostAuth).toMatchObject({
      routeRevision: 0,
      routeAssignment: {
        upstream: { kind: "none" },
        childPeerIds: [],
        sfuPublicationGeneration: null,
      },
    });
    expect("sfuStandbyUrl" in hostAuth).toBe(false);

    const firstViewer = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        firstViewer,
        harness.room,
        "viewer",
        "relay-viewer-a",
      ),
    );
    expect(firstAuth.mediaAssignment.parentPeerId).toBe(hostAuth.peerId);
    expect(firstAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect((await host.inbox.next("media-assignment")).mediaAssignment).toEqual({
      parentPeerId: null,
      childPeerIds: [firstAuth.peerId],
    });

    const secondViewer = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        secondViewer,
        harness.room,
        "viewer",
        "relay-viewer-b",
      ),
    );
    expect(secondAuth.mediaAssignment.parentPeerId).toBe(hostAuth.peerId);
    expect((await host.inbox.next("media-assignment")).mediaAssignment).toEqual({
      parentPeerId: null,
      childPeerIds: [firstAuth.peerId, secondAuth.peerId],
    });

    const thirdViewer = await openClient(harness.webSocketUrl);
    const thirdAuth = peerAssisted(
      await authenticate(
        thirdViewer,
        harness.room,
        "viewer",
        "relay-viewer-c",
      ),
    );
    expect(thirdAuth.mediaAssignment.parentPeerId).toBe(firstAuth.peerId);
    expect(
      (await firstViewer.inbox.next("media-assignment")).mediaAssignment,
    ).toEqual({
      parentPeerId: hostAuth.peerId,
      childPeerIds: [thirdAuth.peerId],
    });

    firstViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: thirdAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "relay-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await thirdViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: firstAuth.peerId,
      payload: { description: { type: "offer" } },
    });

    thirdViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "relay-connection",
          description: { type: "answer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await firstViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: thirdAuth.peerId,
      payload: { description: { type: "answer" } },
    });

    thirdViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "relay-connection",
          candidate: null,
        },
      }),
    );
    expect(await firstViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: thirdAuth.peerId,
      payload: { kind: "candidate" },
    });

    thirdViewer.socket.send(
      JSON.stringify({
        type: "restart-request",
        targetPeerId: firstAuth.peerId,
        connectionId: "relay-connection",
        rebuild: true,
      }),
    );
    expect(await firstViewer.inbox.next("restart-request")).toMatchObject({
      fromPeerId: thirdAuth.peerId,
      connectionId: "relay-connection",
      rebuild: true,
    });

    thirdViewer.socket.send(
      JSON.stringify({
        type: "restart-request",
        targetPeerId: hostAuth.peerId,
        connectionId: "relay-connection",
        rebuild: false,
      }),
    );
    expect((await thirdViewer.inbox.next("error")).code).toBe("FORBIDDEN");

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: thirdAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "forbidden-non-edge",
          candidate: null,
        },
      }),
    );
    expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");

    thirdViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "forbidden-direction",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect((await thirdViewer.inbox.next("error")).code).toBe("FORBIDDEN");

    const foreignViewer = await openClient(harness.webSocketUrl);
    const foreignAuth = peerAssisted(
      await authenticate(
        foreignViewer,
        secondRoom,
        "viewer",
        "relay-foreign-viewer",
      ),
    );
    firstViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: foreignAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "cross-room",
          candidate: null,
        },
      }),
    );
    expect((await firstViewer.inbox.next("error")).code).toBe("PEER_NOT_FOUND");
    await foreignViewer.inbox.expectNone(30);
  });

  it("ignores SFU media assertions on an active peer route", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        issueToken: async ({ peerId }) => `token-${peerId}`,
      },
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(
        host,
        harness.room,
        "host",
        "peer-media-state-host",
        1,
        "peer-media-state-share",
        { viewerPresence: true },
      ),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "peer-media-state-viewer",
      ),
    );
    expect(viewerAuth.routeAssignment.upstream.kind).toBe("peer");

    for (const message of [
      {
        type: "route-ready",
        revision: viewerAuth.routeRevision,
        phase: "active",
      },
      {
        type: "route-media-unavailable",
        revision: viewerAuth.routeRevision,
      },
    ]) {
      viewer.socket.send(JSON.stringify(message));
    }

    const replacementHost = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(
      await authenticate(
        replacementHost,
        harness.room,
        "host",
        "peer-media-state-host",
        1,
        "peer-media-state-share",
        { viewerPresence: true },
      ),
    );
    expect(replacementAuth.peerId).toBe(hostAuth.peerId);
    const presence = await nextViewerPresenceMatching(
      replacementHost,
      (message) =>
        viewerPresenceEntries(message).some(
          (entry) => entry.peerId === viewerAuth.peerId,
        ),
    );
    expect(
      viewerPresenceEntries(presence).find(
        (entry) => entry.peerId === viewerAuth.peerId,
      ),
    ).toMatchObject({ upstream: viewerAuth.routeAssignment.upstream });
    expect(
      viewerPresenceEntries(presence).find(
        (entry) => entry.peerId === viewerAuth.peerId,
      )?.sfuMediaReady,
    ).toBeUndefined();
  });

  it("reports and revokes current SFU Viewer media readiness", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        issueToken: async ({ peerId }) => `token-${peerId}`,
      },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "sfu-media-ready",
      true,
    );
    const findViewer = (
      message: Extract<ServerMessage, { type: "viewer-presence" }>,
    ) =>
      viewerPresenceEntries(message).find(
        (entry) => entry.peerId === active.viewerAuth.peerId,
      );
    const initiallyUnready = await nextViewerPresenceMatching(
      active.host,
      (message) => findViewer(message)?.upstream.kind === "sfu",
    );
    expect(findViewer(initiallyUnready)?.sfuMediaReady).toBeUndefined();

    active.viewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: active.revision - 1,
        phase: "active",
      }),
    );
    const replacementHost = await openClient(harness.webSocketUrl);
    await authenticate(
      replacementHost,
      harness.room,
      "host",
      "sfu-media-ready-host",
      1,
      "sfu-media-ready-share",
      { viewerPresence: true },
    );
    const afterStaleReady = await nextViewerPresenceMatching(
      replacementHost,
      (message) => findViewer(message)?.upstream.kind === "sfu",
    );
    expect(findViewer(afterStaleReady)?.sfuMediaReady).toBeUndefined();

    active.viewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: active.revision,
        phase: "active",
      }),
    );
    const ready = await nextViewerPresenceMatching(
      replacementHost,
      (message) => findViewer(message)?.sfuMediaReady === true,
    );
    expect(findViewer(ready)).toMatchObject({
      upstream: { kind: "sfu" },
      sfuMediaReady: true,
    });

    active.viewer.socket.send(
      JSON.stringify({
        type: "route-media-unavailable",
        revision: active.revision - 1,
      }),
    );
    const replayHost = await openClient(harness.webSocketUrl);
    await authenticate(
      replayHost,
      harness.room,
      "host",
      "sfu-media-ready-host",
      1,
      "sfu-media-ready-share",
      { viewerPresence: true },
    );
    const replayed = await nextViewerPresenceMatching(
      replayHost,
      (message) => findViewer(message)?.sfuMediaReady === true,
    );
    expect(findViewer(replayed)?.sfuMediaReady).toBe(true);

    active.viewer.socket.send(
      JSON.stringify({
        type: "route-media-unavailable",
        revision: active.revision,
      }),
    );
    const unavailable = await nextViewerPresenceMatching(
      replayHost,
      (message) => {
        const viewer = findViewer(message);
        return viewer?.upstream.kind === "sfu" && !viewer.sfuMediaReady;
      },
    );
    expect(findViewer(unavailable)?.sfuMediaReady).toBeUndefined();

    active.viewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: active.revision,
        phase: "active",
      }),
    );
    await nextViewerPresenceMatching(
      replayHost,
      (message) => findViewer(message)?.sfuMediaReady === true,
    );

    const replacementViewer = await openClient(harness.webSocketUrl);
    const replacementViewerAuth = peerAssisted(
      await authenticate(
        replacementViewer,
        harness.room,
        "viewer",
        "sfu-media-ready-viewer",
      ),
    );
    expect(replacementViewerAuth).toMatchObject({
      peerId: active.viewerAuth.peerId,
      routeRevision: active.revision,
      routeAssignment: { upstream: { kind: "sfu" } },
    });
    const afterViewerSessionChange = await nextViewerPresenceMatching(
      replayHost,
      (message) => {
        const viewer = findViewer(message);
        return viewer?.upstream.kind === "sfu" && !viewer.sfuMediaReady;
      },
    );
    expect(findViewer(afterViewerSessionChange)?.sfuMediaReady).toBeUndefined();

    replacementViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: replacementViewerAuth.routeRevision,
        phase: "active",
      }),
    );
    await nextViewerPresenceMatching(
      replayHost,
      (message) => findViewer(message)?.sfuMediaReady === true,
    );

    await closeClient(replacementViewer);
    await nextViewerPresenceMatching(
      replayHost,
      (message) => findViewer(message) === undefined,
    );
  });

  it("reserves a Host publication slot when deployment tightens its edge limit to one", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken({ peerId }) {
          return `token-${peerId}`;
        },
      },
      endpointMediaCopyCapacity: 1,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "limit-one-host"),
    );
    const branchRoot = await openClient(harness.webSocketUrl);
    const branchRootAuth = peerAssisted(
      await authenticate(
        branchRoot,
        harness.room,
        "viewer",
        "limit-one-branch-root",
        1,
      ),
    );
    expect(branchRootAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    const failedViewer = await openClient(harness.webSocketUrl);
    const failedAuth = peerAssisted(
      await authenticate(
        failedViewer,
        harness.room,
        "viewer",
        "limit-one-failed-viewer",
        0,
      ),
    );
    expect(failedAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: branchRootAuth.peerId,
    });

    await sendTestOffer(
      host,
      branchRoot,
      branchRootAuth.peerId,
      "limit_one_host_branch_connection",
    );
    await sendTestOffer(
      branchRoot,
      failedViewer,
      failedAuth.peerId,
      "limit_one_deep_connection",
    );
    failedViewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: failedAuth.routeRevision,
      phase: "active",
      connectionId: "limit_one_deep_connection",
    }));

    const hostPrepare = await nextPreparedRoute(host);
    const branchPrepare = await nextPreparedRoute(branchRoot);
    const failedPrepare = await nextPreparedRoute(failedViewer);
    expect(branchPrepare.revision).toBe(hostPrepare.revision);
    expect(failedPrepare.revision).toBe(hostPrepare.revision);
    expect(hostPrepare.assignment).toMatchObject({
      childPeerIds: [],
      sfuPublicationGeneration: expect.any(String),
    });
    expect(branchPrepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(failedPrepare.assignment.upstream).toEqual({ kind: "sfu" });
  });

  it("rejects a fourth Host copy before issuing an SFU token at capacity three", async () => {
    let issuedSfuTokens = 0;
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken({ peerId }) {
          issuedSfuTokens += 1;
          return `token-${peerId}`;
        },
      },
      endpointMediaCopyCapacity: 3,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "capacity-three-host"),
    );
    const viewers: Array<{
      client: TestClient;
      auth: ReturnType<typeof peerAssisted>;
    }> = [];
    for (let index = 0; index < 3; index += 1) {
      const client = await openClient(harness.webSocketUrl);
      const auth = peerAssisted(
        await authenticate(
          client,
          harness.room,
          "viewer",
          `capacity-three-viewer-${index}`,
          0,
        ),
      );
      expect(auth.routeAssignment.upstream).toEqual({
        kind: "peer",
        peerId: hostAuth.peerId,
      });
      viewers.push({ client, auth });
    }

    const failed = viewers[2]!;
    const connectionId = "capacity_three_third_edge";
    await sendTestOffer(
      host,
      failed.client,
      failed.auth.peerId,
      connectionId,
    );
    failed.client.socket.send(JSON.stringify({
      type: "route-failed",
      revision: failed.auth.routeRevision,
      phase: "active",
      connectionId,
    }));

    expect(await failed.client.inbox.next("error")).toMatchObject({
      code: "PEER_NOT_FOUND",
      message: "Endpoint media copy transition capacity is exhausted",
    });
    expect(issuedSfuTokens).toBe(0);
    await expect(failed.client.inbox.next("sfu-config", 40)).rejects.toThrow(
      "Timed out",
    );
    await expect(failed.client.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );
  });

  it("SFU root invariant gate: retains a zero-child root across commit and reauthentication", async () => {
    const issued: Array<
      Parameters<SfuTokenIssuer["issueToken"]>[0]
    > = [];
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          issued.push(request);
          return `token-${request.peerId}`;
        },
      },
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "hybrid-host"),
    );
    expect(hostAuth.sfuStandbyUrl).toBe("wss://sfu.example.test");
    const firstViewer = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        firstViewer,
        harness.room,
        "viewer",
        "hybrid-viewer-a",
      ),
    );
    expect(firstAuth.sfuStandbyUrl).toBe("wss://sfu.example.test");
    const secondViewer = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        secondViewer,
        harness.room,
        "viewer",
        "hybrid-viewer-b",
      ),
    );
    const firstBeforeFailure = await nextActiveRouteAfter(
      firstViewer,
      firstAuth.routeRevision,
    );

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "hybrid-direct-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await firstViewer.inbox.next("signal");
    firstViewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: firstBeforeFailure.revision,
        phase: "active",
        connectionId: "hybrid-direct-connection",
      }),
    );

    const firstReparented = await nextActiveRouteAfter(
      firstViewer,
      firstBeforeFailure.revision,
    );
    expect(firstReparented.assignment.upstream).toEqual({
      kind: "peer",
      peerId: secondAuth.peerId,
    });
    const hostAfterReparent = await nextActiveRouteAfter(
      host,
      firstBeforeFailure.revision,
    );
    expect(hostAfterReparent.assignment).toMatchObject({
      childPeerIds: [secondAuth.peerId],
      sfuPublicationGeneration: null,
    });

    secondViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "hybrid-deep-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await firstViewer.inbox.next("signal");
    firstViewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: firstReparented.revision,
        phase: "active",
        connectionId: "hybrid-deep-connection",
      }),
    );

    const hostPrepare = await nextPreparedRoute(host);
    const rootPrepare = await nextPreparedRoute(firstViewer);
    expect(rootPrepare.revision).toBe(hostPrepare.revision);
    expect(hostPrepare.assignment).toMatchObject({
      upstream: { kind: "none" },
      childPeerIds: [secondAuth.peerId],
    });
    expect(rootPrepare.assignment).toMatchObject({
      upstream: { kind: "sfu" },
      childPeerIds: [],
    });
    expect(await host.inbox.next("sfu-config")).toMatchObject({
      revision: hostPrepare.revision,
      url: "wss://sfu.example.test",
    });
    expect(await firstViewer.inbox.next("sfu-config")).toMatchObject({
      revision: hostPrepare.revision,
    });
    await expect(secondViewer.inbox.next("sfu-config", 30)).rejects.toThrow(
      "Timed out",
    );

    secondViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: hostPrepare.revision,
        phase: "prepare",
      }),
    );
    expect((await secondViewer.inbox.next("error")).code).toBe("FORBIDDEN");
    host.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: hostPrepare.revision,
        phase: "prepare",
      }),
    );
    firstViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: hostPrepare.revision,
        phase: "prepare",
      }),
    );

    const hostActive = await nextActiveRouteAfter(
      host,
      hostPrepare.revision - 1,
    );
    const rootActive = await nextActiveRouteAfter(
      firstViewer,
      hostPrepare.revision - 1,
    );
    expect(hostActive.revision).toBe(hostPrepare.revision);
    expect(hostActive.assignment.childPeerIds).toEqual([secondAuth.peerId]);
    expect(hostActive.assignment.sfuPublicationGeneration).toBeTruthy();
    expect(rootActive.assignment.upstream).toEqual({ kind: "sfu" });
    expect(rootActive.assignment.childPeerIds).toEqual([]);
    expect(new Set(issued.map(({ peerId }) => peerId))).toEqual(
      new Set([hostAuth.peerId, firstAuth.peerId]),
    );
    expect(new Set(issued.map(({ publicationGeneration }) => publicationGeneration)).size).toBe(1);

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "candidate",
          connectionId: "no-longer-direct",
          candidate: null,
        },
      }),
    );
    expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");

    await closeClient(firstViewer);
    const reconnectedRoot = await openClient(harness.webSocketUrl);
    const reconnectedRootAuth = peerAssisted(
      await authenticate(
        reconnectedRoot,
        harness.room,
        "viewer",
        "hybrid-viewer-a",
      ),
    );
    expect(reconnectedRootAuth).toMatchObject({
      peerId: firstAuth.peerId,
      routeRevision: hostPrepare.revision,
      routeAssignment: {
        upstream: { kind: "sfu" },
        childPeerIds: [],
      },
      mediaAssignment: { parentPeerId: null },
    });
    expect(await reconnectedRoot.inbox.next("sfu-config")).toMatchObject({
      revision: hostPrepare.revision,
    });

    const issuedBeforeRefresh = issued.length;
    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      reconnectedRoot.socket.send(
        JSON.stringify({
          type: "refresh-sfu",
          revision: hostPrepare.revision,
        }),
      );
    }
    expect(await reconnectedRoot.inbox.next("sfu-config")).toMatchObject({
      revision: hostPrepare.revision,
    });
    expect((await reconnectedRoot.inbox.next("error")).code).toBe("FORBIDDEN");
    expect(issued).toHaveLength(issuedBeforeRefresh + 1);
    const issuedBeforeFailback = issued.length;
    reconnectedRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: hostPrepare.revision,
        phase: "active",
        connectionId: null,
      }),
    );
    const peerBaseline = await nextActiveRouteAfter(
      reconnectedRoot,
      hostPrepare.revision,
    );
    const hostPeerBaseline = await nextActiveRouteAfter(
      host,
      hostPrepare.revision,
    );
    expect(peerBaseline.assignment.upstream).toEqual({
      kind: "peer",
      peerId: secondAuth.peerId,
    });
    expect(hostPeerBaseline.assignment).toMatchObject({
      childPeerIds: [secondAuth.peerId],
      sfuPublicationGeneration: null,
    });

    secondViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "after-sfu-root-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await reconnectedRoot.inbox.next("signal");
    reconnectedRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: peerBaseline.revision,
        phase: "active",
        connectionId: "after-sfu-root-connection",
      }),
    );
    const directAgain = await nextActiveRouteAfter(
      reconnectedRoot,
      peerBaseline.revision,
    );
    expect(directAgain.assignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "after-sfu-host-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await reconnectedRoot.inbox.next("signal");
    reconnectedRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: directAgain.revision,
        phase: "active",
        connectionId: "after-sfu-host-connection",
      }),
    );
    expect((await reconnectedRoot.inbox.next("error")).code).toBe("PEER_NOT_FOUND");
    expect(issued).toHaveLength(issuedBeforeFailback);

    host.socket.send(JSON.stringify({ type: "stop-sharing" }));
    await reconnectedRoot.inbox.next("sharing-stopped");
    const resumedHost = await openClient(harness.webSocketUrl);
    const resumedHostAuth = peerAssisted(
      await authenticate(resumedHost, harness.room, "host", "hybrid-host"),
    );
    expect(resumedHostAuth.routeAssignment).toMatchObject({
      upstream: { kind: "none" },
      sfuPublicationGeneration: null,
    });
    expect(resumedHostAuth.routeAssignment.childPeerIds).toHaveLength(2);

    const resumedFirstRoute = await nextActiveRouteRevision(
      reconnectedRoot,
      resumedHostAuth.routeRevision,
    );
    resumedHost.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "resumed-direct-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await reconnectedRoot.inbox.next("signal");
    reconnectedRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: resumedFirstRoute.revision,
        phase: "active",
        connectionId: "resumed-direct-connection",
      }),
    );
    const resumedReparent = await nextActiveRouteAfter(
      reconnectedRoot,
      resumedFirstRoute.revision,
    );
    secondViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "resumed-deep-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await reconnectedRoot.inbox.next("signal");
    reconnectedRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: resumedReparent.revision,
        phase: "active",
        connectionId: "resumed-deep-connection",
      }),
    );
    const resumedPrepare = await nextPreparedRoute(resumedHost);
    expect(await resumedHost.inbox.next("sfu-config")).toMatchObject({
      revision: resumedPrepare.revision,
    });
    expect(issued.length).toBeGreaterThan(issuedBeforeFailback);
  });

  it("falls through to selected TURN when SFU prepare is unavailable", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const direct = await failSingleViewerDirect(
      harness.webSocketUrl,
      harness.room,
      "selected-unavailable",
    );
    const [viewerGrant] = await Promise.all([
      direct.viewer.inbox.next("selected-edge-turn"),
      direct.host.inbox.next("selected-edge-turn"),
    ]);
    expect(viewerGrant.oldConnectionId).toBe(direct.oldConnectionId);
  });

  it("commits one healthy SFU root probe only after the peer edge is proven", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      maxRoots: 1,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-commit",
    );

    requestHealthyReselection(active.viewer, active.revision - 1);
    await expect(active.viewer.inbox.next("route-update", 40)).rejects.toThrow("Timed out");
    requestHealthyReselection(active.viewer, active.revision);
    const [rootPrepare, hostPrepare] = await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);
    expect(rootPrepare.assignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    expect(hostPrepare.assignment).toMatchObject({
      childPeerIds: [active.viewerAuth.peerId],
      sfuPublicationGeneration: null,
    });

    requestHealthyReselection(active.viewer, active.revision);
    active.viewer.socket.send(JSON.stringify({
      type: "route-ready",
      revision: rootPrepare.revision,
      phase: "prepare",
    }));
    await expect(active.viewer.inbox.next("route-update", 40)).rejects.toThrow("Timed out");

    const connectionId = "healthy-commit-probe";
    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "description",
        connectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    expect(await active.viewer.inbox.next("signal")).toMatchObject({
      fromPeerId: active.hostAuth.peerId,
      payload: { connectionId },
    });
    active.viewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.hostAuth.peerId,
      payload: {
        kind: "description",
        connectionId: `${connectionId}-stale`,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    expect((await active.viewer.inbox.next("error")).code).toBe("FORBIDDEN");
    active.viewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.hostAuth.peerId,
      payload: {
        kind: "description",
        connectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await active.host.inbox.next("signal");
    active.viewer.socket.send(JSON.stringify({
      type: "route-ready",
      revision: rootPrepare.revision,
      phase: "prepare",
    }));
    const [rootActive, hostActive] = await Promise.all([
      nextActiveRouteRevision(active.viewer, rootPrepare.revision),
      nextActiveRouteRevision(active.host, hostPrepare.revision),
    ]);
    expect(rootActive.assignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    expect(hostActive.assignment.sfuPublicationGeneration).toBeNull();

    active.viewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: rootActive.revision,
      phase: "active",
      connectionId,
    }));
    const [rootRecovery, hostRecovery] = await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);
    expect(rootRecovery.assignment.upstream).toEqual({ kind: "sfu" });
    expect(hostRecovery.assignment.sfuPublicationGeneration).toBeTruthy();
  });

  it("rolls back and reasserts one healthy ready after room cooldown", async () => {
    let now = 50_000;
    const reselections = vi.spyOn(
      HybridMediaRouter.prototype,
      "handleHealthySfuReselection",
    );
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      prepareTimeoutMs: 200,
      now: () => now,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-rollback",
    );
    requestHealthyReselection(active.viewer, active.revision);
    const [rootPrepare] = await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);
    const connectionId = "healthy-rollback-probe";
    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "description",
        connectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    await active.viewer.inbox.next("signal");
    active.viewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: rootPrepare.revision,
      phase: "prepare",
      connectionId,
    }));
    const [rootRollback, hostRollback] = await Promise.all([
      nextActiveRouteAfter(active.viewer, rootPrepare.revision),
      nextActiveRouteAfter(active.host, rootPrepare.revision),
    ]);
    expect(rootRollback.assignment.upstream).toEqual({ kind: "sfu" });
    expect(hostRollback.assignment.sfuPublicationGeneration).toBeTruthy();

    const router = reselections.mock.instances.at(-1) as
      | HybridMediaRouter
      | undefined;
    const currentViewer = harness.roomStore.getConnectedViewer(
      harness.room.roomId,
      active.viewerAuth.peerId,
    );
    expect(router).toBeDefined();
    expect(currentViewer).toBeDefined();
    const deferredState = (router as unknown as {
      deferredHealthySfuReselections: Map<
        string,
        { timer: NodeJS.Timeout | null }
      >;
    }).deferredHealthySfuReselections;
    vi.useFakeTimers();
    try {
      router!.handleHealthySfuReselection(
        {
          roomId: harness.room.roomId,
          role: "viewer",
          peerId: active.viewerAuth.peerId,
          sessionId: currentViewer!.sessionId,
        },
        rootRollback.revision,
      );
      const deferred = deferredState.get(harness.room.roomId);
      expect(deferred?.timer?.hasRef()).toBe(false);

      now += 30_001;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await active.viewer.inbox.next("route-update")).toMatchObject({
        revision: rootRollback.revision,
        phase: "active",
        assignment: { upstream: { kind: "sfu" } },
      });
    } finally {
      vi.useRealTimers();
      reselections.mockRestore();
    }

    // The real Viewer re-proves two fresh stats windows before this second ready.
    requestHealthyReselection(active.viewer, rootRollback.revision);
    const retried = await nextPreparedRoute(active.viewer);
    expect(retried.assignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const timedOut = await nextActiveRouteAfter(active.viewer, retried.revision);
    expect(timedOut.assignment.upstream).toEqual({ kind: "sfu" });

    router!.handleHealthySfuReselection(
      {
        roomId: harness.room.roomId,
        role: "viewer",
        peerId: active.viewerAuth.peerId,
        sessionId: currentViewer!.sessionId,
      },
      timedOut.revision,
    );
    expect(deferredState.has(harness.room.roomId)).toBe(true);
    active.host.socket.send(JSON.stringify({ type: "stop-sharing" }));
    await active.viewer.inbox.next("sharing-stopped");
    expect(deferredState.has(harness.room.roomId)).toBe(false);
  });

  it("does not swallow active SFU loss while a healthy probe is pending", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-active-loss",
    );
    requestHealthyReselection(active.viewer, active.revision);
    const pending = await nextPreparedRoute(active.viewer);
    await nextPreparedRoute(active.host);
    active.viewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: active.revision,
      phase: "active",
      connectionId: null,
    }));
    let recovered = await nextActiveRouteAfter(active.viewer, pending.revision);
    if (recovered.assignment.upstream.kind === "sfu") {
      recovered = await nextActiveRouteAfter(active.viewer, recovered.revision);
    }
    expect(recovered.assignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
  });

  it.each(["viewer", "host"] as const)(
    "aborts a healthy probe when the active %s SFU transport sends its prepare failure",
    async (failedRole) => {
      const harness = await startSfuHarness({
        tokenIssuer: {
          async issueToken({ peerId }) { return `token-${peerId}`; },
        },
      });
      const active = await activateSingleViewerSfu(
        harness.webSocketUrl,
        harness.room,
        `healthy-${failedRole}-prepare-loss`,
      );
      requestHealthyReselection(active.viewer, active.revision);
      const [rootPrepare, hostPrepare] = await Promise.all([
        nextPreparedRoute(active.viewer),
        nextPreparedRoute(active.host),
      ]);
      const failedClient = failedRole === "viewer" ? active.viewer : active.host;
      const failedPrepare = failedRole === "viewer" ? rootPrepare : hostPrepare;

      failedClient.socket.send(JSON.stringify({
        type: "route-failed",
        revision: active.revision,
        phase: "prepare",
        connectionId: null,
      }));
      await Promise.all([
        expect(
          active.viewer.inbox.next("route-update", 40),
        ).rejects.toThrow("Timed out"),
        expect(
          active.host.inbox.next("route-update", 40),
        ).rejects.toThrow("Timed out"),
      ]);

      failedClient.socket.send(JSON.stringify({
        type: "route-failed",
        revision: failedPrepare.revision,
        phase: "prepare",
        connectionId: null,
      }));
      const [rootRollback, hostRollback] = await Promise.all([
        nextActiveRouteAfter(active.viewer, failedPrepare.revision),
        nextActiveRouteAfter(active.host, failedPrepare.revision),
      ]);
      expect(rootRollback.assignment.upstream).toEqual({ kind: "sfu" });
      expect(hostRollback.assignment.sfuPublicationGeneration).toBeTruthy();

      failedClient.socket.send(JSON.stringify({
        type: "refresh-sfu",
        revision: rootRollback.revision,
      }));
      expect(await failedClient.inbox.next("sfu-config")).toMatchObject({
        revision: rootRollback.revision,
      });
    },
  );

  it("recovers when active selected Host ingress fails during healthy prepare", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken({ peerId }) { return `token-${peerId}`; },
      },
      selectedEdgeTurn: true,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-selected-host-loss",
    );
    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: active.revision,
      phase: "active",
      connectionId: null,
    }));
    const ingress = await active.host.inbox.next("selected-edge-turn");
    expect(ingress.edgeKind).toBe("host-sfu-ingress");
    active.host.socket.send(JSON.stringify({
      type: "route-ready",
      revision: active.revision,
      phase: "active",
    }));

    requestHealthyReselection(active.viewer, active.revision);
    const [rootPrepare, hostPrepare] = await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);
    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: active.revision,
      phase: "prepare",
      connectionId: ingress.newConnectionId,
    }));
    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: hostPrepare.revision,
      phase: "prepare",
      connectionId: `${ingress.newConnectionId}-wrong`,
    }));
    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    await Promise.all([
      expect(
        active.viewer.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        active.host.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
    ]);

    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: hostPrepare.revision,
      phase: "prepare",
      connectionId: ingress.newConnectionId,
    }));
    const [rootRollback, hostRollback] = await Promise.all([
      nextActiveRouteAfter(active.viewer, rootPrepare.revision),
      nextActiveRouteAfter(active.host, hostPrepare.revision),
    ]);
    expect(rootRollback.assignment.upstream).toEqual({ kind: "sfu" });
    expect(hostRollback.assignment.sfuPublicationGeneration).toBeTruthy();

    active.host.socket.send(JSON.stringify({
      type: "refresh-sfu",
      revision: hostRollback.revision,
    }));
    expect(await active.host.inbox.next("sfu-config")).toMatchObject({
      revision: hostRollback.revision,
    });
  });

  it("does not let a soft Host-parent probe swallow active SFU publication failure", async () => {
    let now = 205_000;
    const harness = await startSfuHarness({
      now: () => now,
      endpointMediaCopyCapacity: 3,
      tokenIssuer: {
        async issueToken({ peerId }) { return `token-${peerId}`; },
      },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "quality-host-sfu-loss",
    );
    const { child, childPrepare, current, hostPrepare, parentAuth } =
      await prepareSfuHostParentQualityProbe(
        harness,
        active,
        "quality_host_sfu_loss",
        () => { now += 2_000; },
      );

    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: current.revision,
      phase: "prepare",
      connectionId: null,
    }));
    await expect(child.inbox.next("route-update", 40)).rejects.toThrow(
      "Timed out",
    );

    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    const [childBaseline, firstHostRecovery] = await Promise.all([
      nextActiveRouteAfter(child, childPrepare.revision),
      nextActiveRouteAfter(active.host, hostPrepare.revision),
    ]);
    const hostBaseline = firstHostRecovery.assignment.sfuPublicationGeneration === null
      ? firstHostRecovery
      : await nextActiveRouteAfter(active.host, firstHostRecovery.revision);
    expect(childBaseline.assignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAuth.peerId,
    });
    expect(hostBaseline.assignment.sfuPublicationGeneration).toBeNull();
  });

  it("bounds selected ingress after active Host SFU failure during a soft probe", async () => {
    try {
      let now = 208_000;
      const harness = await startSfuHarness({
        now: () => now,
        endpointMediaCopyCapacity: 3,
        tokenIssuer: {
          async issueToken({ peerId }) { return `token-${peerId}`; },
        },
        selectedEdgeTurn: true,
      });
      const active = await activateSingleViewerSfu(
        harness.webSocketUrl,
        harness.room,
        "quality-host-selected-timeout",
      );
      const { child, childPrepare, hostPrepare, parentAuth } =
        await prepareSfuHostParentQualityProbe(
          harness,
          active,
          "quality_host_selected_timeout",
          () => { now += 2_000; },
        );

      vi.useFakeTimers();
      active.host.socket.send(JSON.stringify({
        type: "route-failed",
        revision: hostPrepare.revision,
        phase: "prepare",
        connectionId: null,
      }));
      const [childRollback, hostRollback, grant] = await Promise.all([
        nextActiveRouteAfter(child, childPrepare.revision),
        nextActiveRouteAfter(active.host, hostPrepare.revision),
        active.host.inbox.next("selected-edge-turn"),
      ]);
      expect(childRollback.assignment.upstream).toEqual({
        kind: "peer",
        peerId: parentAuth.peerId,
      });
      expect(hostRollback.revision).toBe(hostPrepare.revision + 1);
      expect(hostRollback.assignment.sfuPublicationGeneration).toBeTruthy();
      expect(grant).toMatchObject({
        edgeKind: "host-sfu-ingress",
        revision: hostRollback.revision,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(active.host.inbox.next("error")).resolves.toMatchObject({
        code: "PEER_NOT_FOUND",
        message: "Selected SFU relay ingress timed out",
      });
      await expect(
        nextActiveRouteAfter(active.host, hostRollback.revision),
      ).resolves.toMatchObject({
        revision: hostRollback.revision + 1,
        assignment: { sfuPublicationGeneration: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a soft Host-parent probe swallow active selected ingress failure", async () => {
    let now = 210_000;
    const harness = await startSfuHarness({
      now: () => now,
      endpointMediaCopyCapacity: 3,
      tokenIssuer: {
        async issueToken({ peerId }) { return `token-${peerId}`; },
      },
      selectedEdgeTurn: true,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "quality-selected-host-loss",
    );
    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: active.revision,
      phase: "active",
      connectionId: null,
    }));
    const ingress = await active.host.inbox.next("selected-edge-turn");
    active.host.socket.send(JSON.stringify({
      type: "route-ready",
      revision: active.revision,
      phase: "active",
    }));

    const { child, childPrepare, current, hostPrepare } =
      await prepareSfuHostParentQualityProbe(
        harness,
        active,
        "quality_selected_host",
        () => { now += 2_000; },
      );

    active.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: current.revision,
      phase: "active",
      connectionId: ingress.newConnectionId,
    }));
    const [childBaseline, firstHostRecovery] = await Promise.all([
      nextActiveRouteAfter(child, childPrepare.revision),
      nextActiveRouteAfter(active.host, hostPrepare.revision),
    ]);
    const hostBaseline = firstHostRecovery.assignment.sfuPublicationGeneration === null
      ? firstHostRecovery
      : await nextActiveRouteAfter(active.host, firstHostRecovery.revision);
    expect(childBaseline.assignment.upstream.kind).toBe("peer");
    expect(hostBaseline.assignment.sfuPublicationGeneration).toBeNull();
  });

  it("keeps ordinary intent when topology abort fills the overlap slot", async () => {
    const reselections = vi.spyOn(
      HybridMediaRouter.prototype,
      "handleHealthySfuReselection",
    );
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-no-slot",
    );
    requestHealthyReselection(active.viewer, active.revision);
    await nextPreparedRoute(active.viewer);
    await nextPreparedRoute(active.host);
    const leaf = await openClient(harness.webSocketUrl);
    const leafAuth = peerAssisted(await authenticate(
      leaf,
      harness.room,
      "viewer",
      "healthy-no-slot-leaf",
      0,
    ));
    expect(leafAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const rootActive = await nextActiveRouteRevision(
      active.viewer,
      leafAuth.routeRevision,
    );
    await nextActiveRouteRevision(active.host, leafAuth.routeRevision);
    const router = reselections.mock.instances.at(-1) as unknown as {
      viewerRouteIntentsByRoom: Map<string, Map<string, { sfuAttempts: number }>>;
    };
    const intent = router.viewerRouteIntentsByRoom
      .get(harness.room.roomId)
      ?.get(active.viewerAuth.peerId);
    expect(intent?.sfuAttempts).toBe(1);
    reselections.mockRestore();
    requestHealthyReselection(active.viewer, rootActive.revision);
    await expect(active.viewer.inbox.next("route-update", 40)).rejects.toThrow("Timed out");
    await expect(active.host.inbox.next("route-update", 40)).rejects.toThrow("Timed out");
  });

  it("keeps an SFU-fed Viewer leaf despite advertised relay capacity", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-relay-budget",
    );
    active.viewer.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 3,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const hostFiller = await openClient(harness.webSocketUrl);
    const hostFillerAuth = peerAssisted(await authenticate(
      hostFiller,
      harness.room,
      "viewer",
      "healthy-relay-budget-host-filler",
      0,
    ));
    expect(hostFillerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: active.hostAuth.peerId,
    });
    const rootChild = await openClient(harness.webSocketUrl);
    const rootChildAuth = peerAssisted(await authenticate(
      rootChild,
      harness.room,
      "viewer",
      "healthy-relay-budget-root-child",
      0,
    ));
    expect(rootChildAuth.routeAssignment.upstream).toEqual({ kind: "none" });
    const rootActive = await nextActiveRouteRevision(
      active.viewer,
      rootChildAuth.routeRevision,
    );
    expect(rootActive.assignment.childPeerIds).toEqual([]);
  });

  it("cleans a healthy probe across Viewer session replacement and stop", async () => {
    let now = 90_000;
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      now: () => now,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-session",
    );
    requestHealthyReselection(active.viewer, active.revision);
    const [oldPrepare] = await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);
    const oldClosed = new Promise<void>((resolve) =>
      active.viewer.socket.once("close", () => resolve()),
    );
    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(await authenticate(
      replacement,
      harness.room,
      "viewer",
      "healthy-session-viewer",
    ));
    await oldClosed;
    expect(replacementAuth.routeRevision).toBeGreaterThan(oldPrepare.revision);
    expect(replacementAuth.routeAssignment.upstream).toEqual({ kind: "sfu" });
    const hostRollback = await nextActiveRouteAfter(active.host, oldPrepare.revision);
    expect(hostRollback.assignment.sfuPublicationGeneration).toBeTruthy();

    replacement.socket.send(JSON.stringify({
      type: "route-ready",
      revision: oldPrepare.revision,
      phase: "prepare",
    }));
    requestHealthyReselection(replacement, replacementAuth.routeRevision);
    await expect(replacement.inbox.next("route-update", 40)).rejects.toThrow("Timed out");
    now += 30_001;
    requestHealthyReselection(replacement, replacementAuth.routeRevision);
    const replacementPrepare = await nextPreparedRoute(replacement);
    await nextPreparedRoute(active.host);

    active.host.socket.send(JSON.stringify({
      type: "stop-sharing",
      shareGeneration: "healthy-session-share",
    }));
    await replacement.inbox.next("sharing-stopped");
    replacement.socket.send(JSON.stringify({
      type: "route-ready",
      revision: replacementPrepare.revision,
      phase: "prepare",
    }));
    await expect(replacement.inbox.next("route-update", 40)).rejects.toThrow("Timed out");
  });

  it("keeps selected TURN exclusive with healthy probes until failure", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const direct = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "selected-host-parent",
    );
    expect(direct.hostAuth.iceConfig.iceServers).toEqual([]);
    direct.viewer.socket.send(JSON.stringify({
      type: "refresh-sfu",
      revision: direct.revision,
    }));
    await direct.viewer.inbox.next("sfu-config");
    direct.viewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: direct.revision,
      phase: "active",
      connectionId: null,
    }));
    const [viewerGrant, hostGrant] = await Promise.all([
      direct.viewer.inbox.next("selected-edge-turn"),
      direct.host.inbox.next("selected-edge-turn"),
    ]);
    expect(hostGrant).toEqual(viewerGrant);
    expect(viewerGrant).toMatchObject({
      revision: direct.revision,
      parentPeerId: direct.hostAuth.peerId,
      viewerPeerId: direct.viewerAuth.peerId,
      oldConnectionId: direct.oldConnectionId,
      iceServer: { urls: ["turn:turn.example.test:3478?transport=udp"] },
    });
    expect(viewerGrant.newConnectionId).not.toBe(direct.oldConnectionId);
    requestHealthyReselection(direct.viewer, direct.revision);
    await expect(
      direct.viewer.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    direct.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: direct.viewerAuth.peerId,
      payload: {
        kind: "description",
        connectionId: viewerGrant.newConnectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    expect(await direct.viewer.inbox.next("signal")).toMatchObject({
      fromPeerId: direct.hostAuth.peerId,
      payload: { connectionId: viewerGrant.newConnectionId },
    });
    direct.viewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: direct.hostAuth.peerId,
      payload: {
        kind: "description",
        connectionId: viewerGrant.newConnectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await direct.host.inbox.next("signal");
    requestHealthyReselection(direct.viewer, direct.revision);
    await expect(
      direct.viewer.inbox.next("route-update", 40),
    ).rejects.toThrow("Timed out");
    direct.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: direct.revision,
      phase: "active",
      connectionId: viewerGrant.newConnectionId,
    }));
    expect((await direct.host.inbox.next("error")).code).toBe("PEER_NOT_FOUND");
    await expect(
      direct.viewer.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
  });

  it("keeps a healthy probe exclusive when an SFU refresh token fails", async () => {
    let failRefresh = false;
    let failedRefreshes = 0;
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken({ peerId }) {
          if (failRefresh) {
            failedRefreshes += 1;
            throw new Error("refresh failed");
          }
          return `token-${peerId}`;
        },
      },
      selectedEdgeTurn: true,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "healthy-refresh-failure",
    );
    requestHealthyReselection(active.viewer, active.revision);
    await Promise.all([
      nextPreparedRoute(active.viewer),
      nextPreparedRoute(active.host),
    ]);

    failRefresh = true;
    active.viewer.socket.send(JSON.stringify({
      type: "refresh-sfu",
      revision: active.revision,
    }));
    await vi.waitFor(() => expect(failedRefreshes).toBe(1));
    await Promise.all([
      expect(
        active.viewer.inbox.next("selected-edge-turn", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        active.host.inbox.next("selected-edge-turn", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        active.viewer.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        active.host.inbox.next("route-update", 40),
      ).rejects.toThrow("Timed out"),
    ]);
  });

  it("admits only one pending peer-selected TURN attempt per room", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-room-pending-cap",
    );

    const firstGrant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );

    failPeerEdgeCandidate(
      peers.secondViewer,
      firstGrant.revision,
      peers.secondConnectionId,
    );
    await expect(
      peers.secondViewer.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
    await expect(
      peers.secondParent.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
  });

  it("keeps an answered peer-selected TURN edge inside the room cap", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-room-answered-cap",
    );

    const grant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );
    peers.firstParent.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: peers.firstAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    await peers.firstViewer.inbox.next("signal");
    peers.firstViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: peers.firstParentAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await peers.firstParent.inbox.next("signal");

    failPeerEdgeCandidate(
      peers.secondViewer,
      grant.revision,
      peers.secondConnectionId,
    );
    await expect(
      peers.secondViewer.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
    peers.firstParent.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: peers.firstAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: grant.newConnectionId,
        candidate: null,
      },
    }));
    await expect(peers.firstViewer.inbox.next("signal")).resolves.toMatchObject({
      payload: { connectionId: grant.newConnectionId },
    });
  });

  it("revokes a Host selected overlay before another child exceeds cap two", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const active = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "selected-host-overlay-budget",
    );
    const grant = await startPeerSelectedTurn(
      active.viewer,
      active.host,
      active.revision,
    );
    expect(grant.parentPeerId).toBe(active.hostAuth.peerId);
    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    await active.viewer.inbox.next("signal");
    active.viewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.hostAuth.peerId,
      payload: {
        kind: "description",
        connectionId: grant.newConnectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await active.host.inbox.next("signal");

    const sibling = await openClient(harness.webSocketUrl);
    const siblingAuth = peerAssisted(
      await authenticate(
        sibling,
        harness.room,
        "viewer",
        "selected-host-overlay-budget-sibling",
        0,
      ),
    );
    const [hostRoute, selectedViewerRoute] = await Promise.all([
      nextActiveRouteRevision(active.host, siblingAuth.routeRevision),
      nextActiveRouteRevision(active.viewer, siblingAuth.routeRevision),
    ]);
    expect(hostRoute.assignment.childPeerIds).toContain(siblingAuth.peerId);
    expect(hostRoute.assignment.sfuPublicationGeneration).not.toBeNull();
    expect(
      hostRoute.assignment.childPeerIds.length +
        (hostRoute.assignment.sfuPublicationGeneration ? 1 : 0),
    ).toBe(2);
    expect(selectedViewerRoute.assignment.upstream).toEqual({ kind: "sfu" });
    await Promise.all([
      expect(
        active.host.inbox.next("selected-edge-turn", 40),
      ).rejects.toThrow("Timed out"),
      expect(
        active.viewer.inbox.next("selected-edge-turn", 40),
      ).rejects.toThrow("Timed out"),
    ]);
    active.host.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: active.viewerAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: grant.newConnectionId,
        candidate: null,
      },
    }));
    expect((await active.host.inbox.next("error")).code).toBe("FORBIDDEN");
  });

  it("revokes a selected lease when its parent withdraws relay capacity", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-parent-capacity-withdrawal",
    );
    const firstGrant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );

    peers.firstParent.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 0,
    }));
    const [viewerAuthority, parentAuthority] = await Promise.all([
      nextActiveRouteRevision(peers.firstViewer, firstGrant.revision),
      nextActiveRouteRevision(peers.firstParent, firstGrant.revision),
    ]);
    expect(viewerAuthority).toMatchObject({
      revision: firstGrant.revision,
      phase: "active",
    });
    expect(parentAuthority).toMatchObject({
      revision: firstGrant.revision,
      phase: "active",
    });
    const secondGrant = await startPeerSelectedCandidate(
      peers.secondViewer,
      peers.secondParent,
      firstGrant.revision,
      peers.secondConnectionId,
    );
    expect(secondGrant).toMatchObject({
      edgeKind: "peer-selected",
      parentPeerId: peers.secondParentAuth.peerId,
      viewerPeerId: peers.secondAuth.peerId,
    });
  });

  it("releases the room cap after the selected edge fails", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-room-failure-release",
    );

    const firstGrant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );
    peers.firstViewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: firstGrant.revision,
      phase: "active",
      connectionId: firstGrant.newConnectionId,
    }));
    await peers.firstViewer.inbox.next("error");

    const secondGrant = await startPeerSelectedCandidate(
      peers.secondViewer,
      peers.secondParent,
      firstGrant.revision,
      peers.secondConnectionId,
    );
    expect(secondGrant).toMatchObject({
      edgeKind: "peer-selected",
      viewerPeerId: peers.secondAuth.peerId,
    });
  });

  it("releases the room cap when the selected Viewer disconnects", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
      viewerDisconnectGraceMs: 500,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-room-disconnect-release",
    );

    const firstGrant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );
    await closeClient(peers.firstViewer);
    peers.firstParent.socket.send(JSON.stringify({
      type: "relay-capacity",
      downstreamEdges: 0,
    }));

    const secondCurrent = await nextActiveRouteAfter(
      peers.secondViewer,
      firstGrant.revision,
    );
    const secondGrant = await startPeerSelectedCandidate(
      peers.secondViewer,
      peers.secondParent,
      secondCurrent.revision,
      peers.secondConnectionId,
    );
    expect(secondGrant).toMatchObject({
      edgeKind: "peer-selected",
      viewerPeerId: peers.secondAuth.peerId,
    });
  });

  it("releases a selected edge when its Viewer session is replaced", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken() { throw new Error("offline"); } },
      selectedEdgeTurn: true,
    });
    const peers = await prepareTwoSelectedPeerEdgeCandidates(
      harness.webSocketUrl,
      harness.room,
      "selected-viewer-session-replacement",
    );
    const firstGrant = await startPeerSelectedCandidate(
      peers.firstViewer,
      peers.firstParent,
      peers.revision,
      peers.firstConnectionId,
    );

    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(
      await authenticate(
        replacement,
        harness.room,
        "viewer",
        "selected-viewer-session-replacement-first-viewer",
        0,
      ),
    );
    expect(replacementAuth.peerId).toBe(peers.firstAuth.peerId);
    await nextActiveRouteRevision(
      peers.firstParent,
      replacementAuth.routeRevision,
    );

    const secondGrant = await startPeerSelectedCandidate(
      peers.secondViewer,
      peers.secondParent,
      replacementAuth.routeRevision,
      peers.secondConnectionId,
    );
    if (secondGrant.edgeKind !== "peer-selected") {
      throw new Error("Expected a selected peer edge grant");
    }
    expect(secondGrant.viewerPeerId).toBe(peers.secondAuth.peerId);
    expect(secondGrant.newConnectionId).not.toBe(firstGrant.newConnectionId);
  });

  it("allows selected TURN for Host SFU ingress outside historical room 1", async () => {
    const harness = await startSfuHarness({
      persistent: true,
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    expect(harness.room.roomId).toBe("2");
    const direct = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "selected-host-ingress-room-two",
    );

    direct.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: direct.revision,
      phase: "active",
      connectionId: null,
    }));
    await expect(direct.host.inbox.next("selected-edge-turn")).resolves.toMatchObject({
      edgeKind: "host-sfu-ingress",
      revision: direct.revision,
      hostPeerId: direct.hostAuth.peerId,
      publicationGeneration: expect.any(String),
      iceServer: { urls: ["turn:turn.example.test:3478?transport=udp"] },
    });
  });

  it("does not count Host SFU ingress against the peer-selected room cap", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const direct = await activateSingleViewerSfu(
      harness.webSocketUrl,
      harness.room,
      "selected-independent-ingress",
    );

    direct.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: direct.revision,
      phase: "active",
      connectionId: null,
    }));
    await expect(
      direct.host.inbox.next("selected-edge-turn"),
    ).resolves.toMatchObject({ edgeKind: "host-sfu-ingress" });

    await startPeerSelectedTurn(
      direct.viewer,
      direct.host,
      direct.revision,
    );
  });

  it("retries an initial Host SFU prepare through one selected ingress", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "selected-pending-ingress",
    );
    const publicationGeneration =
      prepared.hostPrepare.assignment.sfuPublicationGeneration;
    expect(publicationGeneration).toEqual(expect.any(String));

    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    const grant = await prepared.host.inbox.next("selected-edge-turn");
    expect(grant).toMatchObject({
      edgeKind: "host-sfu-ingress",
      revision: prepared.hostPrepare.revision,
      hostPeerId: prepared.hostAuth.peerId,
      publicationGeneration,
      oldConnectionId: publicationGeneration,
      newConnectionId: expect.any(String),
    });

    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    await expect(
      prepared.host.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");

    prepared.host.socket.send(JSON.stringify({
      type: "route-ready",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
    }));
    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    await expect(
      prepared.host.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");

    prepared.failedViewer.socket.send(JSON.stringify({
      type: "route-ready",
      revision: prepared.rootPrepare.revision,
      phase: "prepare",
    }));
    await expect(
      nextActiveRouteRevision(prepared.host, prepared.hostPrepare.revision),
    ).resolves.toMatchObject({
      assignment: { sfuPublicationGeneration: publicationGeneration },
    });
  });

  it("keeps the default prepare open for the initial LiveKit attempt", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startSfuHarness({
        tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
        selectedEdgeTurn: true,
      });
      const prepared = await prepareFallbackForTwoViewers(
        harness.webSocketUrl,
        harness.room,
        "selected-pending-deadline",
      );

      await vi.advanceTimersByTimeAsync(15_000);
      prepared.host.socket.send(JSON.stringify({
        type: "route-failed",
        revision: prepared.hostPrepare.revision,
        phase: "prepare",
        connectionId: null,
      }));

      await expect(
        prepared.host.inbox.next("selected-edge-turn"),
      ).resolves.toMatchObject({
        edgeKind: "host-sfu-ingress",
        revision: prepared.hostPrepare.revision,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the initial deadline with one relay timeout and rollback", async () => {
    vi.useFakeTimers();
    try {
      const harness = await startSfuHarness({
        tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
        selectedEdgeTurn: true,
        prepareTimeoutMs: 5_000,
      });
      const prepared = await prepareFallbackForTwoViewers(
        harness.webSocketUrl,
        harness.room,
        "selected-pending-relay-deadline",
      );
      prepared.host.socket.send(JSON.stringify({
        type: "route-failed",
        revision: prepared.hostPrepare.revision,
        phase: "prepare",
        connectionId: null,
      }));
      await prepared.host.inbox.next("selected-edge-turn");

      await vi.advanceTimersByTimeAsync(5_000);
      const noEarlyRollback = expect(
        prepared.host.inbox.next("route-update", 1),
      ).rejects.toThrow("Timed out");
      await vi.advanceTimersByTimeAsync(1);
      await noEarlyRollback;

      await vi.advanceTimersByTimeAsync(24_999);
      await expect(prepared.host.inbox.next("error")).resolves.toMatchObject({
        code: "PEER_NOT_FOUND",
        message: "Selected SFU relay ingress timed out",
      });
      await expect(
        nextActiveRouteAfter(
          prepared.host,
          prepared.hostPrepare.revision,
        ),
      ).resolves.toMatchObject({
        revision: prepared.hostPrepare.revision + 1,
        assignment: { sfuPublicationGeneration: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back when selected Host prepare ingress also fails", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "selected-pending-failure",
    );

    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: null,
    }));
    const grant = await prepared.host.inbox.next("selected-edge-turn");
    if (grant.edgeKind !== "host-sfu-ingress") {
      throw new Error("expected a Host SFU ingress grant");
    }
    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: grant.newConnectionId,
    }));

    await expect(prepared.host.inbox.next("error")).resolves.toMatchObject({
      code: "PEER_NOT_FOUND",
    });
    await expect(
      nextActiveRouteAfter(prepared.host, prepared.hostPrepare.revision),
    ).resolves.toMatchObject({
      revision: prepared.hostPrepare.revision + 1,
      assignment: { sfuPublicationGeneration: null },
    });
    prepared.host.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.hostPrepare.revision,
      phase: "prepare",
      connectionId: grant.newConnectionId,
    }));
    await expect(
      prepared.host.inbox.next("selected-edge-turn", 40),
    ).rejects.toThrow("Timed out");
  });

  it("carries a ViewerRelay selected edge across an unrelated revision", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: { async issueToken({ peerId }) { return `token-${peerId}`; } },
      selectedEdgeTurn: true,
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "selected-viewer-parent",
      "selected-viewer-parent-share",
    );
    for (const client of [prepared.host, prepared.failedViewer]) {
      client.socket.send(JSON.stringify({
        type: "route-ready",
        revision: prepared.rootPrepare.revision,
        phase: "prepare",
      }));
    }
    const [, , parentActive] = await Promise.all([
      nextActiveRouteRevision(prepared.host, prepared.hostPrepare.revision),
      nextActiveRouteRevision(prepared.failedViewer, prepared.rootPrepare.revision),
      nextActiveRouteRevision(prepared.rootViewer, prepared.rootPrepare.revision),
    ]);
    expect(parentActive.assignment.childPeerIds).toEqual([]);
    prepared.failedViewer.socket.send(JSON.stringify({
      type: "refresh-sfu",
      revision: prepared.rootPrepare.revision,
    }));
    await prepared.failedViewer.inbox.next("sfu-config");
    prepared.failedViewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: prepared.rootPrepare.revision,
      phase: "active",
      connectionId: null,
    }));
    const [childGrant, parentGrant] = await Promise.all([
      prepared.failedViewer.inbox.next("selected-edge-turn"),
      prepared.rootViewer.inbox.next("selected-edge-turn"),
    ]);
    expect(parentGrant).toEqual(childGrant);
    if (childGrant.edgeKind !== "peer-selected") {
      throw new Error("expected a peer-selected grant");
    }
    expect(childGrant.parentPeerId).toBe(prepared.rootAuth.peerId);
    prepared.rootViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.failedAuth.peerId,
      payload: {
        kind: "description",
        connectionId: childGrant.newConnectionId,
        description: { type: "offer", sdp: "v=0\r\n" },
      },
    }));
    await prepared.failedViewer.inbox.next("signal");
    prepared.rootViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.failedAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: childGrant.newConnectionId,
        candidate: { candidate: "parent-candidate" },
      },
    }));
    await prepared.failedViewer.inbox.next("signal");
    prepared.failedViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.rootAuth.peerId,
      payload: {
        kind: "description",
        connectionId: childGrant.newConnectionId,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    }));
    await prepared.rootViewer.inbox.next("signal");
    prepared.failedViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.rootAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: childGrant.newConnectionId,
        candidate: null,
      },
    }));
    await prepared.rootViewer.inbox.next("signal");
    const parentAuthorityOrder: Array<{
      type: "selected-edge-turn" | "route-update";
      revision: number;
    }> = [];
    prepared.rootViewer.socket.on("message", (data) => {
      const message = decodeServerMessage(data.toString());
      if (
        (message.type === "selected-edge-turn" &&
          message.edgeKind === "peer-selected" &&
          message.newConnectionId === childGrant.newConnectionId) ||
        (message.type === "route-update" && message.phase === "active")
      ) {
        parentAuthorityOrder.push({
          type: message.type,
          revision: message.revision,
        });
      }
    });
    const expectCarryBeforeRoute = (revision: number): void => {
      const events = parentAuthorityOrder.filter(
        (event) => event.revision === revision,
      );
      expect(events.length).toBeGreaterThan(0);
      expect(events.length % 2).toBe(0);
      for (let index = 0; index < events.length; index += 2) {
        expect(events[index]).toEqual({
          type: "selected-edge-turn",
          revision,
        });
        expect(events[index + 1]).toEqual({ type: "route-update", revision });
      }
    };
    const unrelatedViewer = await openClient(harness.webSocketUrl);
    const unrelatedViewerAuth = peerAssisted(
      await authenticate(
        unrelatedViewer,
        harness.room,
        "viewer",
        "selected-viewer-parent-unrelated-client",
        0,
      ),
    );
    expect(unrelatedViewerAuth.routeRevision).toBeGreaterThan(
      childGrant.revision,
    );
    const parentAfterUnrelatedJoin = await nextActiveRouteRevision(
      prepared.rootViewer,
      unrelatedViewerAuth.routeRevision,
    );
    expect(parentAfterUnrelatedJoin.revision).toBeGreaterThan(
      childGrant.revision,
    );
    const [childCarry, parentCarry] = await Promise.all([
      prepared.failedViewer.inbox.next("selected-edge-turn"),
      prepared.rootViewer.inbox.next("selected-edge-turn"),
    ]);
    expect(parentCarry).toEqual(childCarry);
    expect(childCarry).toMatchObject({
      revision: parentAfterUnrelatedJoin.revision,
      parentPeerId: childGrant.parentPeerId,
      viewerPeerId: childGrant.viewerPeerId,
      oldConnectionId: childGrant.oldConnectionId,
      newConnectionId: childGrant.newConnectionId,
      iceServer: childGrant.iceServer,
    });
    expectCarryBeforeRoute(parentAfterUnrelatedJoin.revision);
    parentAuthorityOrder.length = 0;
    const replacementSibling = await openClient(harness.webSocketUrl);
    const replacementSiblingAuth = peerAssisted(
      await authenticate(
        replacementSibling,
        harness.room,
        "viewer",
        "selected-viewer-parent-root-sibling-client",
        0,
      ),
    );
    let sameRevisionCarry;
    do {
      sameRevisionCarry = await prepared.rootViewer.inbox.next(
        "selected-edge-turn",
      );
    } while (sameRevisionCarry.revision !== replacementSiblingAuth.routeRevision);
    expect(sameRevisionCarry.newConnectionId).toBe(childGrant.newConnectionId);
    await nextActiveRouteRevision(
      prepared.rootViewer,
      replacementSiblingAuth.routeRevision,
    );
    expectCarryBeforeRoute(replacementSiblingAuth.routeRevision);
    prepared.rootViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.failedAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: childGrant.newConnectionId,
        candidate: { candidate: "candidate-after-sibling-reconnect" },
      },
    }));
    expect(await prepared.failedViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: prepared.rootAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: childGrant.newConnectionId,
        candidate: { candidate: "candidate-after-sibling-reconnect" },
      },
    });
    prepared.rootViewer.socket.send(JSON.stringify({
      type: "route-failed",
      revision: replacementSiblingAuth.routeRevision,
      phase: "active",
      connectionId: childGrant.newConnectionId,
    }));
    await expect(prepared.rootViewer.inbox.next("error")).resolves.toMatchObject({
      code: "PEER_NOT_FOUND",
      message: "Selected relay edge failed",
    });
    prepared.rootViewer.socket.send(JSON.stringify({
      type: "signal",
      targetPeerId: prepared.failedAuth.peerId,
      payload: {
        kind: "candidate",
        connectionId: childGrant.newConnectionId,
        candidate: null,
      },
    }));
    expect((await prepared.rootViewer.inbox.next("error")).code).toBe("FORBIDDEN");
  });

  it("moves both a failed deep viewer and its host branch within two SFU roots", async () => {
    const issued: Array<Parameters<SfuTokenIssuer["issueToken"]>[0]> = [];
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          issued.push(request);
          return `token-${request.peerId}`;
        },
      },
    });
    const peers = await exhaustDeepViewerPeerRoutes(
      harness.webSocketUrl,
      harness.room,
      "deep-budget",
    );

    const hostPrepare = await nextPreparedRoute(peers.host);
    const branchPrepare = await nextPreparedRoute(peers.secondRoot);
    const failedPrepare = await nextPreparedRoute(peers.failedViewer);
    expect(branchPrepare.revision).toBe(hostPrepare.revision);
    expect(failedPrepare.revision).toBe(hostPrepare.revision);
    expect(hostPrepare.assignment.childPeerIds).toEqual([
      peers.firstRootAuth.peerId,
    ]);
    expect(branchPrepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(failedPrepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(
      new Set(issued.map(({ peerId }) => peerId)),
    ).toEqual(
      new Set([
        peers.hostAuth.peerId,
        peers.secondRootAuth.peerId,
        peers.failedAuth.peerId,
      ]),
    );
  });

  it("fails a deep SFU fallback cleanly when its root budget is one", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
      maxRoots: 1,
    });
    const peers = await exhaustDeepViewerPeerRoutes(
      harness.webSocketUrl,
      harness.room,
      "deep-limited",
    );

    expect((await peers.failedViewer.inbox.next("error")).code).toBe(
      "PEER_NOT_FOUND",
    );
    await expect(nextPreparedRoute(peers.host)).rejects.toThrow("Timed out");
    expect(peers.host.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("admits a leaf with no peer slot through a selective SFU route", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
    });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "admission-host");
    const firstLeaf = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        firstLeaf,
        harness.room,
        "viewer",
        "admission-leaf-a",
        0,
      ),
    );
    const secondLeaf = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        secondLeaf,
        harness.room,
        "viewer",
        "admission-leaf-b",
        0,
      ),
    );
    const pendingLeaf = await openClient(harness.webSocketUrl);
    const pendingAuth = peerAssisted(
      await authenticate(
        pendingLeaf,
        harness.room,
        "viewer",
        "admission-leaf-c",
        0,
      ),
    );
    expect(pendingAuth.routeAssignment.upstream).toEqual({ kind: "none" });

    const hostPrepare = await nextPreparedRoute(host);
    const budgetPrepare = await nextPreparedRoute(firstLeaf);
    const pendingPrepare = await nextPreparedRoute(pendingLeaf);
    expect(hostPrepare.assignment.childPeerIds).toEqual([secondAuth.peerId]);
    expect(budgetPrepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(pendingPrepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(await firstLeaf.inbox.next("sfu-config")).toMatchObject({
      token: `token-${firstAuth.peerId}`,
    });
    expect(await pendingLeaf.inbox.next("sfu-config")).toMatchObject({
      token: `token-${pendingAuth.peerId}`,
    });
  });

  it("uses a free direct slot beside an active SFU publication", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
      selectedEdgeTurn: true,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "active-slot-host"),
    );
    const root = await openClient(harness.webSocketUrl);
    const rootAuth = peerAssisted(
      await authenticate(root, harness.room, "viewer", "active-slot-root", 0),
    );
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: rootAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "active-slot-failed-edge",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await root.inbox.next("signal");
    root.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: rootAuth.routeRevision,
        phase: "active",
        connectionId: "active-slot-failed-edge",
      }),
    );
    const hostPrepare = await nextPreparedRoute(host);
    const rootPrepare = await nextPreparedRoute(root);
    await host.inbox.next("sfu-config");
    await root.inbox.next("sfu-config");
    host.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: hostPrepare.revision,
        phase: "prepare",
      }),
    );
    root.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: rootPrepare.revision,
        phase: "prepare",
      }),
    );
    await nextActiveRouteAfter(host, hostPrepare.revision - 1);

    const directViewer = await openClient(harness.webSocketUrl);
    const directAuth = peerAssisted(
      await authenticate(
        directViewer,
        harness.room,
        "viewer",
        "active-slot-direct",
        0,
      ),
    );
    expect(directAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
    expect(directAuth.routeAssignment.sfuPublicationGeneration).toBeNull();
    root.socket.send(JSON.stringify({
      type: "refresh-sfu",
      revision: directAuth.routeRevision,
    }));
    await root.inbox.next("sfu-config");
    root.socket.send(JSON.stringify({
      type: "route-failed",
      revision: directAuth.routeRevision,
      phase: "active",
      connectionId: null,
    }));
    await expect(root.inbox.next("selected-edge-turn", 40)).rejects.toThrow(
      "Timed out",
    );
  });

  it("retires an SFU publication when its root allowlist shrinks", async () => {
    const issued: Array<Parameters<SfuTokenIssuer["issueToken"]>[0]> = [];
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          issued.push(request);
          return `token-${request.peerId}`;
        },
      },
    });
    const peers = await exhaustDeepViewerPeerRoutes(
      harness.webSocketUrl,
      harness.room,
      "shrink-roots",
    );
    const hostPrepare = await nextPreparedRoute(peers.host);
    const branchPrepare = await nextPreparedRoute(peers.secondRoot);
    const failedPrepare = await nextPreparedRoute(peers.failedViewer);
    await peers.host.inbox.next("sfu-config");
    await peers.secondRoot.inbox.next("sfu-config");
    await peers.failedViewer.inbox.next("sfu-config");
    for (const [client, revision] of [
      [peers.host, hostPrepare.revision],
      [peers.secondRoot, branchPrepare.revision],
      [peers.failedViewer, failedPrepare.revision],
    ] as const) {
      client.socket.send(
        JSON.stringify({ type: "route-ready", revision, phase: "prepare" }),
      );
    }
    const hostActive = await nextActiveRouteAfter(
      peers.host,
      hostPrepare.revision - 1,
    );
    await nextActiveRouteAfter(
      peers.secondRoot,
      branchPrepare.revision - 1,
    );
    expect(hostActive.assignment.sfuPublicationGeneration).toBeTruthy();
    expect(issued).toHaveLength(3);

    await closeClient(peers.failedViewer);
    const retiredHost = await nextActiveRouteAfter(
      peers.host,
      hostActive.revision,
    );
    const retiredRoot = await nextActiveRouteAfter(
      peers.secondRoot,
      hostActive.revision,
    );
    expect(retiredHost.assignment.sfuPublicationGeneration).toBeNull();
    expect(retiredRoot.assignment).toMatchObject({
      upstream: { kind: "peer", peerId: peers.hostAuth.peerId },
      sfuPublicationGeneration: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(issued).toHaveLength(3);
  });

  it("separates host signaling reconnects from new sharing generations", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "share-generation",
      "share-gen-a",
    );
    prepared.host.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: prepared.hostPrepare.revision,
        phase: "prepare",
      }),
    );
    prepared.failedViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: prepared.rootPrepare.revision,
        phase: "prepare",
      }),
    );
    const active = await nextActiveRouteRevision(
      prepared.failedViewer,
      prepared.rootPrepare.revision,
    );
    expect(active.assignment.upstream).toEqual({ kind: "sfu" });

    const sameShareHost = await openClient(harness.webSocketUrl);
    const sameShareAuth = peerAssisted(
      await authenticate(
        sameShareHost,
        harness.room,
        "host",
        "share-generation-host-client",
        1,
        "share-gen-a",
      ).catch((error: unknown) => {
        throw new Error("same-generation authentication failed", {
          cause: error,
        });
      }),
    );
    expect(sameShareAuth.routeRevision).toBe(active.revision);
    expect(sameShareAuth.routeAssignment.sfuPublicationGeneration).toBeTruthy();
    await expect(
      prepared.failedViewer.inbox.next("sharing-stopped", 30),
    ).rejects.toThrow("Timed out");

    const nextShareHost = await openClient(harness.webSocketUrl);
    const nextShareAuth = peerAssisted(
      await authenticate(
        nextShareHost,
        harness.room,
        "host",
        "share-generation-host-client",
        1,
        "share-gen-b",
      ).catch((error: unknown) => {
        throw new Error("new-generation authentication failed", {
          cause: error,
        });
      }),
    );
    await prepared.failedViewer.inbox.next("sharing-stopped");
    expect(nextShareAuth.routeRevision).toBeLessThanOrEqual(active.revision);
    expect(nextShareAuth.routeAssignment.sfuPublicationGeneration).toBeNull();

    const staleStopClosed = new Promise<number>((resolve) =>
      nextShareHost.socket.once("close", (code) => resolve(code)),
    );
    nextShareHost.socket.send(
      JSON.stringify({
        type: "stop-sharing",
        shareGeneration: "share-gen-a",
      }),
    );
    expect(await staleStopClosed).toBe(4001);
    await expect(
      prepared.failedViewer.inbox.next("sharing-stopped", 30),
    ).rejects.toThrow("Timed out");

    const resumedSameShare = await openClient(harness.webSocketUrl);
    const resumedAuth = peerAssisted(
      await authenticate(
        resumedSameShare,
        harness.room,
        "host",
        "share-generation-host-client",
        1,
        "share-gen-b",
      ).catch((error: unknown) => {
        throw new Error("resumed-generation authentication failed", {
          cause: error,
        });
      }),
    );
    expect(resumedAuth.routeRevision).toBe(nextShareAuth.routeRevision);
  });

  it("replans a pending fallback after unrelated topology churn", async () => {
    const generations: string[] = [];
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          generations.push(request.publicationGeneration);
          return `token-${request.peerId}`;
        },
      },
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "topology-churn",
    );
    const extraViewer = await openClient(harness.webSocketUrl);
    await authenticate(
      extraViewer,
      harness.room,
      "viewer",
      "topology-churn-extra",
      0,
    );

    let rollbackRevision: number | undefined;
    let retriedPrepareRevision: number | undefined;
    while (
      rollbackRevision === undefined ||
      retriedPrepareRevision === undefined
    ) {
      const message = await prepared.host.inbox.next("route-update");
      if (
        message.phase === "active" &&
        message.revision > prepared.hostPrepare.revision
      ) {
        rollbackRevision = message.revision;
      }
      if (message.phase === "prepare") {
        retriedPrepareRevision = message.revision;
      }
    }
    expect(retriedPrepareRevision).toBeGreaterThan(rollbackRevision);
    expect(new Set(generations).size).toBe(2);
  });

  it("keeps a prepared fallback when an unrelated viewer disconnects", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
      viewerDisconnectGraceMs: 500,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "unrelated-close-host"),
    );
    const parentA = await openClient(harness.webSocketUrl);
    const parentAAuth = peerAssisted(
      await authenticate(parentA, harness.room, "viewer", "unrelated-parent-a"),
    );
    const parentB = await openClient(harness.webSocketUrl);
    await authenticate(parentB, harness.room, "viewer", "unrelated-parent-b");
    const failedViewer = await openClient(harness.webSocketUrl);
    const failedAuth = peerAssisted(
      await authenticate(
        failedViewer,
        harness.room,
        "viewer",
        "unrelated-failed",
      ),
    );
    const unrelatedViewer = await openClient(harness.webSocketUrl);
    const unrelatedAuth = peerAssisted(
      await authenticate(
        unrelatedViewer,
        harness.room,
        "viewer",
        "unrelated-disconnected",
        0,
      ),
    );
    expect(failedAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAAuth.peerId,
    });

    parentA.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: failedAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "unrelated-close-failed-edge",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await failedViewer.inbox.next("signal");
    failedViewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: unrelatedAuth.routeRevision,
        phase: "active",
        connectionId: "unrelated-close-failed-edge",
      }),
    );
    const hostPrepare = await nextPreparedRoute(host).catch((error: unknown) => {
      throw new Error("host did not receive unrelated-close prepare", {
        cause: error,
      });
    });
    const failedPrepare = await nextPreparedRoute(failedViewer).catch(
      (error: unknown) => {
        throw new Error("failed viewer did not receive unrelated-close prepare", {
          cause: error,
        });
      },
    );
    const parentPrepare = await nextPreparedRoute(parentA);
    await host.inbox.next("sfu-config");
    await failedViewer.inbox.next("sfu-config");
    await parentA.inbox.next("sfu-config");

    await closeClient(unrelatedViewer);
    host.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: hostPrepare.revision,
        phase: "prepare",
      }),
    );
    failedViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: failedPrepare.revision,
        phase: "prepare",
      }),
    );
    parentA.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: parentPrepare.revision,
        phase: "prepare",
      }),
    );
    const committed = await nextActiveRouteRevision(
      host,
      hostPrepare.revision,
    ).catch((error: unknown) => {
      throw new Error("unrelated close aborted the prepared route", {
        cause: error,
      });
    });
    expect(committed.assignment).toMatchObject({
      upstream: { kind: "none" },
      sfuPublicationGeneration: expect.any(String),
    });
    expect(committed.assignment.childPeerIds.length).toBeLessThanOrEqual(1);
    expect(hostAuth.peerId).toBeTruthy();
  });

  it("rolls back SFU prepare on timeout and expected-session replacement", async () => {
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          return `token-${request.peerId}`;
        },
      },
      prepareTimeoutMs: 120,
    });
    const timedOut = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "timeout",
    );
    const timedOutRollback = await nextActiveRouteAfter(
      timedOut.host,
      timedOut.hostPrepare.revision,
    );
    expect(timedOutRollback).toMatchObject({
      revision: timedOut.hostPrepare.revision + 1,
      assignment: {
        upstream: { kind: "none" },
        childPeerIds: [timedOut.rootAuth.peerId],
        sfuPublicationGeneration: null,
      },
    });

    const replacementRoom = harness.roomStore.createRoom();
    const replacing = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      replacementRoom,
      "replacement",
    );
    const replacementRoot = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(
      await authenticate(
        replacementRoot,
        replacementRoom,
        "viewer",
        "replacement-failed-client",
      ),
    );
    expect(replacementAuth).toMatchObject({
      peerId: replacing.failedAuth.peerId,
      routeRevision: replacing.hostPrepare.revision + 1,
      routeAssignment: {
        upstream: { kind: "peer", peerId: replacing.rootAuth.peerId },
        sfuPublicationGeneration: null,
      },
    });
    const replacementRollback = await nextActiveRouteAfter(
      replacing.host,
      replacing.hostPrepare.revision,
    );
    expect(replacementRollback.revision).toBe(
      replacing.hostPrepare.revision + 1,
    );

    replacing.rootViewer.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: replacementAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "replacement-reported-again",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await replacementRoot.inbox.next("signal");
    replacementRoot.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: replacementAuth.routeRevision,
        phase: "active",
        connectionId: "replacement-reported-again",
      }),
    );
    const replacementRecovered = await nextActiveRouteAfter(
      replacementRoot,
      replacementAuth.routeRevision,
    );
    expect(replacementRecovered.assignment.upstream).toEqual({
      kind: "peer",
      peerId: replacing.hostAuth.peerId,
    });

    replacing.failedViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: replacing.hostPrepare.revision,
        phase: "prepare",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replacementRoot.socket.readyState).toBe(WebSocket.OPEN);

    const prepareFailureRoom = harness.roomStore.createRoom();
    const prepareFailure = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      prepareFailureRoom,
      "prepare-failure",
    );
    prepareFailure.failedViewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: prepareFailure.rootPrepare.revision,
        phase: "prepare",
        connectionId: null,
      }),
    );
    const failedPrepareRollback = await nextActiveRouteAfter(
      prepareFailure.host,
      prepareFailure.hostPrepare.revision,
    );
    expect(failedPrepareRollback.revision).toBe(
      prepareFailure.hostPrepare.revision + 1,
    );
    expect(failedPrepareRollback.assignment).toMatchObject({
      childPeerIds: [prepareFailure.rootAuth.peerId],
      sfuPublicationGeneration: null,
    });
  });

  it("fails back to peer routes when an active SFU token refresh fails", async () => {
    let rejectTokens = false;
    const harness = await startSfuHarness({
      tokenIssuer: {
        async issueToken(request) {
          if (rejectTokens) {
            throw new Error("issuer unavailable");
          }
          return `token-${request.peerId}`;
        },
      },
    });
    const prepared = await prepareFallbackForTwoViewers(
      harness.webSocketUrl,
      harness.room,
      "refresh-failure",
    );
    prepared.host.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: prepared.hostPrepare.revision,
        phase: "prepare",
      }),
    );
    prepared.failedViewer.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: prepared.rootPrepare.revision,
        phase: "prepare",
      }),
    );
    await nextActiveRouteAfter(
      prepared.host,
      prepared.hostPrepare.revision - 1,
    );
    await nextActiveRouteAfter(
      prepared.failedViewer,
      prepared.rootPrepare.revision - 1,
    );

    rejectTokens = true;
    prepared.failedViewer.socket.send(
      JSON.stringify({
        type: "refresh-sfu",
        revision: prepared.rootPrepare.revision,
      }),
    );
    const rollback = await nextActiveRouteAfter(
      prepared.host,
      prepared.hostPrepare.revision,
    );
    expect(rollback).toMatchObject({
      revision: prepared.hostPrepare.revision + 1,
      assignment: {
        childPeerIds: [prepared.rootAuth.peerId],
        sfuPublicationGeneration: null,
      },
    });
  });

  it("keeps route revisions monotonic when a disconnected host is replaced", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const firstHost = await openClient(harness.webSocketUrl);
    const firstHostAuth = peerAssisted(
      await authenticate(firstHost, harness.room, "host", "takeover-host-a"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(viewer, harness.room, "viewer", "takeover-viewer-a"),
    );
    const secondViewer = await openClient(harness.webSocketUrl);
    await authenticate(
      secondViewer,
      harness.room,
      "viewer",
      "takeover-viewer-b",
    );
    const previousRoute = await nextActiveRouteAfter(
      viewer,
      viewerAuth.routeRevision,
    );

    await closeClient(firstHost);
    await viewer.inbox.next("host-status");
    const replacementHost = await openClient(harness.webSocketUrl);
    const replacementAuth = peerAssisted(
      await authenticate(
        replacementHost,
        harness.room,
        "host",
        "takeover-host-b",
      ),
    );
    expect(replacementAuth.peerId).not.toBe(firstHostAuth.peerId);
    expect(replacementAuth.routeRevision).toBeGreaterThan(
      previousRoute.revision,
    );
    const viewerRoute = await nextActiveRouteAfter(
      viewer,
      previousRoute.revision,
    );
    expect(viewerRoute).toMatchObject({
      revision: replacementAuth.routeRevision,
      assignment: {
        upstream: { kind: "peer", peerId: replacementAuth.peerId },
      },
    });
  });

  it("keeps relay assignments through grace and reattaches only the direct child subtree", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      viewerDisconnectGraceMs: 200,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "relay-grace-host"),
    );

    const firstViewer = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        firstViewer,
        harness.room,
        "viewer",
        "relay-grace-a",
      ),
    );
    await host.inbox.next("media-assignment");

    const secondViewer = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        secondViewer,
        harness.room,
        "viewer",
        "relay-grace-b",
      ),
    );
    await host.inbox.next("media-assignment");

    const thirdViewer = await openClient(harness.webSocketUrl);
    const thirdAuth = peerAssisted(
      await authenticate(
        thirdViewer,
        harness.room,
        "viewer",
        "relay-grace-c",
      ),
    );
    await firstViewer.inbox.next("media-assignment");

    const fourthViewer = await openClient(harness.webSocketUrl);
    await authenticate(
      fourthViewer,
      harness.room,
      "viewer",
      "relay-grace-d",
    );
    await secondViewer.inbox.next("media-assignment");

    const fifthViewer = await openClient(harness.webSocketUrl);
    const fifthAuth = peerAssisted(
      await authenticate(
        fifthViewer,
        harness.room,
        "viewer",
        "relay-grace-e",
      ),
    );
    const thirdWithChild = await thirdViewer.inbox.next("media-assignment");
    expect(thirdWithChild.mediaAssignment).toEqual({
      parentPeerId: firstAuth.peerId,
      childPeerIds: [fifthAuth.peerId],
    });

    host.inbox.ignore("route-update");
    thirdViewer.inbox.ignore("route-update");
    await closeClient(firstViewer);
    await host.inbox.expectNone(30);
    await thirdViewer.inbox.expectNone(30);

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "offer-while-child-offline",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await host.inbox.expectNone(30);

    const reconnectedFirstViewer = await openClient(harness.webSocketUrl);
    const reconnectedFirstAuth = peerAssisted(
      await authenticate(
        reconnectedFirstViewer,
        harness.room,
        "viewer",
        "relay-grace-a",
      ),
    );
    expect(reconnectedFirstAuth).toMatchObject({
      peerId: firstAuth.peerId,
      connectionId: null,
      mediaAssignment: {
        parentPeerId: hostAuth.peerId,
        childPeerIds: [thirdAuth.peerId],
      },
    });
    expect(
      (await host.inbox.next("media-assignment", 500)).mediaAssignment,
    ).toEqual({
      parentPeerId: null,
      childPeerIds: [firstAuth.peerId, secondAuth.peerId],
    });
    await closeClient(reconnectedFirstViewer);

    expect(
      (await host.inbox.next("media-assignment", 500)).mediaAssignment,
    ).toEqual({
      parentPeerId: null,
      childPeerIds: [secondAuth.peerId, thirdAuth.peerId],
    });
    expect(
      (await thirdViewer.inbox.next("media-assignment", 500)).mediaAssignment,
    ).toEqual({
      parentPeerId: hostAuth.peerId,
      childPeerIds: [fifthAuth.peerId],
    });
    fifthViewer.inbox.ignore("route-update");
    await fifthViewer.inbox.expectNone(30);
  });

  it("reattaches a subtree root that reconnects after its parent expires", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      viewerDisconnectGraceMs: 200,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "relay-offline-host"),
    );
    const firstViewer = await openClient(harness.webSocketUrl);
    const firstAuth = peerAssisted(
      await authenticate(
        firstViewer,
        harness.room,
        "viewer",
        "relay-offline-a",
      ),
    );
    await host.inbox.next("media-assignment");
    const secondViewer = await openClient(harness.webSocketUrl);
    const secondAuth = peerAssisted(
      await authenticate(
        secondViewer,
        harness.room,
        "viewer",
        "relay-offline-b",
      ),
    );
    await host.inbox.next("media-assignment");
    const subtreeRoot = await openClient(harness.webSocketUrl);
    const subtreeRootAuth = peerAssisted(
      await authenticate(
        subtreeRoot,
        harness.room,
        "viewer",
        "relay-offline-c",
      ),
    );
    expect(subtreeRootAuth.mediaAssignment.parentPeerId).toBe(firstAuth.peerId);
    await firstViewer.inbox.next("media-assignment");

    await closeClient(firstViewer);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await closeClient(subtreeRoot);

    expect(
      (await host.inbox.next("media-assignment", 500)).mediaAssignment,
    ).toEqual({
      parentPeerId: null,
      childPeerIds: [secondAuth.peerId],
    });

    const reconnectedSubtreeRoot = await openClient(harness.webSocketUrl);
    const reconnectedAuth = peerAssisted(
      await authenticate(
        reconnectedSubtreeRoot,
        harness.room,
        "viewer",
        "relay-offline-c",
      ),
    );
    expect(reconnectedAuth).toMatchObject({
      peerId: subtreeRootAuth.peerId,
      connectionId: null,
      mediaAssignment: {
        parentPeerId: hostAuth.peerId,
        childPeerIds: [],
      },
    });
    expect(
      (await host.inbox.next("media-assignment", 500)).mediaAssignment,
    ).toEqual({
      parentPeerId: null,
      childPeerIds: [secondAuth.peerId, subtreeRootAuth.peerId],
    });
  });

  it("retains peer relay assignments but clears connection generations when sharing stops", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      viewerDisconnectGraceMs: 500,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "relay-stop-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "relay-stop-viewer",
      ),
    );
    await host.inbox.next("media-assignment");

    host.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: lowQualitySettings,
      }),
    );
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: lowQualitySettings,
    });

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "connection-before-relay-stop",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    const stoppedHostClosed = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(JSON.stringify({ type: "stop-sharing" }));
    await viewer.inbox.next("sharing-stopped");
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: false,
    });
    expect(await stoppedHostClosed).toBe(1000);

    await closeClient(viewer);
    const reconnectedViewer = await openClient(harness.webSocketUrl);
    const reconnectedViewerAuth = peerAssisted(
      await authenticate(
        reconnectedViewer,
        harness.room,
        "viewer",
        "relay-stop-viewer",
      ),
    );
    expect(reconnectedViewerAuth).toMatchObject({
      peerId: viewerAuth.peerId,
      connectionId: null,
      mediaAssignment: {
        parentPeerId: hostAuth.peerId,
        childPeerIds: [],
      },
      qualitySettings: lowQualitySettings,
    });

    const resumedHost = await openClient(harness.webSocketUrl);
    const resumedHostAuth = peerAssisted(
      await authenticate(
        resumedHost,
        harness.room,
        "host",
        "relay-stop-host",
      ),
    );
    expect(resumedHostAuth).toMatchObject({
      peerId: hostAuth.peerId,
      mediaAssignment: {
        parentPeerId: null,
        childPeerIds: [viewerAuth.peerId],
      },
      qualitySettings: lowQualitySettings,
    });
    expect(await reconnectedViewer.inbox.next("host-status")).toMatchObject({
      online: true,
    });
  });

  it("keeps a viewer peer stable when it reconnects inside the grace period", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 80 });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    const firstViewer = await openClient(harness.webSocketUrl);
    const firstAuth = await authenticate(
      firstViewer,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );
    await host.inbox.next("peer-joined");
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "stable-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await firstViewer.inbox.next("signal");

    await closeClient(firstViewer);
    const reconnectedViewer = await openClient(harness.webSocketUrl);
    const reconnectedAuth = await authenticate(
      reconnectedViewer,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );
    expect(reconnectedAuth.peerId).toBe(firstAuth.peerId);
    expect(reconnectedAuth.connectionId).toBe("stable-connection");
    expect((await host.inbox.next("peer-joined")).peerId).toBe(firstAuth.peerId);

    reconnectedViewer.socket.send(
      JSON.stringify({
        type: "restart-request",
        connectionId: reconnectedAuth.connectionId,
        rebuild: false,
      }),
    );
    expect(await host.inbox.next("restart-request")).toMatchObject({
      fromPeerId: firstAuth.peerId,
      connectionId: "stable-connection",
      rebuild: false,
    });
    await host.inbox.expectNone(110);

    await closeClient(reconnectedViewer);
    expect((await host.inbox.next("peer-left", 500)).peerId).toBe(firstAuth.peerId);
  });

  it.each([1, 2, 3] as const)(
    "authorizes exactly %i ordinary Host children independently of room admission",
    async (endpointMediaCopyCapacity) => {
      const maxViewersPerRoom = endpointMediaCopyCapacity + 1;
      const harness = await startHarness({
        endpointMediaCopyCapacity,
        maxViewersPerRoom,
      });
      const viewers: TestClient[] = [];
      const viewerPeerIds: string[] = [];
      for (let index = 0; index < maxViewersPerRoom; index += 1) {
        const viewer = await openClient(harness.webSocketUrl);
        const authenticated = await authenticate(
          viewer,
          harness.room,
          "viewer",
          `ordinary-cap-viewer-${index}`,
          1,
          undefined,
          { viewerPresence: true },
        );
        expect(authenticated.endpointMediaCopyCapacity).toBe(
          endpointMediaCopyCapacity,
        );
        viewers.push(viewer);
        viewerPeerIds.push(authenticated.peerId);
      }

      const host = await openClient(harness.webSocketUrl);
      const hostAuth = await authenticate(
        host,
        harness.room,
        "host",
        "ordinary-cap-host",
        1,
        undefined,
        { viewerPresence: true },
      );
      expect(hostAuth).toMatchObject({
        maxViewers: maxViewersPerRoom,
        endpointMediaCopyCapacity,
        viewerPeerIds: viewerPeerIds.slice(0, endpointMediaCopyCapacity),
      });

      const presence = viewerPresenceEntries(
        await host.inbox.next("viewer-presence"),
      );
      for (let index = 0; index < presence.length; index += 1) {
        expect(presence[index]).toMatchObject({
          peerId: viewerPeerIds[index],
          upstream:
            index < endpointMediaCopyCapacity
              ? { kind: "peer", peerId: hostAuth.peerId }
              : { kind: "none" },
        });
      }

      const waitingPeerId = viewerPeerIds.at(-1)!;
      expect((await host.inbox.next("peer-waiting")).peerId).toBe(
        waitingPeerId,
      );
      for (const activePeerId of viewerPeerIds.slice(
        0,
        endpointMediaCopyCapacity,
      )) {
        expect((await host.inbox.next("peer-joined")).peerId).toBe(
          activePeerId,
        );
      }

      host.socket.send(
        JSON.stringify({
          type: "signal",
          targetPeerId: waitingPeerId,
          payload: {
            kind: "description",
            connectionId: "waiting-host-offer",
            description: { type: "offer", sdp: "v=0\r\n" },
          },
        }),
      );
      expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");

      host.socket.send(
        JSON.stringify({
          type: "signal",
          targetPeerId: waitingPeerId,
          payload: {
            kind: "candidate",
            connectionId: "waiting-host-candidate",
            candidate: null,
          },
        }),
      );
      expect((await host.inbox.next("error")).code).toBe("FORBIDDEN");

      const waitingViewer = viewers.at(-1)!;
      waitingViewer.socket.send(
        JSON.stringify({
          type: "signal",
          payload: {
            kind: "description",
            connectionId: "waiting-viewer-answer",
            description: { type: "answer", sdp: "v=0\r\n" },
          },
        }),
      );
      expect((await waitingViewer.inbox.next("error")).code).toBe("FORBIDDEN");

      waitingViewer.socket.send(
        JSON.stringify({
          type: "signal",
          payload: {
            kind: "candidate",
            connectionId: "waiting-viewer-candidate",
            candidate: null,
          },
        }),
      );
      expect((await waitingViewer.inbox.next("error")).code).toBe("FORBIDDEN");

      waitingViewer.socket.send(
        JSON.stringify({
          type: "restart-request",
          connectionId: "waiting-viewer-restart",
          rebuild: true,
        }),
      );
      expect((await waitingViewer.inbox.next("error")).code).toBe("FORBIDDEN");

      host.socket.send(
        JSON.stringify({
          type: "signal",
          targetPeerId: viewerPeerIds[0],
          payload: {
            kind: "description",
            connectionId: "active-host-offer",
            description: { type: "offer", sdp: "v=0\r\n" },
          },
        }),
      );
      expect(await viewers[0]!.inbox.next("signal")).toMatchObject({
        fromPeerId: hostAuth.peerId,
        payload: { connectionId: "active-host-offer" },
      });
    },
  );

  it("holds an active ordinary slot through grace and skips offline waiters", async () => {
    const harness = await startHarness({
      endpointMediaCopyCapacity: 1,
      maxViewersPerRoom: 3,
      viewerDisconnectGraceMs: 100,
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "ordinary-grace-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);

    const activeViewer = await openClient(harness.webSocketUrl);
    const activeAuth = await authenticate(
      activeViewer,
      harness.room,
      "viewer",
      "ordinary-grace-active",
    );
    expect((await host.inbox.next("peer-joined")).peerId).toBe(
      activeAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([
      expect.objectContaining({
        peerId: activeAuth.peerId,
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      }),
    ]);

    const offlineWaitingViewer = await openClient(harness.webSocketUrl);
    const offlineWaitingAuth = await authenticate(
      offlineWaitingViewer,
      harness.room,
      "viewer",
      "ordinary-grace-offline-waiting",
    );
    expect((await host.inbox.next("peer-waiting")).peerId).toBe(
      offlineWaitingAuth.peerId,
    );
    await host.inbox.next("viewer-presence");

    const connectedWaitingViewer = await openClient(harness.webSocketUrl);
    const connectedWaitingAuth = await authenticate(
      connectedWaitingViewer,
      harness.room,
      "viewer",
      "ordinary-grace-connected-waiting",
    );
    expect((await host.inbox.next("peer-waiting")).peerId).toBe(
      connectedWaitingAuth.peerId,
    );
    await host.inbox.next("viewer-presence");

    await closeClient(activeViewer);
    await host.inbox.next("viewer-presence");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeClient(offlineWaitingViewer);
    await host.inbox.next("viewer-presence");
    await host.inbox.expectNone(40);

    expect((await host.inbox.next("peer-left", 300)).peerId).toBe(
      activeAuth.peerId,
    );
    expect((await host.inbox.next("peer-joined", 300)).peerId).toBe(
      connectedWaitingAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([
      expect.objectContaining({
        peerId: connectedWaitingAuth.peerId,
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      }),
    ]);

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: connectedWaitingAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "promoted-host-offer",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await connectedWaitingViewer.inbox.next("signal")).toMatchObject({
      payload: { connectionId: "promoted-host-offer" },
    });
    expect((await host.inbox.next("peer-left", 300)).peerId).toBe(
      offlineWaitingAuth.peerId,
    );
  });

  it("clears the previous media generation when sharing stops", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 300 });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stop");
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "viewer-client-stop",
    );
    await host.inbox.next("peer-joined");
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "connection-before-stop",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    const hostClosed = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(JSON.stringify({ type: "stop-sharing" }));
    await viewer.inbox.next("sharing-stopped");
    expect(await viewer.inbox.next("host-status")).toMatchObject({ online: false });
    expect(await hostClosed).toBe(1000);
    await closeClient(viewer);

    const reconnected = await openClient(harness.webSocketUrl);
    const reconnectedAuth = await authenticate(
      reconnected,
      harness.room,
      "viewer",
      "viewer-client-stop",
    );
    expect(reconnectedAuth.connectionId).toBeNull();
    expect(reconnectedAuth.peerId).toBe(viewerAuth.peerId);
    expect(reconnectedAuth.hostOnline).toBe(false);
  });

  it("replaces the same client presence once without leave churn", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 40 });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "host-client-stable",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);
    const original = await openClient(harness.webSocketUrl);
    const originalAuth = await authenticate(
      original,
      harness.room,
      "viewer",
      "viewer-client-stable",
      1,
      undefined,
      { displayName: "旧会话" },
    );
    await host.inbox.next("peer-joined");
    expect(viewerPresenceEntries(await host.inbox.next("viewer-presence"))).toEqual([
      {
        role: "viewer",
        peerId: originalAuth.peerId,
        displayName: "旧会话",
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      },
    ]);

    const originalClosed = new Promise<number>((resolve) =>
      original.socket.once("close", (code) => resolve(code)),
    );
    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = await authenticate(
      replacement,
      harness.room,
      "viewer",
      "viewer-client-stable",
      1,
      undefined,
      { displayName: "新会话" },
    );

    expect(replacementAuth.peerId).toBe(originalAuth.peerId);
    expect(await originalClosed).toBe(4001);
    expect((await host.inbox.next("peer-joined")).peerId).toBe(originalAuth.peerId);
    expect(viewerPresenceEntries(await host.inbox.next("viewer-presence"))).toEqual([
      {
        role: "viewer",
        peerId: originalAuth.peerId,
        displayName: "新会话",
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      },
    ]);
    await host.inbox.expectNone(70);
  });

  it("notifies the host when a pre-offer viewer reconnects inside grace", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 300 });
    const originalViewer = await openClient(harness.webSocketUrl);
    const originalAuth = await authenticate(
      originalViewer,
      harness.room,
      "viewer",
      "viewer-client-before-offer",
    );
    await closeClient(originalViewer);

    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    await host.inbox.expectNone(30);

    const reconnectedViewer = await openClient(harness.webSocketUrl);
    const reconnectedAuth = await authenticate(
      reconnectedViewer,
      harness.room,
      "viewer",
      "viewer-client-before-offer",
    );
    expect(reconnectedAuth.peerId).toBe(originalAuth.peerId);
    expect(await host.inbox.next("peer-joined")).toMatchObject({
      peerId: originalAuth.peerId,
    });
  });

  it("reasserts an authoritative parent route when a peer-assisted viewer reconnects", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      viewerDisconnectGraceMs: 300,
    });
    const host = await openClient(harness.webSocketUrl);
    peerAssisted(
      await authenticate(host, harness.room, "host", "relay-reauth-host"),
    );
    const originalViewer = await openClient(harness.webSocketUrl);
    const originalAuth = peerAssisted(
      await authenticate(
        originalViewer,
        harness.room,
        "viewer",
        "relay-reauth-viewer",
      ),
    );
    await host.inbox.next("media-assignment");
    await host.inbox.next("route-update");
    await closeClient(originalViewer);

    const reconnectedViewer = await openClient(harness.webSocketUrl);
    const reconnectedAuth = peerAssisted(
      await authenticate(
        reconnectedViewer,
        harness.room,
        "viewer",
        "relay-reauth-viewer",
      ),
    );
    expect(reconnectedAuth.peerId).toBe(originalAuth.peerId);
    expect(reconnectedAuth.connectionId).toBeNull();
    expect(await host.inbox.next("route-update")).toMatchObject({
      revision: reconnectedAuth.routeRevision,
      phase: "active",
      assignment: {
        upstream: { kind: "none" },
        childPeerIds: [originalAuth.peerId],
        sfuPublicationGeneration: null,
      },
    });
  });

  it("replays viewers when a host reconnects", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 500 });
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );
    const firstHost = await openClient(harness.webSocketUrl);
    const firstHostAuth = await authenticate(
      firstHost,
      harness.room,
      "host",
      "host-client-stable",
    );
    await firstHost.inbox.next("peer-joined");
    await viewer.inbox.next("host-status");
    firstHost.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "connection-before-control-outage",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    await closeClient(firstHost);
    expect(await viewer.inbox.next("host-status")).toMatchObject({ online: false });
    await closeClient(viewer);
    const refreshedViewer = await openClient(harness.webSocketUrl);
    const refreshedViewerAuth = await authenticate(
      refreshedViewer,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );
    expect(refreshedViewerAuth.peerId).toBe(viewerAuth.peerId);
    expect(refreshedViewerAuth.hostOnline).toBe(false);

    const secondHost = await openClient(harness.webSocketUrl);
    const secondHostAuth = await authenticate(
      secondHost,
      harness.room,
      "host",
      "host-client-stable",
    );
    expect(secondHostAuth.peerId).toBe(firstHostAuth.peerId);
    expect(secondHostAuth.viewerPeerIds).toEqual([viewerAuth.peerId]);
    expect((await secondHost.inbox.next("peer-joined")).peerId).toBe(
      viewerAuth.peerId,
    );
    await secondHost.inbox.expectNone(30);
    expect(await refreshedViewer.inbox.next("host-status")).toMatchObject({
      online: true,
    });
  });

  it("reconciles an empty roster after a viewer grace period ends offline", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 30 });
    const firstHost = await openClient(harness.webSocketUrl);
    const firstHostAuth = await authenticate(
      firstHost,
      harness.room,
      "host",
      "host-client-roster",
    );
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(viewer, harness.room, "viewer", "viewer-client-roster");
    await firstHost.inbox.next("peer-joined");

    await closeClient(firstHost);
    await closeClient(viewer);
    await new Promise((resolve) => setTimeout(resolve, 70));

    const secondHost = await openClient(harness.webSocketUrl);
    const secondHostAuth = await authenticate(
      secondHost,
      harness.room,
      "host",
      "host-client-roster",
    );
    expect(secondHostAuth.peerId).toBe(firstHostAuth.peerId);
    expect(secondHostAuth.viewerPeerIds).toEqual([]);
    await secondHost.inbox.expectNone(30);
  });

  it("keeps media identity through grace while presence returns once", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 500 });
    const firstHost = await openClient(harness.webSocketUrl);
    const firstHostAuth = await authenticate(
      firstHost,
      harness.room,
      "host",
      "host-client-grace-roster",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await firstHost.inbox.next("viewer-presence")),
    ).toEqual([]);
    const firstViewer = await openClient(harness.webSocketUrl);
    const firstViewerAuth = await authenticate(
      firstViewer,
      harness.room,
      "viewer",
      "viewer-client-grace-roster",
      1,
      undefined,
      { displayName: "短线重连" },
    );
    await firstHost.inbox.next("peer-joined");
    expect(
      viewerPresenceEntries(await firstHost.inbox.next("viewer-presence")),
    ).toEqual([
      {
        role: "viewer",
        peerId: firstViewerAuth.peerId,
        displayName: "短线重连",
        upstream: { kind: "peer", peerId: firstHostAuth.peerId },
      },
    ]);
    firstHost.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: firstViewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "connection-during-grace",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await firstViewer.inbox.next("signal");

    await closeClient(firstViewer);
    expect(
      viewerPresenceEntries(await firstHost.inbox.next("viewer-presence")),
    ).toEqual([]);
    await closeClient(firstHost);

    const secondHost = await openClient(harness.webSocketUrl);
    const secondHostAuth = await authenticate(
      secondHost,
      harness.room,
      "host",
      "host-client-grace-roster",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect(secondHostAuth.viewerPeerIds).toEqual([firstViewerAuth.peerId]);
    expect(
      viewerPresenceEntries(await secondHost.inbox.next("viewer-presence")),
    ).toEqual([]);
    await secondHost.inbox.expectNone(30);

    const secondViewer = await openClient(harness.webSocketUrl);
    const secondViewerAuth = await authenticate(
      secondViewer,
      harness.room,
      "viewer",
      "viewer-client-grace-roster",
      1,
      undefined,
      { displayName: "短线重连" },
    );
    expect(secondViewerAuth.peerId).toBe(firstViewerAuth.peerId);
    expect(secondViewerAuth.connectionId).toBe("connection-during-grace");
    expect((await secondHost.inbox.next("peer-joined")).peerId).toBe(
      firstViewerAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await secondHost.inbox.next("viewer-presence")),
    ).toEqual([
      {
        role: "viewer",
        peerId: firstViewerAuth.peerId,
        displayName: "短线重连",
        upstream: { kind: "peer", peerId: secondHostAuth.peerId },
      },
    ]);
    await secondHost.inbox.expectNone(30);

    secondViewer.socket.send(
      JSON.stringify({
        type: "restart-request",
        connectionId: secondViewerAuth.connectionId,
        rebuild: false,
      }),
    );
    expect(await secondHost.inbox.next("restart-request")).toMatchObject({
      fromPeerId: firstViewerAuth.peerId,
      connectionId: "connection-during-grace",
      rebuild: false,
    });
  });

  it("stops sharing without deleting the room and restricts room abandonment", async () => {
    const maxViewersPerRoom = 5;
    const harness = await startHarness({ maxViewersPerRoom });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "host-client-stable",
    );
    expect(hostAuth.maxViewers).toBe(maxViewersPerRoom);
    const viewers: TestClient[] = [];
    for (let index = 1; index <= maxViewersPerRoom; index += 1) {
      const viewer = await openClient(harness.webSocketUrl);
      const viewerAuth = await authenticate(
        viewer,
        harness.room,
        "viewer",
        `viewer-client-${index}`,
      );
      expect(viewerAuth.maxViewers).toBe(maxViewersPerRoom);
      await host.inbox.next(index <= 2 ? "peer-joined" : "peer-waiting");
      viewers.push(viewer);
    }

    const overflow = await openClient(harness.webSocketUrl);
    overflow.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        viewerGrant: harness.room.viewerGrant,
        clientId: `viewer-client-${maxViewersPerRoom + 1}`,
      }),
    );
    expect((await overflow.inbox.next("error")).code).toBe("ROOM_FULL");

    const stoppedHostClosed = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(JSON.stringify({ type: "stop-sharing" }));
    for (const viewer of viewers) {
      expect(await viewer.inbox.next("sharing-stopped")).toEqual({
        type: "sharing-stopped",
      });
      expect(await viewer.inbox.next("host-status")).toMatchObject({ online: false });
    }
    expect(await stoppedHostClosed).toBe(1000);
    expect(harness.roomStore.size).toBe(1);

    viewers[0]!.socket.send(JSON.stringify({ type: "abandon-room" }));
    expect((await viewers[0]!.inbox.next("error")).code).toBe("FORBIDDEN");
    expect(harness.roomStore.size).toBe(1);

    const abandonHost = await openClient(harness.webSocketUrl);
    await authenticate(
      abandonHost,
      harness.room,
      "host",
      "host-client-stable",
    );
    abandonHost.socket.send(JSON.stringify({ type: "abandon-room" }));
    expect(await abandonHost.inbox.next("room-closed")).toMatchObject({
      reason: "host-ended",
    });
    for (const viewer of viewers) {
      expect(await viewer.inbox.next("room-closed")).toMatchObject({
        reason: "host-ended",
      });
    }
    expect(harness.roomStore.size).toBe(0);
  });

  it("requires an allowed Origin, timely authentication, and bounded payloads", async () => {
    const harness = await startHarness({ authenticationTimeoutMs: 30 });
    expect(
      await rejectedUpgradeStatus(harness.webSocketUrl, `${allowedOrigin}/path`),
    ).toBe(403);
    const foreign = new WebSocket(harness.webSocketUrl, {
      origin: "https://foreign.example.test",
    });
    foreign.on("error", () => {
      // The status assertion below is the expected failure path.
    });
    const status = await new Promise<number | undefined>((resolve) => {
      foreign.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode),
      );
    });
    expect(status).toBe(403);

    const unauthenticated = await openClient(harness.webSocketUrl);
    expect((await unauthenticated.inbox.next("error", 300)).code).toBe(
      "AUTH_REQUIRED",
    );

    const oversized = await openClient(harness.webSocketUrl);
    const closeCode = new Promise<number>((resolve) =>
      oversized.socket.once("close", (code) => resolve(code)),
    );
    oversized.socket.send("x".repeat(MAX_SIGNAL_BYTES + 1));
    expect(await closeCode).toBe(1009);
  });

  it("terminates an old client protocol before authentication", async () => {
    const harness = await startHarness();
    const oldClient = await openClient(harness.webSocketUrl);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      oldClient.socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );

    oldClient.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: "screener-v5",
        roomId: "999999999999",
        role: "viewer",
        clientId: "old-client",
      }),
    );

    expect(await oldClient.inbox.next("error")).toMatchObject({
      code: "INVALID_MESSAGE",
    });
    expect(await closed).toEqual({ code: 1008, reason: "Invalid message" });
  });

  it("rejects an invalid upgrade request target without stopping the server", async () => {
    const harness = await startHarness();
    const response = await rawUpgradeResponse(harness.webSocketUrl, "//[");
    expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request/);

    const host = await openClient(harness.webSocketUrl);
    expect(
      (await authenticate(host, harness.room, "host", "host-after-invalid-url"))
        .role,
    ).toBe("host");
  });

  it("rejects unauthenticated and total connection overflow before upgrade", async () => {
    const harness = await startHarness({
      maxSignalConnections: 2,
      maxUnauthenticatedSignalConnections: 1,
    });
    const host = await openClient(harness.webSocketUrl);
    expect(await rejectedUpgradeStatus(harness.webSocketUrl)).toBe(503);

    await authenticate(host, harness.room, "host", "capacity-host");
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "capacity-viewer",
    );
    expect(await rejectedUpgradeStatus(harness.webSocketUrl)).toBe(503);
  });
});
