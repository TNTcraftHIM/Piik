import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  MAX_SIGNAL_BYTES,
  decodeServerMessage,
  type Role,
  type ServerMessage,
} from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import { RoomStore, type CreatedRoom } from "../src/server/room-store.ts";

const allowedOrigin = "http://allowed.test";
let runningServer: ScreenerServer | undefined;

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
});

class MessageInbox {
  private readonly messages: ServerMessage[] = [];
  private readonly waiters: Array<{
    type: ServerMessage["type"];
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = decodeServerMessage(data.toString());
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
}

interface TestClient {
  socket: WebSocket;
  inbox: MessageInbox;
}

interface SignalHarness {
  webSocketUrl: string;
  roomStore: RoomStore;
  room: CreatedRoom;
}

function testConfig(): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    publicBaseUrl: new URL("https://share.example.test"),
    allowedOrigins: new Set([allowedOrigin]),
    roomTtlMs: 14_400_000,
    maxRooms: 10,
    stunUrls: [],
    turnUrls: [],
    turnCredentialTtlSeconds: 3_600,
  };
}

async function startHarness(
  overrides: {
    authenticationTimeoutMs?: number;
    viewerDisconnectGraceMs?: number;
    maxSignalConnections?: number;
    maxUnauthenticatedSignalConnections?: number;
  } = {},
): Promise<SignalHarness> {
  const config = testConfig();
  const roomStore = new RoomStore({
    ttlMs: config.roomTtlMs,
    maxRooms: config.maxRooms,
  });
  const room = roomStore.createRoom();
  runningServer = await createScreenerServer({
    config,
    roomStore,
    serveFrontend: false,
    authenticationTimeoutMs: overrides.authenticationTimeoutMs ?? 500,
    viewerDisconnectGraceMs: overrides.viewerDisconnectGraceMs ?? 50,
    heartbeatIntervalMs: 60_000,
    cleanupIntervalMs: 60_000,
    maxSignalConnections: overrides.maxSignalConnections,
    maxUnauthenticatedSignalConnections:
      overrides.maxUnauthenticatedSignalConnections,
  });
  const port = await runningServer.listen(0, "127.0.0.1");
  return { webSocketUrl: `ws://127.0.0.1:${port}/signal`, roomStore, room };
}

async function openClient(webSocketUrl: string): Promise<TestClient> {
  const socket = new WebSocket(webSocketUrl, { origin: allowedOrigin });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox: new MessageInbox(socket) };
}

async function rejectedUpgradeStatus(webSocketUrl: string): Promise<number | undefined> {
  const socket = new WebSocket(webSocketUrl, { origin: allowedOrigin });
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
) {
  client.socket.send(
    JSON.stringify({
      type: "authenticate",
      roomId: room.roomId,
      role,
      token: role === "host" ? room.hostToken : room.viewerToken,
      clientId,
    }),
  );
  return client.inbox.next("authenticated");
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

    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    expect((await host.inbox.next("peer-joined")).peerId).toBe(viewerAuth.peerId);
    expect(await viewer.inbox.next("host-status")).toEqual({
      type: "host-status",
      online: true,
    });
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

  it("atomically replaces the same client socket without leave churn", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 40 });
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    const original = await openClient(harness.webSocketUrl);
    const originalAuth = await authenticate(
      original,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );
    await host.inbox.next("peer-joined");

    const originalClosed = new Promise<number>((resolve) =>
      original.socket.once("close", (code) => resolve(code)),
    );
    const replacement = await openClient(harness.webSocketUrl);
    const replacementAuth = await authenticate(
      replacement,
      harness.room,
      "viewer",
      "viewer-client-stable",
    );

    expect(replacementAuth.peerId).toBe(originalAuth.peerId);
    expect(await originalClosed).toBe(4001);
    expect((await host.inbox.next("peer-joined")).peerId).toBe(originalAuth.peerId);
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

  it("keeps a grace-period viewer in the host roster and announces its return", async () => {
    const harness = await startHarness({ viewerDisconnectGraceMs: 500 });
    const firstHost = await openClient(harness.webSocketUrl);
    await authenticate(firstHost, harness.room, "host", "host-client-grace-roster");
    const firstViewer = await openClient(harness.webSocketUrl);
    const firstViewerAuth = await authenticate(
      firstViewer,
      harness.room,
      "viewer",
      "viewer-client-grace-roster",
    );
    await firstHost.inbox.next("peer-joined");
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
    await closeClient(firstHost);

    const secondHost = await openClient(harness.webSocketUrl);
    const secondHostAuth = await authenticate(
      secondHost,
      harness.room,
      "host",
      "host-client-grace-roster",
    );
    expect(secondHostAuth.viewerPeerIds).toEqual([firstViewerAuth.peerId]);
    await secondHost.inbox.expectNone(30);

    const secondViewer = await openClient(harness.webSocketUrl);
    const secondViewerAuth = await authenticate(
      secondViewer,
      harness.room,
      "viewer",
      "viewer-client-grace-roster",
    );
    expect(secondViewerAuth.peerId).toBe(firstViewerAuth.peerId);
    expect(secondViewerAuth.connectionId).toBe("connection-during-grace");
    expect((await secondHost.inbox.next("peer-joined")).peerId).toBe(
      firstViewerAuth.peerId,
    );

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

  it("rejects a fourth viewer and lets the host close the room", async () => {
    const harness = await startHarness();
    const host = await openClient(harness.webSocketUrl);
    await authenticate(host, harness.room, "host", "host-client-stable");
    const viewers: TestClient[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const viewer = await openClient(harness.webSocketUrl);
      await authenticate(viewer, harness.room, "viewer", `viewer-client-${index}`);
      await host.inbox.next("peer-joined");
      viewers.push(viewer);
    }

    const fourth = await openClient(harness.webSocketUrl);
    fourth.socket.send(
      JSON.stringify({
        type: "authenticate",
        roomId: harness.room.roomId,
        role: "viewer",
        token: harness.room.viewerToken,
        clientId: "viewer-client-4",
      }),
    );
    expect((await fourth.inbox.next("error")).code).toBe("ROOM_FULL");

    host.socket.send(JSON.stringify({ type: "close-room" }));
    expect(await host.inbox.next("room-closed")).toMatchObject({ reason: "host-ended" });
    for (const viewer of viewers) {
      expect(await viewer.inbox.next("room-closed")).toMatchObject({
        reason: "host-ended",
      });
    }
  });

  it("requires an allowed Origin, timely authentication, and bounded payloads", async () => {
    const harness = await startHarness({ authenticationTimeoutMs: 30 });
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
