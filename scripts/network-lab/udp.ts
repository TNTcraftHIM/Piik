import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { SITE_IP } from "./network";

const targets = [{ host: SITE_IP, port: 41001 }, { host: SITE_IP, port: 41002 }, { host: "198.51.100.2", port: 41001 }];

export async function echoWorker(): Promise<void> {
  const sockets: Socket[] = [];
  try {
    for (const { host, port } of targets) {
      const socket = createSocket("udp4"); sockets.push(socket);
      socket.on("message", (data, remote) => {
        if (data.length !== 1200 || data.readUInt32BE(0) !== 0x50494c42) return;
        const reply = Buffer.from(data);
        reply.writeUInt16BE(remote.port, 16);
        remote.address.split(".").forEach((part, index) => reply[18 + index] = Number(part));
        socket.send(reply, remote.port, remote.address, () => {});
      });
      socket.bind(port, host); await once(socket, "listening");
    }
    process.stdout.write(JSON.stringify({ ready: true }) + "\n");
    await new Promise<void>(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
  } finally { for (const socket of sockets) socket.close(); }
}

export interface ProbeResult {
  sent: number;
  received: number;
  receivedBytes: number;
  durationMs: number;
  rttMs: number[];
  mappings: Array<{ destination: string; address: string; port: number }>;
}

/** Survey and peer rendezvous retain one socket, independently of ICE/Piik. */
export async function preparePeerProbe() {
  const socket = createSocket("udp4"), result = { requests: 0, replies: 0, errors: [] as string[] };
  let closed = false, peer: { address: string; port: number } | null = null;
  const close = () => { if (!closed) { closed = true; socket.close(); } };
  socket.on("error", error => result.errors.push(error.message));
  socket.on("message", (data, remote) => {
    if (data.length !== 8 || data.readUInt32BE(0) !== 0x50495052 || !peer || remote.address !== peer.address) return;
    if (data[4] === 1) { result.replies++; return; }
    result.requests++;
    const reply = Buffer.from(data); reply[4] = 1;
    socket.send(reply, remote.port, remote.address, () => {});
  });
  socket.bind(0, "0.0.0.0"); await once(socket, "listening");
  try {
    const observed = once(socket, "message", { signal: AbortSignal.timeout(2000) });
    const request = Buffer.alloc(1200); request.writeUInt32BE(0x50494c42, 0);
    socket.send(request, targets[0]!.port, targets[0]!.host, () => {});
    const [reply] = await observed as [Buffer];
    if (reply.length !== 1200 || reply.readUInt32BE(0) !== 0x50494c42) throw new Error("Invalid rendezvous survey response");
    return { mapping: { address: [...reply.subarray(18, 22)].join("."), port: reply.readUInt16BE(16) }, close,
      async run(destination: { address: string; port: number }) {
        peer = destination;
        try {
          for (let attempt = 0; attempt < 20; attempt++) {
            const packet = Buffer.alloc(8); packet.writeUInt32BE(0x50495052, 0); packet[5] = attempt;
            socket.send(packet, peer.port, peer.address, () => {}); await delay(100);
          }
          await delay(300); return result;
        } finally { close(); }
      },
    };
  } catch (error) { close(); throw error; }
}

export async function udpProbe(load: boolean): Promise<ProbeResult> {
  const socket = createSocket("udp4"), start = performance.now();
  const result: ProbeResult = { sent: 0, received: 0, receivedBytes: 0, durationMs: 0, rttMs: [], mappings: [] };
  const seen = new Set<number>();
  socket.on("message", (data, remote) => {
    if (data.length !== 1200 || data.readUInt32BE(0) !== 0x50494c42) return;
    const id = data.readUInt32BE(4);
    if (id >= result.sent || seen.has(id)) return;
    seen.add(id); result.received++; result.receivedBytes += data.length;
    result.rttMs.push(performance.now() - data.readDoubleBE(8));
    const destination = `${remote.address}:${remote.port}`;
    if (!result.mappings.some(value => value.destination === destination)) result.mappings.push({
      destination, address: [...data.subarray(18, 22)].join("."), port: data.readUInt16BE(16),
    });
  });
  socket.bind(0, "0.0.0.0"); await once(socket, "listening");
  try {
    const count = load ? 1000 : 12;
    for (let i = 0; i < count; i++) {
      const target = targets[load ? 0 : i % targets.length]!;
      const packet = Buffer.alloc(1200); packet.writeUInt32BE(0x50494c42, 0);
      packet.writeUInt32BE(result.sent++, 4); packet.writeDoubleBE(performance.now(), 8);
      await new Promise<void>((resolve, reject) => socket.send(packet, target.port, target.host, error => error ? reject(error) : resolve()));
      await delay(load ? 1 : 20);
    }
    await delay(load ? 1000 : 600);
    result.durationMs = performance.now() - start;
    return result;
  } finally { socket.close(); }
}
