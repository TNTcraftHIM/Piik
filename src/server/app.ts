import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import sirv from "sirv";
import type { ViteDevServer } from "vite";

import {
  createRoomRequestSchema,
  type CreateRoomResponse,
} from "../shared/protocol.js";
import { SiteAccess } from "./access-session.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createIceConfig } from "./ice.js";
import type {
  SelectedEdgeTurnOptions,
  SfuFallbackOptions,
} from "./hybrid-media-router.js";
import type { SfuTokenIssuer } from "./livekit-token.js";
import type { SfuRoomControl } from "./sfu-room-control.js";
import { SfuResourceAdmission } from "./sfu-resource-admission.js";
import { TurnAllocationAdmission } from "./turn-allocation-admission.js";
import { RoomDatabase } from "./room-database.js";
import { RoomStore, RoomStoreError } from "./room-store.js";
import { SignalingServer, type SignalingOptions } from "./signaling.js";

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
  siteAccessTtlSeconds?: number;
  sfuTokenIssuer?: SfuTokenIssuer;
  sfuRoomControl?: SfuRoomControl;
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
  let sfuFallback: SfuFallbackOptions | undefined;
  let sfuRoomControl: SfuRoomControl | undefined;
  let selectedEdgeTurn: SelectedEdgeTurnOptions | undefined;
  if (livekitFallback) {
    sfuRoomControl =
      options.sfuRoomControl ??
      new (await import("./sfu-room-control.js")).LiveKitSfuRoomControl({
        apiUrl: livekitFallback.apiUrl,
        apiKey: livekitFallback.apiKey,
        apiSecret: livekitFallback.apiSecret,
        maxViewersPerRoom: config.maxViewersPerRoom,
      });
    sfuFallback = {
      url: livekitFallback.url,
      tokenIssuer:
        options.sfuTokenIssuer ??
        new (await import("./livekit-token.js")).LiveKitTokenIssuer({
          apiKey: livekitFallback.apiKey,
          apiSecret: livekitFallback.apiSecret,
          maxViewersPerRoom: config.maxViewersPerRoom,
        }),
      admission: new SfuResourceAdmission({
        ingressCapacity: livekitFallback.ingressCapacity,
        egressCapacity: livekitFallback.egressCapacity,
      }),
      roomControl: sfuRoomControl,
    };
  }
  if (config.selectedEdgeTurn) {
    selectedEdgeTurn = {
      config: config.selectedEdgeTurn,
      admission: new TurnAllocationAdmission({
        capacity: config.selectedEdgeTurn.allocationCapacity,
      }),
    };
  }
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
  const siteAccess = new SiteAccess({
    password: config.siteAccessPassword,
    secure:
      config.nodeEnv === "production" &&
      config.publicBaseUrl.protocol === "https:",
    now,
    ttlSeconds: options.siteAccessTtlSeconds,
  });
  const iceOptions = {
    stunUrls: config.stunUrls,
  };

  let frontendHandler: FrontendHandler | undefined;
  let vite: ViteDevServer | undefined;
  let acceptingTraffic = false;
  const httpServer = createServer((request, response) => {
    if (!acceptingTraffic) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Retry-After", "1");
      sendJson(response, 503, { error: "Service starting" });
      return;
    }
    void handleRequest(
      request,
      response,
      config,
      roomStore,
      siteAccess,
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

  const signalingOptions: SignalingOptions = {
    server: httpServer,
    roomStore,
    peerAssistedMedia: config.peerAssistedMedia,
    endpointMediaCopyCapacity: config.endpointMediaCopyCapacity,
    ...(sfuFallback ? { sfuFallback } : {}),
    ...(selectedEdgeTurn ? { selectedEdgeTurn } : {}),
    ice: iceOptions,
    allowedOrigins: config.allowedOrigins,
    siteAccessAtUpgrade: (request) =>
      siteAccess.isAuthenticated(request.headers.cookie),
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
  };
  let signaling: SignalingServer | undefined;
  let startupOperation: Promise<number> | undefined;
  let closing = false;

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
    async listen(port = config.port, host = config.listenHost) {
      if (startupOperation) {
        throw new Error("Screener server startup was already requested");
      }
      if (closing) {
        throw new Error("Screener server is closing");
      }
      startupOperation = (async () => {
        const boundPort = await bindHttpServer(httpServer, port, host);
        try {
          await sfuRoomControl?.initialize();
          if (!closing) {
            signaling = new SignalingServer(signalingOptions);
            acceptingTraffic = true;
          }
          return boundPort;
        } catch (error) {
          try {
            await closeHttpServer(httpServer);
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "Screener startup reconciliation failed",
            );
          }
          throw error;
        }
      })();
      return await startupOperation;
    },
    async close() {
      acceptingTraffic = false;
      closing = true;
      const errors: unknown[] = [];
      try {
        await startupOperation;
      } catch {
        // The listen caller owns the startup error; shutdown still closes resources.
      }
      try {
        await signaling?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await vite?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        roomStore.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Screener server shutdown failed");
      }
    },
  };
}

function bindHttpServer(
  httpServer: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<number> {
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
}

function closeHttpServer(
  httpServer: ReturnType<typeof createServer>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  roomStore: RoomStore,
  siteAccess: SiteAccess,
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

  if (url.pathname === "/api/connection-self-check") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    sendJson(response, 200, {
      iceConfig: createIceConfig({ stunUrls: config.stunUrls }),
      sfuConfigured: config.livekitFallback !== undefined,
    });
    return;
  }

  if (url.pathname === "/api/site-access") {
    handleSiteAccessRequest(request, response, config, siteAccess);
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
        siteAccess,
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

function handleSiteAccessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  siteAccess: SiteAccess,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET") {
    sendJson(response, 200, siteAccessStatus(request, siteAccess));
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

  if (!siteAccess.required) {
    sendJson(response, 200, { required: false, authenticated: true });
    return;
  }
  if (!isBearerAuthorized(request, siteAccess)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  response.setHeader("Set-Cookie", siteAccess.createCookie()!);
  sendJson(response, 200, { required: true, authenticated: true });
}

function siteAccessStatus(
  request: IncomingMessage,
  siteAccess: SiteAccess,
): { required: boolean; authenticated: boolean } {
  return {
    required: siteAccess.required,
    authenticated: siteAccess.isAuthenticated(request.headers.cookie),
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
  siteAccess: SiteAccess,
): boolean {
  if (!siteAccess.required) {
    return true;
  }
  return siteAccess.isAuthenticated(request.headers.cookie);
}

function isBearerAuthorized(
  request: IncomingMessage,
  siteAccess: SiteAccess,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const provided = authorization.slice("Bearer ".length);
  return provided.length > 0 && siteAccess.passwordMatches(provided);
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
