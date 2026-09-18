// Only the preview runner mounts this room authority. No persistence or logging
// of SDP or device identifiers; props are transient and never replayed.
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ROOM_LIMIT, commandSchema,
  type Member, type RoomEvent } from "../src/client/prototypes/interactions/protocol";

export function createInteractionRooms() {
  const server = new WebSocketServer({ noServer: true, maxPayload: 48_000 });
  type Peer = { socket: WebSocket; member: Member; lastProp: number };
  type Room = { peers: Map<string, Peer> };
  const rooms = new Map<string, Room>();
  const send = (socket: WebSocket, event: RoomEvent) => {
    if (socket.bufferedAmount > 256_000) { socket.close(1008, "Slow receiver"); return; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };
  const broadcast = (room: Room, event: RoomEvent) => {
    for (const peer of room.peers.values()) send(peer.socket, event);
  };
  const roster = (room: Room) => broadcast(room, {
    type: "members", members: Array.from(room.peers.values(), (peer) => peer.member),
  });
  server.on("connection", (socket) => {
    let room: Room | undefined;
    let code = "";
    const member: Member = { id: randomUUID(), name: "", role: "viewer", mic: false, source: null };
    const peer: Peer = { socket, member, lastProp: 0 };
    let windowStart = Date.now();
    let messages = 0;
    const joinDeadline = setTimeout(() => socket.close(1008, "Join required"), 5_000);
    socket.on("message", (data, binary) => {
      const now = Date.now();
      if (now - windowStart > 1_000) { messages = 0; windowStart = now; }
      if (binary || ++messages > 100) { socket.close(1008, "Invalid traffic"); return; }
      let json: unknown;
      try { json = JSON.parse(data.toString()); } catch { socket.close(1008, "Invalid JSON"); return; }
      const parsed = commandSchema.safeParse(json);
      if (!parsed.success) { send(socket, { type: "error", code: "invalid" }); return; }
      const command = parsed.data;
      if (command.type === "join") {
        if (room) return;
        const found = rooms.get(command.room);
        if ((!found && rooms.size >= 8) || (found && found.peers.size >= ROOM_LIMIT)) {
          send(socket, { type: "error", code: "room-full" }); return;
        }
        code = command.room;
        room = found ?? { peers: new Map() };
        rooms.set(code, room);
        member.role = found ? "viewer" : "host";
        member.name = command.name;
        room.peers.set(member.id, peer);
        clearTimeout(joinDeadline);
        send(socket, { type: "welcome", self: member.id });
        roster(room);
        return;
      }
      if (!room) { socket.close(1008, "Join required"); return; }
      if (command.type === "signal") {
        const target = room.peers.get(command.to);
        if (target && target !== peer && member.role !== target.member.role) {
          if (command.signal.kind === "description" &&
              (command.signal.type === "offer") !== (member.role === "host")) return;
          send(target.socket, { type: "signal", from: member.id, signal: command.signal });
        }
        return;
      }
      if (command.type === "devices") {
        if (member.role !== "host") { send(socket, { type: "error", code: "host-only" }); return; }
        member.mic = command.source !== null && command.mic;
        member.source = command.source;
        roster(room);
        return;
      }
      if (!Array.from(room.peers.values()).some((peer) => peer.member.role === "host" && peer.member.source !== null)) {
        send(socket, { type: "error", code: "not-sharing" }); return;
      }
      if (now - peer.lastProp < 450) { send(socket, { type: "error", code: "slow-down" }); return; }
      if (!room.peers.has(command.target)) {
        send(socket, { type: "error", code: "target-left" }); return;
      }
      peer.lastProp = now;
      broadcast(room, { type: "prop", id: randomUUID(), from: member.id, target: command.target, prop: command.prop });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(joinDeadline);
      // A retired room's late close must not delete its replacement at this code.
      if (!room || rooms.get(code) !== room) return;
      room.peers.delete(member.id);
      if (member.role === "host") {
        rooms.delete(code);
        for (const remaining of room.peers.values()) {
          send(remaining.socket, { type: "error", code: "host-left" });
          remaining.socket.close(1000, "Host left");
        }
        room.peers.clear();
        return;
      }
      if (room.peers.size) roster(room); else rooms.delete(code);
    });
  });
  return server;
}
