import { isAbsolute } from "node:path";

import {
  MAX_ICE_SERVER_URLS,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  stunUrlSchema,
} from "../shared/protocol.js";
import {
  DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
  MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
} from "../shared/media-copy-accounting.js";
import { natPredictionStunUrls } from "./ice.js";

export type RuntimeEnvironment = "development" | "test" | "production";

const MIN_SITE_ACCESS_PASSWORD_BYTES = 8;
const MAX_SITE_ACCESS_PASSWORD_BYTES = 128;
const MIN_LIVEKIT_API_SECRET_BYTES = 32;
const DEFAULT_MAX_VIEWERS_PER_ROOM = 8;
const DEFAULT_ROOM_LEASE_SECONDS = 86_400;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const REMOVED_ENVIRONMENT_VARIABLES = [
  "TURN_URLS",
  "TURN_SHARED_SECRET",
  "TURN_CREDENTIAL_TTL_SECONDS",
  "PEER_ICE_TURN_URLS",
  "PEER_ICE_TURN_SHARED_SECRET",
  "PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS",
  "SELECTED_EDGE_TURN_URLS",
  "SELECTED_EDGE_TURN_SHARED_SECRET",
  "SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS",
  "SELECTED_EDGE_TURN_ALLOCATION_CAPACITY",
  "PEER_ASSISTED_ROOM_IDS",
  "HOST_ADMISSION_PASSWORD",
  "MAX_PEER_RELAY_DOWNSTREAM_EDGES",
  "ROOM_TTL_SECONDS",
] as const;

