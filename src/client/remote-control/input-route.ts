export const INPUT_CHANNEL = "silip-remote-input-prototype-v1";
export type InputIdentity = { endpointId: string; secret: string };
type Packet = { id?: string; epoch?: string; data?: string; closed?: boolean; ready?: boolean };
export type InputTransport = Pick<RTCDataChannel, "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener" | "removeEventListener">;

function packet(data: unknown): Packet | null {
  if (typeof data !== "string" || data.length > 6144) return null;
  try {
    const p = JSON.parse(data) as Packet;
    return p && (typeof p.ready === "boolean" || typeof p.id === "string" && /^[0-9a-f]{32}$/.test(p.id) &&
      typeof p.epoch === "string" && /^[0-9a-f]{32}$/.test(p.epoch) && (p.closed === true || typeof p.data === "string")) ? p : null;
  } catch { return null; }
}
function send(channel: RTCDataChannel | null, p: Packet): void {
  if (channel?.readyState !== "open") return;
  if (channel.bufferedAmount > 8192) { channel.close(); return; }
  try { channel.send(JSON.stringify(p)); } catch { channel.close(); }
}

// One small adapter follows the committed media input and existing relay edges.
// It selects no route and keeps neither permissions nor input history.
export class InputRoute {
  private up: RTCDataChannel | null = null;
  private ready = false;
  private endpoint: EncryptedInput | null = null;
  private identity: InputIdentity | null = null;
  private counter = { sent: 0n };
  private register: ((identity: InputIdentity) => boolean) | null = null;
  private children = new Map<RTCDataChannel, Map<string, string>>();
  constructor(private readonly changed: () => void) {}
  get current(): InputTransport | null { return this.endpoint; }

  enable(register: (identity: InputIdentity) => boolean): void {
    this.register = register;
    this.reauthenticate();
  }
  reauthenticate(): void {
    this.retireEndpoint();
    this.identity = null;
    this.counter = { sent: 0n };
    this.refreshEndpoint();
  }
  setUpstream(channel: RTCDataChannel | null): void {
    if (this.up === channel) return;
    if (this.up) {
      this.up.removeEventListener("message", this.received);
      this.up.removeEventListener("close", this.lost);
      this.up.removeEventListener("open", this.opened);
      for (const ids of this.children.values()) {
        for (const [id, epoch] of ids) send(this.up, { id, epoch, closed: true });
        ids.clear();
      }
    }
    this.retireEndpoint();
    this.ready = false;
    this.up = channel;
    this.broadcast({ ready: false });
    channel?.addEventListener("message", this.received);
    channel?.addEventListener("close", this.lost);
    channel?.addEventListener("open", this.opened);
    if (channel?.readyState === "open") this.opened();
  }
  private readonly opened = (): void => send(this.up, { ready: true });
  private readonly lost = (): void => { this.ready = false; this.retireEndpoint(); this.broadcast({ ready: false }); };
  private readonly received = (event: MessageEvent): void => {
    const p = packet(event.data); if (!p) return;
    if (p.ready !== undefined && p.id) {
      if (p.ready && p.id === this.identity?.endpointId) this.endpoint?.send(JSON.stringify({ type: "sync" }));
    } else if (p.ready !== undefined) {
      this.ready = p.ready;
      if (!p.ready) this.retireEndpoint(); else this.refreshEndpoint();
    } else if (p.id === this.identity?.endpointId && p.epoch === this.endpoint?.epoch && p.data) this.endpoint?.receive(p.data);
    this.broadcast(p);
  };
  private broadcast(p: Packet): void { for (const child of this.children.keys()) send(child, p); }
  private refreshEndpoint(): void {
    if (this.endpoint || !this.ready || !this.register || !crypto.subtle) return;
    if (!this.identity) {
      const identity = { endpointId: crypto.randomUUID().replaceAll("-", ""),
        secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("") };
      if (!this.register(identity)) return;
      this.identity = identity;
    }
    this.endpoint = new EncryptedInput(this.identity, this.counter, p => send(this.up, p));
    this.changed();
  }
  private retireEndpoint(): void {
    this.endpoint?.close();
    this.endpoint = null;
    this.changed();
  }
  attachChild(channel: RTCDataChannel, connection: RTCPeerConnection): void {
    const ids = new Map<string, string>();
    this.children.set(channel, ids);
    connection.addEventListener("connectionstatechange", () => {
      if (!this.children.has(channel)) return;
      if (connection.connectionState === "disconnected" || connection.connectionState === "failed" || connection.connectionState === "closed") {
        for (const [id, epoch] of ids) send(this.up, { id, epoch, closed: true });
        ids.clear();
      }
    });
    channel.addEventListener("open", () => send(channel, { ready: this.ready }));
    channel.addEventListener("message", event => {
      const p = packet(event.data); if (!p || !this.children.has(channel)) return;
      if (p.ready !== undefined) { send(channel, { ready: this.ready }); return; }
      if (!this.ready || !p.id || !p.epoch) return;
      if (p.closed) { if (ids.get(p.id) === p.epoch) ids.delete(p.id); }
      else { if (!ids.has(p.id) && ids.size >= 20) return; ids.set(p.id, p.epoch); }
      send(this.up, p);
    });
    channel.addEventListener("close", () => {
      if (!this.children.delete(channel)) return;
      for (const [id, epoch] of ids) send(this.up, { id, epoch, closed: true });
    });
    if (channel.readyState === "open") send(channel, { ready: this.ready });
  }
  dispose(): void {
    this.setUpstream(null);
    this.identity = null;
    this.register = null;
    for (const child of this.children.keys()) child.close();
    this.children.clear();
  }
}

