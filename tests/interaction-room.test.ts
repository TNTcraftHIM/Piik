import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { createInteractionRooms } from "../scripts/interaction-room";
import type { Command, RoomEvent } from "../src/client/prototypes/interactions/protocol";

const sockets: WebSocket[] = [];
let http: Server;
let rooms: WebSocketServer;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const socket of rooms.clients) socket.terminate();
  await new Promise<void>((resolve) => rooms.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
});
async function setup() {
  rooms = createInteractionRooms();
  http = createServer();
  http.on("upgrade", (request, socket, head) => rooms.handleUpgrade(request, socket, head,
    (client) => rooms.emit("connection", client, request)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return async (name: string, room = "9527") => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    sockets.push(ws);
    const events: RoomEvent[] = [];
    ws.on("message", (data) => events.push(JSON.parse(data.toString()) as RoomEvent));
    await once(ws, "open");
    const send = (command: Command) => ws.send(JSON.stringify(command));
    send({ type: "join", name, room });
    await vi.waitFor(() => expect(events.some((event) => event.type === "welcome")).toBe(true));
    const welcome = events.find((event) => event.type === "welcome")!;
    const member = (id = welcome.self) => events.filter((event) => event.type === "members").at(-1)!.members.find((value) => value.id === id)!;
    return { ws, events, send, id: welcome.self, member };
  };
}

test("props require an active share, stay inside the room, and never replay to later arrivals", async () => {
  const join = await setup();
  const a = await join("Alice");
  const b = await join("Bob");
  const outsider = await join("Other room", "1234");
  a.send({ type: "prop", target: b.id, prop: "tomato" });
  await vi.waitFor(() => expect(a.events).toContainEqual({ type: "error", code: "not-sharing" }));
  expect(b.events.some((event) => event.type === "prop")).toBe(false);
  a.send({ type: "devices", mic: false, source: "camera" });
  a.send({ type: "prop", target: outsider.id, prop: "tomato" });
  await vi.waitFor(() => expect(a.events).toContainEqual({ type: "error", code: "target-left" }));
  a.send({ type: "prop", target: b.id, prop: "poop" });
  await vi.waitFor(() => expect(b.events.some((event) => event.type === "prop" && event.from === a.id)).toBe(true));
  expect(outsider.events.some((event) => event.type === "prop")).toBe(false);
  a.send({ type: "prop", target: b.id, prop: "tomato" });
  await vi.waitFor(() => expect(a.events).toContainEqual({ type: "error", code: "slow-down" }));
  expect(b.events.filter((event) => event.type === "prop")).toHaveLength(1);
  const c = await join("Carol");
  expect(c.events.some((event) => event.type === "prop")).toBe(false);
  a.events.length = 0;
  a.send({ type: "devices", mic: false, source: null });
  a.send({ type: "prop", target: b.id, prop: "heart" });
  await vi.waitFor(() => expect(a.events).toContainEqual({ type: "error", code: "not-sharing" }));
  const retired = Promise.all([a, b, c].map((peer) => once(peer.ws, "close")));
  a.ws.close();
  await retired;
  expect(b.events).toContainEqual({ type: "error", code: "host-left" });
  const next = await join("New room");
  expect(next.member().role).toBe("host");
  expect(next.events.some((event) => event.type === "prop")).toBe(false);
});

test("only the Host publishes and signaling is restricted to current Host–Viewer pairs", async () => {
  const join = await setup();
  const people: Awaited<ReturnType<typeof join>>[] = [];
  for (let index = 0; index < 5; index++) {
    const peer = await join(`Person ${index}`);
    people.push(peer);
  }
  const [a, b, c] = people;
  expect(a.member().role).toBe("host");
  expect(people.slice(1).every((peer) => peer.member().role === "viewer")).toBe(true);
  b.send({ type: "devices", mic: true, source: "camera" });
  await vi.waitFor(() => expect(b.events).toContainEqual({ type: "error", code: "host-only" }));
  expect(b.member()).toMatchObject({ mic: false, source: null });
  const signal = { type: "signal", to: b.id,
    signal: { kind: "description", type: "offer", sdp: "test only" } } satisfies Command;
  a.send(signal);
  await vi.waitFor(() => expect(b.events.filter((event) => event.type === "signal")).toHaveLength(1));
  b.send({ ...signal, to: c.id });
  b.send({ ...signal, to: a.id });
  b.send({ ...signal, to: a.id, signal: { kind: "description", type: "answer", sdp: "answer" } });
  // A same-socket reply proves the earlier signaling commands were processed.
  b.send({ type: "prop", target: c.id, prop: "heart" });
  await vi.waitFor(() => expect(b.events).toContainEqual({ type: "error", code: "not-sharing" }));
  expect(a.events.filter((event) => event.type === "signal")).toHaveLength(1);
  expect(c.events.filter((event) => event.type === "signal")).toHaveLength(0);
  b.ws.close();
  await once(b.ws, "close");
  const replacement = await join("Rejoined viewer");
  expect(replacement.id).not.toBe(b.id);
  a.send(signal);
  a.send({ type: "devices", mic: true, source: "camera" });
  await vi.waitFor(() => expect(replacement.member(a.id).source).toBe("camera"));
  expect(replacement.events.filter((event) => event.type === "signal")).toHaveLength(0);
});
