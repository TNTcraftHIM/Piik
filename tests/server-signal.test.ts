import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  MAX_SIGNAL_BYTES,
  SIGNALING_PROTOCOL,
  decodeServerMessage,
  type QualitySettings,
  type RoomAccessUpdateRequest,
  type Role,
  type ServerMessage,
  roomAccessUpdateResponseSchema,
} from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import {
  ROOM_CAPACITY,
  RoomStore,
  type CreatedRoom,
} from "../src/server/room-store.ts";

const allowedOrigin = "http://allowed.test";
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
}

function testConfig(): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    listenHost: "127.0.0.1",
    publicBaseUrl: new URL("https://share.example.test"),
    allowedOrigins: new Set([allowedOrigin]),
    roomLeaseMs: 86_400_000,
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
  const roomStore = new RoomStore({
    leaseMs: config.roomLeaseMs,
    maxRooms: ROOM_CAPACITY,
    maxViewersPerRoom,
    now: overrides.now,
  });
  const room = await roomStore.createRoom();
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
  };
}

async function updateRoomAccess(
  harness: SignalHarness,
  request: RoomAccessUpdateRequest,
) {
  const response = await fetch(
    `${harness.baseUrl}/api/rooms/${harness.room.roomId}/access`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.room.hostToken}`,
        "Content-Type": "application/json",
        Origin: allowedOrigin,
      },
      body: JSON.stringify(request),
    },
  );
  expect(response.status).toBe(200);
  return roomAccessUpdateResponseSchema.parse(await response.json());
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
    viewerPassword?: string;
    codeOnly?: true;
    sharingPaused?: boolean;
    qualitySettings?: QualitySettings;
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
            ...(presence.qualitySettings
              ? { qualitySettings: presence.qualitySettings }
              : {}),
            ...(presence.viewerPresence ? { viewerPresence: true } : {}),
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
              : !presence.codeOnly && room.viewerGrant
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

async function nextActiveRouteRevision(client: TestClient, revision: number) {
  while (true) {
    const message = await client.inbox.next("route-update");
    if (message.phase === "active" && message.revision === revision) {
      return message;
    }
  }
}

function viewerQualityEvidenceMessage(
  connectionId: string,
  routeRevision: number,
  sequence = 0,
) {
  return {
    type: "viewer-quality-evidence" as const,
    guard: { connectionId, routeRevision },
    sequence,
    windowMs: 2_000,
    metrics: {
      width: 1_920,
      height: 1_080,
      framesPerSecond: 60,
      bitrateKbps: 7_500,
      packetsReceivedDelta: 1_500,
      packetsLostDelta: 2,
      rttMs: 18,
      jitterMs: 3.5,
      framesDecodedDelta: 120,
      framesDroppedDelta: 1,
      decodeMsPerFrame: 2.4,
      freezeCountDelta: 0,
      freezeDurationMsDelta: 0,
      codec: "video/VP8",
      codecProfile: null,
      codecParameters: null,
      audioBitrateKbps: 192,
      audioPacketLossPercent: 0.2,
      audioJitterMs: 2.5,
      audioVideoPlayoutDeltaMs: -12.5,
      videoJitterBufferDelayMs: 24,
      audioJitterBufferDelayMs: 18,
      audioConcealedSamplesPercent: 1,
      audioConcealmentEventsDelta: 3,
      audioCodec: "audio/opus",
    },
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

  it("serves one current route snapshot only to the authenticated Host", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "route-diagnostic-host");
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "route-diagnostic-viewer",
    );

    host.socket.send(JSON.stringify({ type: "request-route-diagnostic" }));
    expect(await host.inbox.next("route-diagnostic-snapshot")).toMatchObject({
      snapshot: {
        children: [{ ordinal: 1, finalRoute: "waiting" }],
      },
    });

    viewer.socket.send(JSON.stringify({ type: "request-route-diagnostic" }));
    expect(await viewer.inbox.next("error")).toMatchObject({
      code: "FORBIDDEN",
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
      JSON.stringify({ type: "set-display-name", displayName: "Native 不应改名" }),
    );
    expect(await host.inbox.next("error")).toMatchObject({
      code: "FORBIDDEN",
    });
    await host.inbox.expectNone(40);
  });

  it("keeps a password optional for private room entry", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "password-settings-host");

    expect(
      await updateRoomAccess(harness, {
        action: "set-code-entry-policy",
        policy: "private",
      }),
    ).toEqual({
      type: "code-entry-policy-updated",
      codeEntryPolicy: "private",
      viewerPasswordEnabled: false,
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
      code: "ROOM_ACCESS_DENIED",
    });

    expect(
      await updateRoomAccess(harness, {
        action: "set-viewer-password",
        password: "easy-password",
      }),
    ).toEqual({
      type: "viewer-password-updated",
      enabled: true,
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

    expect(
      await updateRoomAccess(harness, {
        action: "set-viewer-password",
        password: null,
      }),
    ).toEqual({
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
      code: "ROOM_ACCESS_DENIED",
    });
  });

  it("reports password configuration only to the authenticated Host", async () => {
    const harness = await startHarness();
    harness.roomStore.setCodeEntryPolicy(
      harness.room.roomId,
      "private",
      harness.room.hostToken,
    );

    const host = await openClient(harness.webSocketUrl);
    const withoutPassword = await authenticate(
      host,
      harness.room,
      "host",
      "password-state-host",
    );
    expect(withoutPassword).toMatchObject({
      role: "host",
      codeEntryPolicy: "private",
      viewerPasswordEnabled: false,
    });

    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuthenticated = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "password-state-viewer",
    );
    expect(viewerAuthenticated).not.toHaveProperty("viewerPasswordEnabled");

    await harness.roomStore.setViewerPassword(
      harness.room.roomId,
      "room-password",
      harness.room.hostToken,
    );
    const replacementHost = await openClient(harness.webSocketUrl);
    const withPassword = await authenticate(
      replacementHost,
      harness.room,
      "host",
      "password-state-host",
    );
    expect(withPassword).toMatchObject({
      role: "host",
      codeEntryPolicy: "private",
      viewerPasswordEnabled: true,
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
      const authenticated = peerAssisted(
        await authenticate(
          viewer,
          harness.room,
          "viewer",
          `presence-viewer-${index}`,
          1,
          undefined,
          displayName ? { displayName } : {},
        ),
      );
      const prepared = await Promise.race([
        nextPreparedRoute(viewer),
        host.inbox.next("error").then((error) => {
          throw new Error(`route error: ${error.message}`);
        }),
      ]);
      viewer.socket.send(
        JSON.stringify({
          type: "route-transport-connected",
          revision: prepared.revision,
          connectionId: prepared.candidate.connectionId,
        }),
      );
      viewer.socket.send(
        JSON.stringify({
          type: "route-ready",
          revision: prepared.revision,
          phase: "prepare",
        }),
      );
      expect(prepared.revision).toBeGreaterThan(authenticated.routeRevision);
      await nextActiveRouteRevision(viewer, prepared.revision);
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

  it("forwards exact direct Viewer receive evidence to the Host", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "evidence-direct-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    const viewer = await openClient(harness.webSocketUrl);
    const viewerAuth = await authenticate(
      viewer,
      harness.room,
      "viewer",
      "evidence-direct-viewer",
    );
    await host.inbox.next("peer-joined");
    const connectionId = "evidence_direct_connection_12345678";
    host.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId: viewerAuth.peerId,
        payload: {
          kind: "description",
          connectionId,
          description: { type: "offer", sdp: "v=0\r\n" },
        },
      }),
    );
    await viewer.inbox.next("signal");

    viewer.socket.send(
      JSON.stringify(viewerQualityEvidenceMessage(connectionId, 0)),
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject({
      viewerPeerId: viewerAuth.peerId,
      upstream: { kind: "peer", peerId: hostAuth.peerId },
      guard: { connectionId, routeRevision: 0 },
    });
  });

  it("forwards a relayed child receive report to its exact parent and Host", async () => {
    const harness = await startHarness({
      peerAssistedMedia: true,
      endpointMediaCopyCapacity: 1,
    });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(
      host,
      harness.room,
      "host",
      "evidence-relay-host",
      1,
      undefined,
      { viewerPresence: true },
    );
    const parent = await openClient(harness.webSocketUrl);
    const parentAuth = peerAssisted(
      await authenticate(
        parent,
        harness.room,
        "viewer",
        "evidence-relay-parent",
        1,
      ),
    );
    const parentPrepare = await nextPreparedRoute(parent);
    parent.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: parentPrepare.revision,
        phase: "prepare",
      }),
    );
    await nextActiveRouteRevision(parent, parentPrepare.revision);

    const child = await openClient(harness.webSocketUrl);
    const childAuth = peerAssisted(
      await authenticate(
        child,
        harness.room,
        "viewer",
        "evidence-relay-child",
        1,
      ),
    );
    const childPrepare = await nextPreparedRoute(child);
    expect(childPrepare.assignment.upstream).toEqual({
      kind: "peer",
      peerId: parentAuth.peerId,
    });
    child.socket.send(
      JSON.stringify({
        type: "route-ready",
        revision: childPrepare.revision,
        phase: "prepare",
      }),
    );
    await nextActiveRouteRevision(child, childPrepare.revision);

    child.socket.send(
      JSON.stringify(
        viewerQualityEvidenceMessage(
          childPrepare.candidate.connectionId,
          childPrepare.revision,
        ),
      ),
    );
    const expected = {
      viewerPeerId: childAuth.peerId,
      upstream: { kind: "peer", peerId: parentAuth.peerId },
      guard: {
        connectionId: childPrepare.candidate.connectionId,
        routeRevision: childPrepare.revision,
      },
    };
    expect(await parent.inbox.next("viewer-quality-evidence")).toMatchObject(
      expected,
    );
    expect(await host.inbox.next("viewer-quality-evidence")).toMatchObject(
      expected,
    );
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

  it("strongly rotates and revokes every Viewer generation and media edge", async () => {
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
    const rotated = await updateRoomAccess(harness, {
      action: "rotate-viewer-grant",
    });
    expect(await firstViewer.inbox.next("viewer-grant-revoked")).toMatchObject({
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
    await host.inbox.expectNone(30);

    expect(rotated.type).toBe("viewer-grant-updated");
    if (rotated.type !== "viewer-grant-updated") {
      throw new Error("Expected a rotated Viewer grant");
    }

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
    const revoked = await updateRoomAccess(harness, {
      action: "revoke-viewer-grant",
    });
    await secondViewer.inbox.next("viewer-grant-revoked");
    expect(await secondClosed).toBe(4004);
    expect((await host.inbox.next("peer-left")).peerId).toBe(
      secondViewerAuth.peerId,
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);
    expect(revoked).toMatchObject({
      inviteUrl: null,
    });
    await host.inbox.expectNone(30);
  });

  it("rotates a grant without disturbing code-admitted Viewer media", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    const hostAuth = await authenticate(
      host,
      harness.room,
      "host",
      "mixed-access-host",
      2,
      undefined,
      { viewerPresence: true },
    );
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toEqual([]);

    const grantViewer = await openClient(harness.webSocketUrl);
    const grantAuth = await authenticate(
      grantViewer,
      harness.room,
      "viewer",
      "mixed-grant-viewer",
      1,
      undefined,
      { displayName: "邀请观众" },
    );
    await host.inbox.next("peer-joined");
    await host.inbox.next("viewer-presence");

    const codeViewer = await openClient(harness.webSocketUrl);
    const codeAuth = await authenticate(
      codeViewer,
      harness.room,
      "viewer",
      "mixed-code-viewer",
      1,
      undefined,
      { codeOnly: true, displayName: "房间号观众" },
    );
    await host.inbox.next("peer-joined");
    expect(
      viewerPresenceEntries(await host.inbox.next("viewer-presence")),
    ).toHaveLength(2);

    const grantClosed = new Promise<number>((resolve) =>
      grantViewer.socket.once("close", (code) => resolve(code)),
    );
    await updateRoomAccess(harness, { action: "rotate-viewer-grant" });
    await grantViewer.inbox.next("viewer-grant-revoked");
    expect(await grantClosed).toBe(4004);
    expect((await host.inbox.next("peer-left")).peerId).toBe(grantAuth.peerId);

    const remaining = viewerPresenceEntries(
      await host.inbox.next("viewer-presence"),
    );
    expect(remaining).toEqual([
      {
        role: "viewer",
        peerId: codeAuth.peerId,
        displayName: "房间号观众",
        upstream: { kind: "peer", peerId: hostAuth.peerId },
      },
    ]);
    expect(codeViewer.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      harness.roomStore.getConnectedViewer(harness.room.roomId, codeAuth.peerId),
    ).toBeDefined();

    await closeClient(codeViewer);
    await closeClient(host);
  });

  it("requires site access for code-only Viewers while accepting room grants", async () => {
    const siteAccessPassword = "protected-instance-password";
    const harness = await startHarness({ siteAccessPassword });

    const viewer = await openClient(harness.webSocketUrl);
    viewer.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: harness.room.roomId,
        role: "viewer",
        clientId: "code-only-viewer-without-site-access",
      }),
    );
    await expect(viewer.inbox.next("error")).resolves.toMatchObject({
      code: "INVALID_TOKEN",
    });

    const grantedViewer = await openClient(harness.webSocketUrl);
    await expect(
      authenticate(
        grantedViewer,
        harness.room,
        "viewer",
        "grant-viewer-without-site-access",
        1,
      ),
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
    await expect(
      authenticate(
        viewerWithHostCookie,
        harness.room,
        "viewer",
        "viewer-with-host-cookie",
        1,
        undefined,
        { codeOnly: true },
      ),
    ).resolves.toMatchObject({ role: "viewer" });

    const publicRoom = await harness.roomStore.createRoom("open");
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
        viewerGrant: `${"x".repeat(21)}g`,
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
        1,
        undefined,
        { codeOnly: true },
      ),
    ).resolves.toMatchObject({ role: "viewer" });

    const passwordRoom = await harness.roomStore.createRoom(
      "private",
      "room-password",
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

  it("distinguishes missing rooms from existing-room code-only denials", async () => {
    let now = Date.UTC(2026, 7, 24, 12);
    const siteAccessPassword = "protected-instance-password";
    const harness = await startHarness({
      siteAccessPassword,
      maxViewersPerRoom: 1,
      now: () => now,
    });
    const login = await fetch(`${harness.baseUrl}/api/site-access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${siteAccessPassword}`,
        Origin: allowedOrigin,
      },
    });
    let cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const protectedRoom = await harness.roomStore.createRoom(
      "private",
      "correct-password",
    );
    const expiring = await harness.roomStore.createRoom("open");
    const unusedRoomId = Array.from({ length: 9_000 }, (_, index) =>
      String(1_000 + index),
    ).find(
      (roomId) =>
        ![
          harness.room.roomId,
          protectedRoom.roomId,
          expiring.roomId,
        ].includes(roomId),
    )!;

    const admitted = await openClient(harness.webSocketUrl, cookie);
    await authenticate(
      admitted,
      harness.room,
      "viewer",
      "admitted-viewer",
      1,
      undefined,
      { codeOnly: true },
    );

    async function expectDenial(
      roomId: string,
      clientId: string,
      code: "ROOM_NOT_FOUND" | "ROOM_ACCESS_DENIED",
      viewerPassword?: string,
    ): Promise<void> {
      const client = await openClient(harness.webSocketUrl, cookie);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        client.socket.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
      );
      client.socket.send(
        JSON.stringify({
          type: "authenticate",
          protocol: SIGNALING_PROTOCOL,
          roomId,
          role: "viewer",
          clientId,
          ...(viewerPassword ? { viewerPassword } : {}),
        }),
      );
      expect(await client.inbox.next("error")).toEqual({
        type: "error",
        code,
        message:
          code === "ROOM_NOT_FOUND"
            ? "Room not found or expired"
            : "Room access denied",
      });
      expect(await closed).toEqual({
        code: 4003,
        reason: "Authentication failed",
      });
    }

    await expectDenial(unusedRoomId, "unknown-room-viewer", "ROOM_NOT_FOUND");
    await expectDenial(
      protectedRoom.roomId,
      "missing-password-viewer",
      "ROOM_ACCESS_DENIED",
    );
    await expectDenial(
      protectedRoom.roomId,
      "wrong-password-viewer",
      "ROOM_ACCESS_DENIED",
      "wrong-password",
    );
    await expectDenial(
      harness.room.roomId,
      "full-room-viewer",
      "ROOM_ACCESS_DENIED",
    );

    now += 86_400_001;
    const renewedLogin = await fetch(`${harness.baseUrl}/api/site-access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${siteAccessPassword}`,
        Origin: allowedOrigin,
      },
    });
    cookie = renewedLogin.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    await expectDenial(
      expiring.roomId,
      "expired-room-viewer",
      "ROOM_NOT_FOUND",
    );

    const expiredGrant = await openClient(harness.webSocketUrl, cookie);
    expiredGrant.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: SIGNALING_PROTOCOL,
        roomId: expiring.roomId,
        role: "viewer",
        clientId: "expired-grant-viewer",
        viewerGrant: expiring.viewerGrant,
      }),
    );
    expect(await expiredGrant.inbox.next("error")).toMatchObject({
      code: "INVALID_TOKEN",
    });
  });

  it("does not expire an active room and arms its lease after Host disconnect", async () => {
    let now = Date.UTC(2026, 7, 20, 12);
    const harness = await startHarness({
      now: () => now,
    });
    const host = await openClient(harness.webSocketUrl);
    const authenticated = await authenticate(
      host,
      harness.room,
      "host",
      "active-lease-host",
    );
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(viewer, harness.room, "viewer", "provisional-viewer");
    await host.inbox.next("peer-joined");

    now += 86_401_000;
    expect(harness.roomStore.expireRooms()).toEqual([]);
    await closeClient(host);
    await viewer.inbox.next("host-status");
    expect(harness.roomStore.getConnectedHost(harness.room.roomId)).toBeUndefined();
    expect(harness.roomStore.expireRooms(now + 86_399_999)).toEqual([]);
    const expired = harness.roomStore.expireRooms(now + 86_401_000);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ roomId: harness.room.roomId });
    expect(expired[0]?.sessionIds).toHaveLength(1);
    await closeClient(viewer);
    expect(authenticated.role).toBe("host");
  });

  it("leaves established authorization and media untouched when a grant update fails", async () => {
    const harness = await startHarness();
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
      .spyOn(harness.roomStore, "setViewerGrant")
      .mockImplementationOnce(() => {
        throw new Error("simulated database write failure");
      });
    const response = await fetch(
      `${harness.baseUrl}/api/rooms/${harness.room.roomId}/access`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.room.hostToken}`,
          "Content-Type": "application/json",
          Origin: allowedOrigin,
        },
        body: JSON.stringify({ action: "rotate-viewer-grant" }),
      },
    );
    expect(response.status).toBe(500);
    await expect(
      viewer.inbox.next("viewer-grant-revoked", 30),
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

  it("applies symmetric pause updates only to the exact current Host share", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const shareGeneration = "hybrid_pause_share_generation_12345678";
    const host = await openClient(harness.webSocketUrl);
    await authenticate(
      host,
      harness.room,
      "host",
      "hybrid-pause-host-client",
      1,
      shareGeneration,
    );
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "hybrid-pause-viewer-client",
    );

    host.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: true,
      }),
    );
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: true,
    });
    host.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: false,
      }),
    );
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: false,
    });

    const closed = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    host.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration: "stale_pause_share_generation_12345678",
        paused: true,
      }),
    );
    expect(await closed).toBe(4001);
  });

  it("retains authoritative pause when a reconnecting Host advertises unpaused", async () => {
    const harness = await startHarness({ peerAssistedMedia: false });
    const shareGeneration = "reconnect_resume_share_generation_12345678";
    const hostClientId = "reconnect-resume-host-client";
    const host = await openClient(harness.webSocketUrl);
    await authenticate(
      host,
      harness.room,
      "host",
      hostClientId,
      1,
      shareGeneration,
    );
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "reconnect-resume-viewer-client",
    );
    await host.inbox.next("peer-joined");

    host.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: true,
      }),
    );
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: true,
    });
    await closeClient(host);
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: false,
      paused: false,
    });

    const reconnectedHost = await openClient(harness.webSocketUrl);
    await authenticate(
      reconnectedHost,
      harness.room,
      "host",
      hostClientId,
      1,
      shareGeneration,
      { sharingPaused: false },
    );
    expect(
      await reconnectedHost.inbox.next("pause-sharing-source"),
    ).toEqual({
      type: "pause-sharing-source",
      shareGeneration,
    });
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: true,
    });

    reconnectedHost.socket.send(
      JSON.stringify({
        type: "set-sharing-paused",
        shareGeneration,
        paused: false,
      }),
    );
    expect(await viewer.inbox.next("host-status")).toMatchObject({
      online: true,
      paused: false,
    });
  });

  it("binds new-share quality and preserves active-share quality across reconnect", async () => {
    const harness = await startHarness({ peerAssistedMedia: true });
    const initialSettings: QualitySettings = {
      resolution: "1440p",
      maxFramerate: 60,
      maxBitrate: 8_000_000,
      degradationPreference: "maintain-resolution",
      screenAudioQuality: "very-high",
    };
    const firstGeneration = "first_share_generation_12345678";
    const viewer = await openClient(harness.webSocketUrl);
    await authenticate(
      viewer,
      harness.room,
      "viewer",
      "quality-viewer-client",
    );

    const host = await openClient(harness.webSocketUrl);
    const hostAuth = peerAssisted(
      await authenticate(
        host,
        harness.room,
        "host",
        "quality-host-client",
        1,
        firstGeneration,
        { qualitySettings: initialSettings },
      ),
    );
    expect(hostAuth.qualitySettings).toEqual(initialSettings);
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: initialSettings,
    });

    const reconnectSettings: QualitySettings = {
      resolution: "480p",
      maxFramerate: 15,
      maxBitrate: 2_000_000,
      degradationPreference: "maintain-framerate",
      screenAudioQuality: "saver",
    };
    const replaced = new Promise<number>((resolve) =>
      host.socket.once("close", (code) => resolve(code)),
    );
    const reconnectedHost = await openClient(harness.webSocketUrl);
    const reconnectedAuth = peerAssisted(
      await authenticate(
        reconnectedHost,
        harness.room,
        "host",
        "quality-host-client",
        1,
        firstGeneration,
        { qualitySettings: reconnectSettings },
      ),
    );
    expect(await replaced).toBe(4001);
    expect(reconnectedAuth.qualitySettings).toEqual(initialSettings);
    await expect(
      viewer.inbox.next("quality-settings", 30),
    ).rejects.toThrow("Timed out");

    const updatedSettings: QualitySettings = {
      ...initialSettings,
      resolution: "720p",
      maxFramerate: 30,
      maxBitrate: 3_000_000,
      degradationPreference: "balanced",
      screenAudioQuality: "music",
    };
    reconnectedHost.socket.send(
      JSON.stringify({
        type: "set-quality-settings",
        qualitySettings: updatedSettings,
      }),
    );
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: updatedSettings,
    });

    const stopped = new Promise<number>((resolve) =>
      reconnectedHost.socket.once("close", (code) => resolve(code)),
    );
    reconnectedHost.socket.send(
      JSON.stringify({
        type: "stop-sharing",
        shareGeneration: firstGeneration,
      }),
    );
    expect(await stopped).toBe(1000);
    await viewer.inbox.next("sharing-stopped");

    const nextHost = await openClient(harness.webSocketUrl);
    const nextAuth = peerAssisted(
      await authenticate(
        nextHost,
        harness.room,
        "host",
        "quality-host-client",
        1,
        "next_share_generation_12345678",
        {
          qualitySettings: reconnectSettings,
        },
      ),
    );
    expect(nextAuth.qualitySettings).toEqual(reconnectSettings);
    expect(await viewer.inbox.next("quality-settings")).toEqual({
      type: "quality-settings",
      qualitySettings: reconnectSettings,
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
    const unauthenticatedClosed = new Promise<number>((resolve) =>
      unauthenticated.socket.once("close", (code) => resolve(code)),
    );
    expect((await unauthenticated.inbox.next("error", 300)).code).toBe(
      "AUTH_REQUIRED",
    );
    expect(await unauthenticatedClosed).toBe(4003);

    const oversized = await openClient(harness.webSocketUrl);
    const closeCode = new Promise<number>((resolve) =>
      oversized.socket.once("close", (code) => resolve(code)),
    );
    oversized.socket.send("x".repeat(MAX_SIGNAL_BYTES + 1));
    expect(await closeCode).toBe(1009);
  });

  it("terminates stale v10 before authentication", async () => {
    const harness = await startHarness();
    const invalidClient = await openClient(harness.webSocketUrl);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      invalidClient.socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );

    invalidClient.socket.send(
      JSON.stringify({
        type: "authenticate",
        protocol: "screener-v10",
        roomId: harness.room.roomId,
        role: "viewer",
        clientId: "invalid-client",
      }),
    );

    expect(await invalidClient.inbox.next("error")).toMatchObject({
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
