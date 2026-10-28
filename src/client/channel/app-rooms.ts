import type { HostedRoom } from "./hosting";
import type { RoomSummary, ConversationReply } from "./protocol";

/** One approved local connection owns room execution; the Browser owns participation. */
export class AppRooms {
  private socket: WebSocket;
  private requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor(port: string, token: string, channelId: string, userId: string, onClose: () => void) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !token) throw new Error("invalid_app_link");
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${port}/rooms`, `piik-channel-rooms.${token}`);
    const lost = () => { this.close(); onClose(); };
    this.timer = setTimeout(lost, 10000);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      socket.onopen = () => {
        void this.request({ type: "hello", channelId, userId }).then(() => {
          clearTimeout(this.timer);
          resolve();
        }, error => { reject(error); lost(); });
      };
    });
    socket.onmessage = ({ data }) => {
      try {
        const reply = JSON.parse(String(data)) as { id: string; result?: unknown; error?: string };
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        if (reply.error) request.reject(new Error(reply.error));
        else request.resolve(reply.result);
      } catch { lost(); }
    };
    socket.onclose = lost;
    socket.onerror = () => { /* Close retires the connection and its requests. */ };
  }

  private request<T>(command: object): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("app_disconnected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve: value => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ ...command, id }));
    });
  }

  async storedPolicies(): Promise<string[]> {
    await this.ready;
    return this.request({ type: "policies" });
  }

  async open(policy: string): Promise<HostedRoom> {
    await this.ready;
    const roomId = await this.request<string>({ type: "open", policy });
    return {
      roomId,
      summary: () => this.request<RoomSummary>({ type: "summary", roomId }),
      currentReaders: () => this.request<string[]>({ type: "readers", roomId }),
      bind: bindingId => this.request<void>({ type: "bind", roomId, bindingId }),
      dispatch: input => this.request({ type: "dispatch", roomId, input }),
      dispatchPeer: packet => this.request<ConversationReply[]>({ type: "peer", roomId, packet }),
      close: async () => { await this.request({ type: "close_room", roomId }).catch(() => {}); },
    };
  }

  close(): void {
    clearTimeout(this.timer);
    this.socket.onclose = null;
    this.socket.close();
    const error = new Error("app_disconnected");
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
