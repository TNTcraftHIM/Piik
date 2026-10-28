import type { RoomSummary } from "./protocol";
import { z } from "zod";
import { appApprovalURL, discoverLocalApp, type AppDiscovery, type AppDiscoveryOptions } from "../native/discovery";

const identitySchema = z.object({ service: z.literal("piik-channel-app"), protocol: z.number().int().positive(), port: z.number().int().min(1).max(65535) });
const healthSchema = identitySchema.extend({ protocol: z.literal(1), token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) });
type AppHealth = z.infer<typeof healthSchema>;
class AppCompatibilityError extends Error {}

function identity(body: unknown, port: number): void {
  const value = identitySchema.parse(body);
  if (value.port !== port) throw new Error("invalid_app_response");
  if (value.protocol !== 1) throw new AppCompatibilityError("App room protocol is incompatible");
}

export function discoverChannelAppHealth(options: AppDiscoveryOptions = {}): Promise<AppHealth | null> {
  return discoverLocalApp("health", (body, port) => {
    identity(body, port);
    return healthSchema.parse(body);
  }, options, error => error instanceof AppCompatibilityError);
}

export const channelAppDiscovery: AppDiscovery = {
  health: discoverChannelAppHealth,
  connect: signal => discoverLocalApp("connect-discovery", (body, port) => {
    identity(body, port);
    return appApprovalURL(identitySchema.extend({ connectURL: z.string().url().max(256) }).parse(body).connectURL);
  }, { signal }, error => error instanceof AppCompatibilityError),
  isIncompatible: error => error instanceof AppCompatibilityError,
};

/** An approved control connection starts rooms in the App's independent participant. */
export class AppRooms {
  private socket: WebSocket;
  private requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor(health: AppHealth, channelId: string, userId: string, credential: string, name: string, onClose: (error: Error) => void) {
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${health.port}/rooms`, `piik-channel-rooms.${health.token}`);
    const lost = (error = new Error("app_disconnected")) => { this.close(); onClose(error); };
    this.timer = setTimeout(() => lost(), 10000);
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      socket.onopen = () => {
        void this.request({ type: "hello", channelId, userId, credential, name }).then(() => {
          clearTimeout(this.timer);
          resolve();
        }, error => { reject(error); lost(error); });
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
    socket.onclose = () => lost();
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

  async open(policy: string): Promise<RoomSummary> {
    await this.ready;
    return this.request({ type: "open", policy });
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
