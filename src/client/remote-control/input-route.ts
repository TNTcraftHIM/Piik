export type InputIdentity = { endpointId: string; secret: string };
export type InputPacket = { id?: string; epoch?: string; data?: string; closed?: boolean; ready?: boolean };
export type InputTransport = Pick<RTCDataChannel, "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener" | "removeEventListener">;

const MAX_QUEUED_BASE64_CHARS = 8192;

// Keys arrive over authenticated room signaling. An intermediate Viewer/SFU
// transports ciphertext and cannot impersonate the approved controller.
export class EncryptedInput extends EventTarget implements InputTransport {
  readonly epoch: string;
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  private received = 0n;
  private readonly key: Promise<CryptoKey>;
  private outbound = Promise.resolve();
  private inbound = Promise.resolve();
  private incomingBase64Chars = 0;
  constructor(private readonly identity: InputIdentity, private readonly counter: { sent: bigint }, private readonly transmit: (packet: InputPacket) => void,
    epoch = crypto.randomUUID().replaceAll("-", "")) {
    super();
    this.epoch = epoch;
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
    if (this.incomingBase64Chars + data.length > MAX_QUEUED_BASE64_CHARS) { this.close(); return; }
    this.incomingBase64Chars += data.length;
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
      .finally(() => { this.incomingBase64Chars -= data.length; });
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.transmit({ id: this.identity.endpointId, epoch: this.epoch, closed: true });
    this.dispatchEvent(new Event("close"));
  }
}
