import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import sirv from "sirv";
import type { ViteDevServer } from "vite";

import type { CreateRoomResponse } from "../shared/protocol.js";
import { loadConfig, secretsEqual, type ServerConfig } from "./config.js";
import { RoomStore, RoomStoreError } from "./room-store.js";
import { SignalingServer } from "./signaling.js";
import { createIceConfig } from "./turn.js";

export interface CreateServerOptions {
  config?: ServerConfig;
  roomStore?: RoomStore;
  serveFrontend?: boolean;
  staticDirectory?: string;
  now?: () => number;
  authenticationTimeoutMs?: number;
  viewerDisconnectGraceMs?: number;
  heartbeatIntervalMs?: number;
  cleanupIntervalMs?: number;
  maxSignalConnections?: number;
  maxUnauthenticatedSignalConnections?: number;
}

export interface ScreenerServer {
  readonly httpServer: ReturnType<typeof createServer>;
  readonly roomStore: RoomStore;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

type FrontendHandler = (request: IncomingMessage, response: ServerResponse) => void;

export async function createScreenerServer(
  options: CreateServerOptions = {},
): Promise<ScreenerServer> {
  const config = options.config ?? loadConfig();
  const now = options.now ?? Date.now;
  const roomStore =
    options.roomStore ??
    new RoomStore({
      ttlMs: config.roomTtlMs,
      maxRooms: config.maxRooms,
      now,
    });
  const iceOptions = {
    stunUrls: config.stunUrls,
    turnUrls: config.turnUrls,
    turnSharedSecret: config.turnSharedSecret,
    credentialTtlSeconds: config.turnCredentialTtlSeconds,
  };

  let frontendHandler: FrontendHandler | undefined;
  let vite: ViteDevServer | undefined;
  const httpServer = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      config,
      roomStore,
      iceOptions,
      now,
      () => frontendHandler,
    ).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "Internal server error" });
      } else {
        response.destroy();
      }
    });
  });

  const signaling = new SignalingServer({
    server: httpServer,
    roomStore,
    ice: iceOptions,
    allowedOrigins: config.allowedOrigins,
    now,
    authenticationTimeoutMs: options.authenticationTimeoutMs,
    viewerDisconnectGraceMs: options.viewerDisconnectGraceMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    cleanupIntervalMs: options.cleanupIntervalMs,
    maxConnections: options.maxSignalConnections,
    maxUnauthenticatedConnections:
      options.maxUnauthenticatedSignalConnections,
    passThroughUnknownUpgrades:
      config.nodeEnv === "development" && options.serveFrontend !== false,
  });

  if (options.serveFrontend !== false) {
    if (config.nodeEnv === "development") {
      const { createServer: createViteServer } = await import("vite");
      vite = await createViteServer({
        appType: "spa",
        server: {
          middlewareMode: true,
          hmr: { server: httpServer },
        },
      });
      frontendHandler = (request, response) => {
        vite?.middlewares(request, response, () => {
          sendJson(response, 404, { error: "Not found" });
        });
      };
    } else if (config.nodeEnv === "production") {
      const staticDirectory =
        options.staticDirectory ??
        fileURLToPath(new URL("../../client/", import.meta.url));
      const serve = sirv(staticDirectory, {
        single: true,
        setHeaders(response) {
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Referrer-Policy", "no-referrer");
        },
      });
      frontendHandler = (request, response) => {
        serve(request, response, () => {
          sendJson(response, 404, { error: "Not found" });
        });
      };
    }
  }

  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;

  return {
    httpServer,
    roomStore,
    listen(port = config.port, host = "0.0.0.0") {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("Server did not bind to a TCP port"));
            return;
          }
          resolve(address.port);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
    },
    async close() {
      await signaling.close();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await vite?.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  roomStore: RoomStore,
  iceOptions: Parameters<typeof createIceConfig>[0],
  now: () => number,
  getFrontendHandler: () => FrontendHandler | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", config.publicBaseUrl);
  if (url.pathname === "/api/rooms") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAllowedRequestOrigin(request.headers.origin, config.allowedOrigins)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    if (hasRequestBody(request)) {
      sendJson(response, 400, { error: "Request body is not accepted" });
      return;
    }
    if (!isRoomCreationAuthorized(request, config.roomCreationToken)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const room = roomStore.createRoom();
      const inviteUrl = new URL(`/r/${room.roomId}`, config.publicBaseUrl);
      inviteUrl.hash = new URLSearchParams({ token: room.viewerToken }).toString();
      const responseBody: CreateRoomResponse = {
        roomId: room.roomId,
        hostToken: room.hostToken,
        inviteUrl: inviteUrl.toString(),
        expiresAt: room.expiresAt,
        iceConfig: createIceConfig(
          iceOptions,
          `${room.roomId}:host-bootstrap`,
          now(),
          Date.parse(room.expiresAt),
        ),
      };
      sendJson(response, 201, responseBody);
    } catch (error) {
      if (error instanceof RoomStoreError && error.code === "ROOM_LIMIT") {
        sendJson(response, 503, { error: "Room capacity reached" });
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const frontendHandler = getFrontendHandler();
  if (frontendHandler) {
    frontendHandler(request, response);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  const parsedLength = contentLength === undefined ? 0 : Number(contentLength);
  return (
    request.headers["transfer-encoding"] !== undefined ||
    !Number.isFinite(parsedLength) ||
    parsedLength !== 0
  );
}

function isAllowedRequestOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!origin) {
    return true;
  }
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isRoomCreationAuthorized(
  request: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return true;
  }
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const provided = authorization.slice("Bearer ".length);
  return provided.length > 0 && secretsEqual(provided, expectedToken);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.end(encoded);
}
