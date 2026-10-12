import { readFile } from "node:fs/promises";

export interface PacketFlow {
  source: string;
  destination: string;
  sourcePort: number;
  destinationPort: number;
  kind: "rtp" | "rtcp" | "stun" | "other";
  packets: number;
  bytes: number;
  firstMs: number;
  lastMs: number;
}

// Read the bounded Ethernet pcap produced by this lab, not arbitrary capture
// formats. Only clear transport headers are inspected (RFC 5761); no decryption.
export function packetFlows(data: Buffer): PacketFlow[] {
  if (data.length < 24 || data.readUInt32LE(0) !== 0xa1b2c3d4 || data.readUInt32LE(20) !== 1) {
    throw new Error("Expected little-endian Ethernet pcap with microsecond timestamps");
  }
  const flows = new Map<string, PacketFlow>();
  for (let offset = 24; offset < data.length;) {
    if (offset + 16 > data.length) throw new Error("Truncated pcap record");
    const timestamp = data.readUInt32LE(offset) * 1000 + data.readUInt32LE(offset + 4) / 1000;
    const size = data.readUInt32LE(offset + 8);
    if (size > 96 || offset + 16 + size > data.length) throw new Error("Invalid laboratory capture length");
    const frame = data.subarray(offset + 16, offset + 16 + size); offset += 16 + size;
    if (frame.length < 14) throw new Error("Truncated Ethernet header");
    const etherType = frame.readUInt16BE(12);
    let ipLength: number, source: string, destination: string;
    if (etherType === 0x0800) {
      if (frame.length < 34 || frame[23] !== 17) continue;
      ipLength = (frame[14]! & 15) * 4;
      if (ipLength < 20 || (frame.readUInt16BE(20) & 0x3fff) !== 0) throw new Error("Unexpected fragmented laboratory UDP");
      source = [...frame.subarray(26, 30)].join("."); destination = [...frame.subarray(30, 34)].join(".");
    } else if (etherType === 0x86dd) {
      if (frame.length < 54 || frame[20] !== 17) continue;
      ipLength = 40;
      const address = (start: number) => Array.from({ length: 8 }, (_, index) => frame.readUInt16BE(start + index * 2).toString(16)).join(":");
      source = address(22); destination = address(38);
    } else continue;
    const udp = 14 + ipLength, payload = udp + 8;
    if (frame.length < payload + 2) throw new Error("Truncated UDP header");
    const sourcePort = frame.readUInt16BE(udp), destinationPort = frame.readUInt16BE(udp + 2);
    const kind = (frame[payload]! & 0xc0) === 0x80
      ? (frame[payload + 1]! >= 192 && frame[payload + 1]! <= 223 ? "rtcp" : "rtp")
      : frame.length >= payload + 8 && frame.readUInt32BE(payload + 4) === 0x2112a442 ? "stun" : "other";
    const key = `${source}:${sourcePort}>${destination}:${destinationPort}/${kind}`;
    const flow = flows.get(key) ?? { source, destination, sourcePort, destinationPort, kind,
      packets: 0, bytes: 0, firstMs: timestamp, lastMs: timestamp };
    flow.packets++; flow.bytes += frame.readUInt16BE(udp + 4); flow.lastMs = timestamp; flows.set(key, flow);
  }
  return [...flows.values()];
}

export async function readPacketFlows(path: string): Promise<PacketFlow[]> {
  return packetFlows(await readFile(path));
}

export function checkMediaFeedback(flows: PacketFlow[], source: string, destination: string): void {
  const media = flows.filter(flow => flow.source === source && flow.destination === destination && flow.kind === "rtp" && flow.packets >= 30);
  if (!media.some(flow => flows.some(reply => reply.kind === "rtcp" && reply.source === destination && reply.destination === source &&
    reply.sourcePort === flow.destinationPort && reply.destinationPort === flow.sourcePort && reply.packets > 1 && reply.lastMs > flow.firstMs))) {
    throw new Error(`Missing WAN media/feedback pair: ${source} -> ${destination}`);
  }
}
