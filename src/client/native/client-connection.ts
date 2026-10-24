import type { NativeClient } from "./client";

// One page/session owns one lazy App control connection. Acquisition and
// retirement share the same identity, including results arriving after release.
export class NativeClientConnection {
  private client: NativeClient | null = null;
  private pending: { promise: Promise<NativeClient | null>; controller: AbortController } | null = null;
  private stopWatching: (() => void) | null = null;

  constructor(private readonly connect: (signal: AbortSignal) => Promise<NativeClient | null>,
    private readonly disconnected: () => void = () => {}) {}

  get current(): NativeClient | null { return this.client; }

  acquire(beforeConnect?: Promise<void>): Promise<NativeClient | null> {
    if (this.pending) return this.pending.promise;
    if (!beforeConnect && this.client) return Promise.resolve(this.client);
    const controller = new AbortController();
    const discovery: Promise<NativeClient | null> = beforeConnect
      ? beforeConnect.then(() => {
        if (this.pending !== connecting) return null;
        return this.client ?? this.connect(controller.signal);
      })
      : this.connect(controller.signal);
    const promise = discovery.then(client => {
      if (this.pending !== connecting) {
        client?.close();
        return null;
      }
      this.pending = null;
      if (client) this.adopt(client);
      return this.client;
    }).finally(() => {
      if (this.pending === connecting) this.pending = null;
    });
    const connecting = { promise, controller };
    this.pending = connecting;
    return promise;
  }

  adopt(client: NativeClient): void {
    if (this.client === client) return;
    this.release();
    this.client = client;
    this.stopWatching = client.onClose(() => {
      if (this.client !== client) return;
      this.client = null;
      this.stopWatching = null;
      this.cancelDiscovery();
      this.disconnected();
    });
  }

  discard(client: NativeClient): void {
    if (this.client === client) this.release();
    else client.close();
  }

  release(): void {
    this.cancelDiscovery();
    this.stopWatching?.();
    this.stopWatching = null;
    const client = this.client;
    this.client = null;
    client?.close();
  }

  private cancelDiscovery(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.controller.abort();
  }
}
