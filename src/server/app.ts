import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import sirv from "sirv";
import type { ViteDevServer } from "vite";

import {
  createRoomRequestSchema,
  type CreateRoomResponse,
} from "../shared/protocol.js";
import { HostAdmission } from "./access-session.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { SfuTokenIssuer } from "./livekit-token.js";
import { RoomDatabase } from "./room-database.js";
import { RoomStore, RoomStoreError } from "./room-store.js";
import { SignalingServer } from "./signaling.js";

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
  hostAdmissionTtlSeconds?: number;
  sfuTokenIssuer?: SfuTokenIssuer;
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
  const livekitFallback = config.livekitFallback;
  const sfuFallback = livekitFallback
    ? {
        url: livekitFallback.url,
        tokenIssuer:
          options.sfuTokenIssuer ??
          new (await import("./livekit-token.js")).LiveKitTokenIssuer({
            apiKey: livekitFallback.apiKey,
            apiSecret: livekitFallback.apiSecret,
            maxViewersPerRoom: config.maxViewersPerRoom,
            maxSfuRootsPerRoom: livekitFallback.maxSfuRootsPerRoom,
          }),
        maxRoots: livekitFallback.maxSfuRootsPerRoom,
      }
    : undefined;
  const roomStore =
    options.roomStore ??
    new RoomStore({
      ttlMs: config.roomTtlMs,
      maxRooms: config.maxRooms,
      maxViewersPerRoom: config.maxViewersPerRoom,
      database: config.roomDatabasePath
        ? new RoomDatabase(config.roomDatabasePath)
        : undefined,
      now,
    });
  const hostAdmission = new HostAdmission({
    password: config.hostAdmissionPassword,
    secure:
      config.nodeEnv === "production" &&
      config.publicBaseUrl.protocol === "https:",
    now,
    ttlSeconds: options.hostAdmissionTtlSeconds,
  });
  const iceOptions = {
    stunUrls: config.stunUrls,
  };

  let frontendHandler: FrontendHandler | undefined;
  let vite: ViteDevServer | undefined;
  const httpServer = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      config,
      roomStore,
      hostAdmission,
      () => frontendHandler,
    ).catch((error: unknown) => {
      console.error("HTTP request failed", {
        method: request.method,
        path: safePathname(request.url),
        error,
      });
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
    peerAssistedMedia: config.peerAssistedMedia,
    ...(sfuFallback ? { sfuFallback } : {}),
    ...(config.selectedEdgeTurn ? { selectedEdgeTurn: config.selectedEdgeTurn } : {}),
    ice: iceOptions,
    allowedOrigins: config.allowedOrigins,
    hostAdmissionAtUpgrade: (request) =>
      hostAdmission.isAuthenticated(request.headers.cookie),
    publicBaseUrl: config.publicBaseUrl,
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
    listen(port = config.port, host = config.listenHost) {
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
      try {
        await signaling.close();
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
        await vite?.close();
      } finally {
        roomStore.close();
      }
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  roomStore: RoomStore,
  hostAdmission: HostAdmission,
  getFrontendHandler: () => FrontendHandler | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", config.publicBaseUrl);
  if (url.pathname === "/healthz") {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/api/host-admission") {
    handleHostAdmissionRequest(request, response, config, hostAdmission);
    return;
  }

  if (url.pathname === "/api/rooms") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (
      !isStrictlyAllowedRequestOrigin(
        request.headers.origin,
        config.allowedOrigins,
      )
    ) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    if (
      !isRoomCreationAuthorized(
        request,
        hostAdmission,
      )
    ) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    let parsedRequest;
    try {
      parsedRequest = createRoomRequestSchema.safeParse(
        await readJsonBody(request, 1_024),
      );
    } catch {
      sendJson(response, 400, { error: "Invalid room request" });
      return;
    }
    if (!parsedRequest.success) {
      sendJson(response, 400, { error: "Invalid room request" });
      return;
    }

    try {
      const room = roomStore.createRoom(
        parsedRequest.data.viewerPolicy,
        parsedRequest.data.hostClaimTtlSeconds,
      );
      const inviteUrl = new URL(`/r/${room.roomId}`, config.publicBaseUrl);
      if (room.viewerGrant) {
        inviteUrl.hash = `v=${room.viewerGrant}`;
      }
      const responseBody: CreateRoomResponse = {
        roomId: room.roomId,
        hostToken: room.hostToken,
        inviteUrl: inviteUrl.toString(),
        viewerPolicy: room.viewerPolicy,
        viewerGrantExpiresAt: room.viewerGrantExpiresAt,
        expiresAt: room.expiresAt,
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

function handleHostAdmissionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  hostAdmission: HostAdmission,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET") {
    sendJson(response, 200, hostAdmissionStatus(request, hostAdmission));
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (
    !isStrictlyAllowedRequestOrigin(
      request.headers.origin,
      config.allowedOrigins,
    )
  ) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  if (hasRequestBody(request)) {
    sendJson(response, 400, { error: "Request body is not accepted" });
    return;
  }

  if (!hostAdmission.required) {
    sendJson(response, 200, { required: false, authenticated: true });
    return;
  }
  if (!isBearerAuthorized(request, hostAdmission)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  response.setHeader("Set-Cookie", hostAdmission.createCookie()!);
  sendJson(response, 200, { required: true, authenticated: true });
}

function hostAdmissionStatus(
  request: IncomingMessage,
  hostAdmission: HostAdmission,
): { required: boolean; authenticated: boolean } {
  return {
    required: hostAdmission.required,
    authenticated: hostAdmission.isAuthenticated(request.headers.cookie),
  };
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

function isStrictlyAllowedRequestOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

function isRoomCreationAuthorized(
  request: IncomingMessage,
  hostAdmission: HostAdmission,
): boolean {
  if (!hostAdmission.required) {
    return true;
  }
  return hostAdmission.isAuthenticated(request.headers.cookie);
}

function isBearerAuthorized(
  request: IncomingMessage,
  hostAdmission: HostAdmission,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const provided = authorization.slice("Bearer ".length);
  return provided.length > 0 && hostAdmission.passwordMatches(provided);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("Request content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new Error("Request body is required");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.end(encoded);
}

function safePathname(requestUrl: string | undefined): string {
  try {
    return new URL(requestUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "<invalid>";
  }
}