export interface LiveKitFallbackConfig {
  url: string;
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface ServerConfig {
  nodeEnv: RuntimeEnvironment;
  port: number;
  listenHost: string;
  publicBaseUrl: URL;
  allowedOrigins: ReadonlySet<string>;
  siteAccessPassword?: string;
  roomDatabasePath?: string;
  roomLeaseMs: number;
  maxViewersPerRoom: number;
  peerAssistedMedia: boolean;
  endpointMediaCopyCapacity: number;
  livekitFallback?: LiveKitFallbackConfig;
  stunUrls: readonly string[];
  natPredictionEnabled: boolean;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  const environment = value ?? "development";
  if (
    environment !== "development" &&
    environment !== "test" &&
    environment !== "production"
  ) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  return environment;
}

function parseRoomDatabasePath(value: string | undefined): string | undefined {
  const path = value?.trim();
  if (!path) {
    return undefined;
  }
  if (path === ":memory:" || path.includes("\0") || !isAbsolute(path)) {
    throw new Error("ROOM_DATABASE_PATH must be an absolute file path");
  }
  return path;
}

function parseLiveKitFallback(
  environment: NodeJS.ProcessEnv,
  nodeEnv: RuntimeEnvironment,
): LiveKitFallbackConfig | undefined {
  const url = environment.LIVEKIT_URL?.trim() || undefined;
  const apiUrl = environment.LIVEKIT_API_URL?.trim() || undefined;
  const apiKey = environment.LIVEKIT_API_KEY?.trim() || undefined;
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim() || undefined;
  const configuredValues = [url, apiUrl, apiKey, apiSecret].filter(Boolean).length;
  if (configuredValues === 0) {
    return undefined;
  }
  if (configuredValues !== 4) {
    throw new Error(
      "LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together",
    );
  }
  if (Buffer.byteLength(apiSecret!) < MIN_LIVEKIT_API_SECRET_BYTES) {
    throw new Error("LIVEKIT_API_SECRET must contain at least 32 bytes");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url!);
  } catch {
    throw new Error("LIVEKIT_URL must be a valid ws or wss origin");
  }
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must use ws or wss");
  }
  if (
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "LIVEKIT_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (nodeEnv === "production" && parsedUrl.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must use wss in production");
  }

  let parsedApiUrl: URL;
  try {
    parsedApiUrl = new URL(apiUrl!);
  } catch {
    throw new Error("LIVEKIT_API_URL must be a valid http or https origin");
  }
  if (parsedApiUrl.protocol !== "http:" && parsedApiUrl.protocol !== "https:") {
    throw new Error("LIVEKIT_API_URL must use http or https");
  }
  if (
    parsedApiUrl.username ||
    parsedApiUrl.password ||
    parsedApiUrl.pathname !== "/" ||
    parsedApiUrl.search ||
    parsedApiUrl.hash
  ) {
    throw new Error(
      "LIVEKIT_API_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (
    nodeEnv === "production" &&
    parsedApiUrl.protocol !== "https:" &&
    !isLoopbackHostname(parsedApiUrl.hostname)
  ) {
    throw new Error("LIVEKIT_API_URL must use https or loopback in production");
  }

  return {
    url: parsedUrl.origin,
    apiUrl: parsedApiUrl.origin,
    apiKey: apiKey!,
    apiSecret: apiSecret!,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function parseUrlList(value: string | undefined, name: string): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value.split(",").map((entry) => {
    const url = entry.trim();
    if (!url) {
      throw new Error(`${name} contains an empty URL`);
    }
    return url;
  });
}

function parseStunUrlList(
  value: string | undefined,
  name: string,
  maximum = MAX_ICE_SERVER_URLS,
): string[] {
  const values = parseUrlList(value, name);
  if (values.length > maximum) {
    throw new Error(`${name} must contain at most ${maximum} URLs`);
  }
  return values.map((value) => {
    if (!stunUrlSchema.safeParse(value).success) {
      throw new Error(`${name} contains an invalid STUN URL`);
    }
    return value;
  });
}

function parseOrigins(value: string | undefined, fallback: string): Set<string> {
  const origins = parseUrlList(value, "ALLOWED_ORIGINS");
  return new Set((origins.length > 0 ? origins : [fallback]).map(toOrigin));
}

function toOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Allowed origins must use http or https");
  }
  return url.origin;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  for (const name of REMOVED_ENVIRONMENT_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new Error(
        name === "MAX_PEER_RELAY_DOWNSTREAM_EDGES"
          ? `${name} is no longer supported; use ENDPOINT_MEDIA_COPY_CAPACITY`
          : name === "HOST_ADMISSION_PASSWORD"
          ? `${name} is no longer supported; use SITE_ACCESS_PASSWORD`
          : name === "PEER_ASSISTED_ROOM_IDS"
          ? `${name} is no longer supported; peer-assisted media applies to every room when enabled`
          : name === "ROOM_TTL_SECONDS"
          ? `${name} is no longer supported; use ROOM_LEASE_SECONDS`
          : `${name} is no longer supported; ordinary ICE accepts STUN_URLS only`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(environment, "ACCESS_PASSWORD")) {
    throw new Error(
      "ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD",
    );
  }

  const nodeEnv = parseEnvironment(environment.NODE_ENV);
  const port = parsePositiveInteger(environment.PORT, 8787, "PORT");
  if (port > 65_535) {
    throw new Error("PORT must be at most 65535");
  }
  const listenHost = environment.LISTEN_HOST?.trim() || "0.0.0.0";

  const publicBaseUrl = new URL(
    environment.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
  );
  if (
    publicBaseUrl.protocol !== "http:" &&
    publicBaseUrl.protocol !== "https:"
  ) {
    throw new Error("PUBLIC_BASE_URL must use http or https");
  }
  if (
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (nodeEnv === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https in production");
  }

  const siteAccessPassword =
    environment.SITE_ACCESS_PASSWORD === ""
      ? undefined
      : environment.SITE_ACCESS_PASSWORD;
  const roomDatabasePath = parseRoomDatabasePath(
    environment.ROOM_DATABASE_PATH,
  );
  const stunUrls = parseStunUrlList(environment.STUN_URLS, "STUN_URLS");
  const natPredictionEnabled = parseBoolean(
    environment.NAT_PREDICTION_ENABLED,
    false,
    "NAT_PREDICTION_ENABLED",
  );
  if (
    natPredictionEnabled &&
    natPredictionStunUrls(stunUrls).length === 0
  ) {
    throw new Error(
      "NAT_PREDICTION_ENABLED requires a STUN_URLS entry on UDP 3478",
    );
  }
  if (natPredictionEnabled && stunUrls.length + 2 > MAX_ICE_SERVER_URLS) {
    throw new Error(
      `STUN_URLS must contain at most ${MAX_ICE_SERVER_URLS - 2} URLs when NAT_PREDICTION_ENABLED=true`,
    );
  }
  const maxViewersPerRoom = parseBoundedInteger(
    environment.MAX_VIEWERS_PER_ROOM,
    DEFAULT_MAX_VIEWERS_PER_ROOM,
    "MAX_VIEWERS_PER_ROOM",
    1,
    MAX_VIEWERS_PER_ROOM_LIMIT,
  );
  const peerAssistedMedia = parseBoolean(
    environment.PEER_ASSISTED_MEDIA,
    false,
    "PEER_ASSISTED_MEDIA",
  );
  const endpointMediaCopyCapacity = parseBoundedInteger(
    environment.ENDPOINT_MEDIA_COPY_CAPACITY,
    DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
    "ENDPOINT_MEDIA_COPY_CAPACITY",
    1,
    MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
  );
  const livekitFallback = parseLiveKitFallback(environment, nodeEnv);

  if (livekitFallback && !peerAssistedMedia) {
    throw new Error("LiveKit fallback requires PEER_ASSISTED_MEDIA=true");
  }
  const configuredSecrets = [
    siteAccessPassword,
    livekitFallback?.apiKey,
    livekitFallback?.apiSecret,
  ].filter((secret): secret is string => secret !== undefined);
  if (new Set(configuredSecrets).size !== configuredSecrets.length) {
    throw new Error(
      "SITE_ACCESS_PASSWORD, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must use independent values",
    );
  }
  if (
    siteAccessPassword &&
    (!VISIBLE_ASCII_PATTERN.test(siteAccessPassword) ||
      Buffer.byteLength(siteAccessPassword) <
        MIN_SITE_ACCESS_PASSWORD_BYTES ||
      Buffer.byteLength(siteAccessPassword) >
        MAX_SITE_ACCESS_PASSWORD_BYTES)
  ) {
    throw new Error(
      "SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes",
    );
  }
  if (nodeEnv === "production" && !siteAccessPassword) {
    throw new Error("SITE_ACCESS_PASSWORD is required in production");
  }
  if (nodeEnv === "production" && stunUrls.length === 0) {
    throw new Error("STUN is required in production");
  }
  return {
    nodeEnv,
    port,
    listenHost,
    publicBaseUrl,
    allowedOrigins: parseOrigins(
      environment.ALLOWED_ORIGINS,
      publicBaseUrl.origin,
    ),
    siteAccessPassword,
    roomDatabasePath,
    roomLeaseMs:
      parsePositiveInteger(
        environment.ROOM_LEASE_SECONDS,
        DEFAULT_ROOM_LEASE_SECONDS,
        "ROOM_LEASE_SECONDS",
      ) * 1_000,
    maxViewersPerRoom,
    peerAssistedMedia,
    endpointMediaCopyCapacity,
    livekitFallback,
    stunUrls,
    natPredictionEnabled,
  };
}