// Keys arrive over authenticated room signaling. An intermediate Viewer/SFU
// transports ciphertext and cannot impersonate the approved controller.
class EncryptedInput extends EventTarget implements InputTransport {
  readonly epoch = crypto.randomUUID().replaceAll("-", "");
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  private received = 0n;
  private readonly key: Promise<CryptoKey>;
  private outbound = Promise.resolve();
  private inbound = Promise.resolve();
  private incomingBytes = 0;
  constructor(private readonly identity: InputIdentity, private readonly counter: { sent: bigint }, private readonly transmit: (packet: Packet) => void) {
    super();
    this.key = crypto.subtle.importKey("raw", Uint8Array.from(identity.secret.match(/../g)!, b => parseInt(b, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open" || typeof data !== "string") return;
    const plain = new TextEncoder().encode(data);
    this.bufferedAmount += plain.length;
    this.outbound = this.outbound.then(async () => {
      if (this.readyState !== "open") return;
      const header = new Uint8Array(20);
      new DataView(header.buffer).setBigUint64(0, ++this.counter.sent);
      crypto.getRandomValues(header.subarray(8));
      const aad = new Uint8Array(41); aad.set(header.subarray(0, 8), 1); aad.set(new TextEncoder().encode(this.epoch), 9);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: header.subarray(8), additionalData: aad }, await this.key, plain));
      if (this.readyState !== "open") return;
      const bytes = new Uint8Array(header.length + encrypted.length);
      bytes.set(header); bytes.set(encrypted, header.length);
      this.transmit({ id: this.identity.endpointId, epoch: this.epoch, data: btoa(String.fromCharCode(...bytes)) });
    }).catch(() => this.close()).finally(() => { this.bufferedAmount -= plain.length; });
  }
  receive(data: string): void {
    if (this.incomingBytes + data.length > 8192) { this.close(); return; }
    this.incomingBytes += data.length;
    this.inbound = this.inbound.then(async () => {
      if (this.readyState !== "open") return;
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      if (bytes.length < 36) return;
      const sequence = new DataView(bytes.buffer).getBigUint64(0);
      if (sequence <= this.received) return;
      const aad = new Uint8Array(41); aad[0] = 1; aad.set(bytes.subarray(0, 8), 1); aad.set(new TextEncoder().encode(this.epoch), 9);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(8, 20), additionalData: aad }, await this.key, bytes.slice(20));
      if (this.readyState !== "open") return;
      this.received = sequence;
      this.dispatchEvent(new MessageEvent("message", { data: new TextDecoder().decode(plain) }));
    }).catch(() => { /* Unauthenticated relay data has no input meaning. */ })
      .finally(() => { this.incomingBytes -= data.length; });
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.transmit({ id: this.identity.endpointId, epoch: this.epoch, closed: true });
    this.dispatchEvent(new Event("close"));
  }
}
