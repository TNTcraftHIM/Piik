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
  degradationPreference: "maintain-resolution",
} as const;
const balancedQualitySettings = {
  resolution: "1080p",
  maxFramerate: 30,
  maxBitrate: 5_000_000,
  degradationPreference: "balanced",
} as const;
const lowQualitySettings = {
  resolution: "720p",
  maxFramerate: 30,
  maxBitrate: 3_000_000,
  degradationPreference: "maintain-resolution",
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
  peerAssistedRoomIds?: Set<string>;
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
    hostAdmissionPassword?: string;
    persistent?: boolean;
    provisionalHostClaimSeconds?: number;
    peerAssistedMedia?: boolean;
    stunUrls?: readonly string[];
    now?: () => number;
  } = {},
): Promise<SignalHarness> {
  const config = testConfig();
  config.hostAdmissionPassword = overrides.hostAdmissionPassword;
  config.peerAssistedMedia = overrides.peerAssistedMedia ?? false;
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
  const peerAssistedRoomIds = config.peerAssistedMedia
    ? new Set([room.roomId])
    : undefined;
  config.peerAssistedRoomIds = peerAssistedRoomIds;
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
    peerAssistedRoomIds,
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

async function startSfuHarness(options: {
  tokenIssuer: SfuTokenIssuer;
  prepareTimeoutMs?: number;
  maxRoots?: number;
  viewerDisconnectGraceMs?: number;
  stunUrls?: readonly string[];
  now?: () => number;
}): Promise<SignalHarness> {
  const roomStore = new RoomStore({
    ttlMs: 14_400_000,
    maxRooms: 10,
    maxViewersPerRoom: 8,
  });
  const room = roomStore.createRoom();
  const peerAssistedRoomIds = new Set([room.roomId]);
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const signaling = new SignalingServer({
    server: httpServer,
    roomStore,
    peerAssistedMedia: true,
    peerAssistedRoomIds,
    sfuFallback: {
      url: "wss://sfu.example.test",
      tokenIssuer: options.tokenIssuer,
      maxRoots: options.maxRoots ?? 2,
      prepareTimeoutMs: options.prepareTimeoutMs,
    },
    ice: {
      stunUrls: options.stunUrls ?? [],
    },
    allowedOrigins: new Set([allowedOrigin]),
    hostAdmissionAtUpgrade: () => true,
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
    peerAssistedRoomIds,
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
  relayCapacity: 0 | 1 | null = 1,
  shareGeneration?: string,
  presence: { displayName?: string; viewerPresence?: true } = {},
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
            ...(presence.viewerPresence ? { viewerPresence: true } : {}),
          }
        : {
            type: "authenticate",
            protocol: SIGNALING_PROTOCOL,
            roomId: room.roomId,
            role,
            clientId,
            ...(room.viewerGrant ? { viewerGrant: room.viewerGrant } : {}),
            ...(presence.displayName
              ? { displayName: presence.displayName }
              : {}),
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

async function nextPreparedRoute(client: TestClient) {
  while (true) {
    const message = await client.inbox.next("route-update");
    if (message.phase === "prepare") {
      return message;
    }
  }
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
    ),
  );
  const rootViewer = await openClient(webSocketUrl);
  const rootAuth = peerAssisted(
    await authenticate(
      rootViewer,
      room,
      "viewer",
      `${prefix}-root-client`,
    ),
  );
  const directRoute = await nextActiveRouteAfter(
    failedViewer,
    failedAuth.routeRevision,
  );
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
    hostPrepare,
    rootPrepare,
  };
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
  });

  it("reports every online Viewer without expanding the Host media fanout", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(
      host,
      harness.room,
      "host",
      "presence-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([]);

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
        message.viewers.length === 3 &&
        message.viewers.some(
          (viewer) => viewer.mediaTopology === "peer-relay",
        ),
    );
    expect(full.viewers.map((viewer) => viewer.displayName)).toEqual([
      "阿明",
      "阿青",
      "访客",
    ]);
    expect(
      full.viewers.filter(
        (viewer) => viewer.mediaTopology === "host-direct",
      ),
    ).toHaveLength(2);

    viewers[2].socket.send(
      JSON.stringify({ type: "set-display-name", displayName: "后来改名" }),
    );
    const renamed = await nextViewerPresenceMatching(host, (message) =>
      message.viewers.some((viewer) => viewer.displayName === "后来改名"),
    );
    expect(renamed.viewers).toHaveLength(3);

    await closeClient(viewers[2]);
    const afterDisconnect = await nextViewerPresenceMatching(
      host,
      (message) => message.viewers.length === 2,
    );
    expect(afterDisconnect.viewers.map((viewer) => viewer.displayName)).toEqual([
      "阿明",
      "阿青",
    ]);
  });

  it("publishes one empty Viewer roster after ordinary rotate and revoke", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(
      host,
      harness.room,
      "host",
      "ordinary-access-presence-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([]);

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
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([
      {
        peerId: firstViewerAuth.peerId,
        displayName: "第一位",
        mediaTopology: "host-direct",
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
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([]);
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
    expect((await host.inbox.next("viewer-presence")).viewers).toHaveLength(1);

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
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([]);
    expect(await host.inbox.next("viewer-access-updated")).toMatchObject({
      viewerPolicy: "private-link",
      inviteUrl: null,
    });
    await host.inbox.expectNone(30);
  });

  it("protects Host admission without gating authorized Viewers", async () => {
    const hostAdmissionPassword = "protected-instance-password";
    const harness = await startHarness({ hostAdmissionPassword });

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

    const login = await fetch(`${harness.baseUrl}/api/host-admission`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hostAdmissionPassword}`,
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

  it("isolates the routing allowlist while ordinary ICE stays STUN-only", async () => {
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
    const ordinaryHostAuth = await authenticate(
      ordinaryHost,
      ordinaryRoom,
      "host",
      "ordinary-host",
    );
    expect(Object.keys(ordinaryHostAuth).sort()).toEqual(
      [
        "connectionId",
        "hostOnline",
        "iceConfig",
        "maxViewers",
        "peerId",
        "protocol",
        "role",
        "roomExpiresAt",
        "type",
        "viewerAuthorizationGeneration",
        "viewerPeerIds",
        "viewerPolicy",
      ].sort(),
    );
    expect(ordinaryHostAuth.iceConfig).toEqual(hybridHostAuth.iceConfig);
    expect(
      ordinaryHostAuth.iceConfig.iceServers.every(
        (server) => !("username" in server) && !("credential" in server),
      ),
    ).toBe(true);

    const ordinaryViewer = await openClient(harness.webSocketUrl);
    const ordinaryViewerAuth = await authenticate(
      ordinaryViewer,
      ordinaryRoom,
      "viewer",
      "ordinary-viewer",
    );
    expect(Object.keys(ordinaryViewerAuth).sort()).toEqual(
      Object.keys(ordinaryHostAuth).sort(),
    );
    expect(await ordinaryHost.inbox.next("peer-joined")).toEqual({
      type: "peer-joined",
      peerId: ordinaryViewerAuth.peerId,
    });

    ordinaryHost.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: ordinaryViewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "ordinary-room-connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await ordinaryViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: ordinaryHostAuth.peerId,
      payload: { connectionId: "ordinary-room-connection" },
    });
    ordinaryViewer.socket.send(
      JSON.stringify({
        type: "signal",
        payload: {
          kind: "description",
          connectionId: "ordinary-room-connection",
          description: { type: "answer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await ordinaryHost.inbox.next("signal")).toMatchObject({
      fromPeerId: ordinaryViewerAuth.peerId,
      payload: { connectionId: "ordinary-room-connection" },
    });

    ordinaryHost.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: balancedQualitySettings,
      }),
    );
    expect((await ordinaryHost.inbox.next("error")).code).toBe("FORBIDDEN");
    ordinaryViewer.socket.send(
      JSON.stringify({ type: "relay-capacity", downstreamEdges: 1 }),
    );
    expect((await ordinaryViewer.inbox.next("error")).code).toBe("FORBIDDEN");
    ordinaryViewer.socket.send(
      JSON.stringify({ type: "refresh-sfu", revision: 0 }),
    );
    expect((await ordinaryViewer.inbox.next("error")).code).toBe("FORBIDDEN");

    await closeClient(ordinaryViewer);
    expect(await ordinaryHost.inbox.next("peer-left", 500)).toEqual({
      type: "peer-left",
      peerId: ordinaryViewerAuth.peerId,
    });
  });

  it("keeps allowlisted and ordinary room lifecycles independent", async () => {
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
    await authenticate(ordinaryHost, ordinaryRoom, "host", "lifecycle-ordinary-host");
    const ordinaryViewer = await openClient(harness.webSocketUrl);
    const ordinaryViewerAuth = await authenticate(
      ordinaryViewer,
      ordinaryRoom,
      "viewer",
      "lifecycle-ordinary-viewer",
    );
    await ordinaryHost.inbox.next("peer-joined");

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
    const resumedOrdinaryViewerAuth = await authenticate(
      resumedOrdinaryViewer,
      ordinaryRoom,
      "viewer",
      "lifecycle-ordinary-viewer",
    );
    expect(resumedOrdinaryViewerAuth.peerId).toBe(ordinaryViewerAuth.peerId);
    expect(resumedOrdinaryViewerAuth.connectionId).toBeNull();
    expect("mediaMode" in resumedOrdinaryViewerAuth).toBe(false);
    expect("qualitySettings" in resumedOrdinaryViewerAuth).toBe(false);

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
    const resumedOrdinaryHostAuth = await authenticate(
      resumedOrdinaryHost,
      ordinaryRoom,
      "host",
      "lifecycle-ordinary-host",
    );
    expect(await resumedOrdinaryHost.inbox.next("peer-joined")).toMatchObject({
      peerId: resumedOrdinaryViewerAuth.peerId,
    });

    resumedHybridHost.socket.send(JSON.stringify({ type: "abandon-room" }));
    await resumedHybridHost.inbox.next("room-closed");
    await resumedHybridViewer.inbox.next("room-closed");
    expect(harness.roomStore.size).toBe(1);

    resumedOrdinaryHost.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: resumedOrdinaryViewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "ordinary-after-hybrid-delete",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    expect(await resumedOrdinaryViewer.inbox.next("signal")).toMatchObject({
      fromPeerId: resumedOrdinaryHostAuth.peerId,
      payload: { connectionId: "ordinary-after-hybrid-delete" },
    });
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

  it("derives peer-assisted C routing from the active assignment", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "peer-quality-host"),
    );
    host.inbox.ignore("route-update");
    host.inbox.ignore("media-assignment");
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
    expect(await viewer.inbox.next("viewer-quality-evidence")).toMatchObject({
      viewerPeerId: relayChildAuth.peerId,
      parentPeerId: viewerAuth.peerId,
      guard: {
        connectionId: "relay_child_quality_connection",
        routeRevision: relayChildAuth.routeRevision,
      },
    });
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
    const moved = await nextActiveRouteAfter(viewer, active.revision);
    expect(acceptedParentEvidence).toHaveBeenCalledTimes(3);
    expect(moved.assignment.upstream).toEqual({
      kind: "peer",
      peerId: unrelatedParentAuth.peerId,
    });
    acceptedParentEvidence.mockRestore();
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
    const movedRoot = await nextActiveRouteAfter(
      subtreeRoot,
      subtreeLeafAuth.routeRevision,
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
    expect(await viewer.inbox.next("error")).toMatchObject({
      code: "PEER_NOT_FOUND",
      message: "No media fallback route is available",
    });
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
    expect(await viewer.inbox.next("error")).toMatchObject({
      code: "PEER_NOT_FOUND",
      message: "No media fallback route is available",
    });
    expect(viewerAuth.routeAssignment.upstream).toEqual({
      kind: "peer",
      peerId: hostAuth.peerId,
    });
  });

  it("keeps a pending quality SFU prepare after the same intent becomes a real failure", async () => {
    let now = 250_000;
    let releaseTokens!: () => void;
    let markTokenStarted!: () => void;
    const tokenBarrier = new Promise<void>((resolve) => {
      releaseTokens = resolve;
    });
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const harness = await startSfuHarness({
      now: () => now,
      tokenIssuer: {
        async issueToken(request) {
          markTokenStarted();
          await tokenBarrier;
          return `token-${request.peerId}`;
        },
      },
    });
    const host = await openClient(harness.webSocketUrl);
    peerAssisted(
      await authenticate(host, harness.room, "host", "quality-takeover-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "quality-takeover-viewer",
      ),
    );
    await nextActiveRouteRevision(host, viewerAuth.routeRevision);
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_takeover_connection",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    for (let sequence = 0; sequence < 3; sequence += 1) {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_takeover_connection",
            viewerAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(host);
      now += 2_000;
    }
    await tokenStarted;

    viewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: viewerAuth.routeRevision,
        phase: "active",
        connectionId: "quality_takeover_connection",
      }),
    );
    viewer.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: defaultQualitySettings,
      }),
    );
    expect(await viewer.inbox.next("error")).toMatchObject({
      code: "FORBIDDEN",
    });
    releaseTokens();

    const prepare = await nextPreparedRoute(viewer);
    expect(prepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(await viewer.inbox.next("sfu-config")).toMatchObject({
      revision: prepare.revision,
    });
  });

  it("aborts a quality SFU prepare after next-generation C removes its intent", async () => {
    let now = 300_000;
    let releaseTokens!: () => void;
    let holdTokens = true;
    const tokenBarrier = new Promise<void>((resolve) => {
      releaseTokens = resolve;
    });
    const harness = await startSfuHarness({
      now: () => now,
      tokenIssuer: {
        async issueToken(request) {
          if (holdTokens) {
            await tokenBarrier;
          }
          return `token-${request.peerId}`;
        },
      },
    });
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(host, harness.room, "host", "quality-guard-host"),
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = peerAssisted(
      await authenticate(
        viewer,
        harness.room,
        "viewer",
        "quality-guard-viewer",
      ),
    );
    await nextActiveRouteRevision(host, viewerAuth.routeRevision);

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_guard_original",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    for (let sequence = 0; sequence < 3; sequence += 1) {
      viewer.socket.send(
        JSON.stringify(
          viewerQualityEvidenceWithMetrics(
            "quality_guard_original",
            viewerAuth.routeRevision,
            sequence,
            { framesDecodedDelta: 0 },
          ),
        ),
      );
      await correlateParentEdgeQualityEvidence(host);
      now += 2_000;
    }

    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId: "quality_guard_replaced",
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");
    viewer.socket.send(
      JSON.stringify(
        viewerQualityEvidence(
          "quality_guard_replaced",
          viewerAuth.routeRevision,
          0,
        ),
      ),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject({
      guard: { connectionId: "quality_guard_replaced" },
      sequence: 0,
    });
    holdTokens = false;
    releaseTokens();

    const rollback = await nextActiveRouteAfter(
      viewer,
      viewerAuth.routeRevision,
    );
    expect(rollback.assignment).toMatchObject({
      upstream: { kind: "peer", peerId: hostAuth.peerId },
      sfuPublicationGeneration: null,
    });
    await expect(viewer.inbox.next("sfu-config", 40)).rejects.toThrow(
      "Timed out",
    );

    viewer.socket.send(
      JSON.stringify({
        type: "route-failed",
        revision: rollback.revision,
        phase: "active",
        connectionId: "quality_guard_replaced",
      }),
    );
    const prepare = await nextPreparedRoute(viewer);
    expect(prepare.assignment.upstream).toEqual({ kind: "sfu" });
    expect(await viewer.inbox.next("sfu-config")).toMatchObject({
      revision: prepare.revision,
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
    harness.peerAssistedRoomIds!.add(secondRoom.roomId);
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

  it("reparents failed peer edges before committing a bounded SFU fallback", async () => {
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
      routeAssignment: { upstream: { kind: "sfu" } },
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
    harness.peerAssistedRoomIds!.add(replacementRoom.roomId);
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
    harness.peerAssistedRoomIds!.add(prepareFailureRoom.roomId);
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
    expect((await host.inbox.next("error")).code).toBe("PEER_NOT_FOUND");

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
    await authenticate(
      host,
      harness.room,
      "host",
      "host-client-stable",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([]);
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
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([
      {
        peerId: originalAuth.peerId,
        displayName: "旧会话",
        mediaTopology: "host-direct",
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
    expect((await host.inbox.next("viewer-presence")).viewers).toEqual([
      {
        peerId: originalAuth.peerId,
        displayName: "新会话",
        mediaTopology: "host-direct",
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
    await authenticate(
      firstHost,
      harness.room,
      "host",
      "host-client-grace-roster",
      1,
      undefined,
      { viewerPresence: true },
    );
    expect((await firstHost.inbox.next("viewer-presence")).viewers).toEqual([]);
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
    expect((await firstHost.inbox.next("viewer-presence")).viewers).toEqual([
      {
        peerId: firstViewerAuth.peerId,
        displayName: "短线重连",
        mediaTopology: "host-direct",
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
    expect((await firstHost.inbox.next("viewer-presence")).viewers).toEqual([]);
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
    expect((await secondHost.inbox.next("viewer-presence")).viewers).toEqual([]);
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
    expect((await secondHost.inbox.next("viewer-presence")).viewers).toEqual([
      {
        peerId: firstViewerAuth.peerId,
        displayName: "短线重连",
        mediaTopology: "host-direct",
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
      await host.inbox.next("peer-joined");
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
        roomId: "999999999999",
        role: "viewer",
        clientId: "old-client",
      }),
    );

    expect(await oldClient.inbox.next("error")).toMatchObject({
      code: "AUTH_REQUIRED",
      message: "页面版本已更新，请刷新后重试",
    });
    expect(await closed).toEqual({ code: 4001, reason: "Protocol mismatch" });
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
