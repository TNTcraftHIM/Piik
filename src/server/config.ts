import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  roomCodeSchema,
} from "../shared/protocol.js";

export type RuntimeEnvironment = "development" | "test" | "production";

const MAX_TURN_CREDENTIAL_TTL_SECONDS = 3_600;
const MAX_ACCESS_PASSWORD_BYTES = 128;
const MIN_TURN_SECRET_BYTES = 32;
const MIN_LIVEKIT_API_SECRET_BYTES = 32;
const MAX_PEER_ASSISTED_VIEWERS = 8;
const DEFAULT_MAX_VIEWERS_PER_ROOM = 8;
const DEFAULT_MAX_SFU_ROOTS_PER_ROOM = 2;
const MAX_SFU_ROOTS_PER_ROOM = 2;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;

export interface LiveKitFallbackConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  maxSfuRootsPerRoom: number;
}

export interface ServerConfig {
  nodeEnv: RuntimeEnvironment;
  port: number;
  listenHost: string;
  publicBaseUrl: URL;
  allowedOrigins: ReadonlySet<string>;
  accessPassword?: string;
  roomDatabasePath?: string;
  roomTtlMs: number;
  maxRooms: number;
  maxViewersPerRoom: number;
  peerAssistedMedia: boolean;
  peerAssistedRoomIds?: ReadonlySet<string>;
  livekitFallback?: LiveKitFallbackConfig;
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSharedSecret?: string;
  turnCredentialTtlSeconds: number;
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

interface IceEndpoint {
  scheme: "stun" | "stuns" | "turn" | "turns";
  port?: number;
  transport?: "udp" | "tcp";
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

function parseLiveKitFallback(
  environment: NodeJS.ProcessEnv,
  nodeEnv: RuntimeEnvironment,
): LiveKitFallbackConfig | undefined {
  const url = environment.LIVEKIT_URL?.trim() || undefined;
  const apiKey = environment.LIVEKIT_API_KEY?.trim() || undefined;
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim() || undefined;
  const configuredValues = [url, apiKey, apiSecret].filter(Boolean).length;

  if (configuredValues === 0) {
    return undefined;
  }
  if (configuredValues !== 3) {
    throw new Error(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together",
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

  return {
    url: parsedUrl.origin,
    apiKey: apiKey!,
    apiSecret: apiSecret!,
    maxSfuRootsPerRoom: parseBoundedInteger(
      environment.MAX_SFU_ROOTS_PER_ROOM,
      DEFAULT_MAX_SFU_ROOTS_PER_ROOM,
      "MAX_SFU_ROOTS_PER_ROOM",
      1,
      MAX_SFU_ROOTS_PER_ROOM,
    ),
  };
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

function parseIceUrlList(
  value: string | undefined,
  name: string,
  allowedProtocols: ReadonlySet<string>,
): string[] {
  return parseUrlList(value, name).map((value) => {
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      throw new Error(`${name} contains an invalid URL`);
    }
    if (!allowedProtocols.has(protocol)) {
      throw new Error(`${name} contains an unsupported URL scheme`);
    }
    if (!parseIceEndpoint(value)) {
      throw new Error(`${name} contains an invalid ICE URL`);
    }
    return value;
  });
}

function parseOrigins(value: string | undefined, fallback: string): Set<string> {
  const origins = parseUrlList(value, "ALLOWED_ORIGINS");
  return new Set((origins.length > 0 ? origins : [fallback]).map(toOrigin));
}

function parsePeerAssistedRoomIds(
  value: string | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const roomIds = new Set<string>();
  for (const entry of value.split(",")) {
    const roomId = entry.trim();
    if (!roomId) {
      throw new Error("PEER_ASSISTED_ROOM_IDS contains an empty room ID");
    }
    if (!roomCodeSchema.safeParse(roomId).success) {
      throw new Error(
        "PEER_ASSISTED_ROOM_IDS must contain comma-separated valid room IDs",
      );
    }
    if (roomIds.has(roomId)) {
      throw new Error(`PEER_ASSISTED_ROOM_IDS contains duplicate room ID ${roomId}`);
    }
    roomIds.add(roomId);
  }
  return roomIds;
}

function parseIceEndpoint(value: string): IceEndpoint | undefined {
  const schemeSeparator = value.indexOf(":");
  if (schemeSeparator <= 0) {
    return undefined;
  }

  const scheme = value.slice(0, schemeSeparator).toLowerCase();
  if (
    scheme !== "stun" &&
    scheme !== "stuns" &&
    scheme !== "turn" &&
    scheme !== "turns"
  ) {
    return undefined;
  }

  const remainder = value.slice(schemeSeparator + 1);
  if (!remainder || remainder.includes("#")) {
    return undefined;
  }

  const querySeparator = remainder.indexOf("?");
  const authorityText =
    querySeparator === -1 ? remainder : remainder.slice(0, querySeparator);
  const query =
    querySeparator === -1 ? undefined : remainder.slice(querySeparator + 1);
  let transport: IceEndpoint["transport"];
  if (scheme === "stun" || scheme === "stuns") {
    if (query !== undefined) {
      return undefined;
    }
  } else if (query !== undefined) {
    if (query === "transport=udp" || query === "transport=tcp") {
      transport = query.slice("transport=".length) as "udp" | "tcp";
    } else {
      return undefined;
    }
  }
  if (
    !authorityText ||
    /[\\/\s]/.test(authorityText) ||
    authorityText.endsWith(":")
  ) {
    return undefined;
  }

  let authority: URL;
  try {
    authority = new URL(`http://${authorityText}`);
  } catch {
    return undefined;
  }
  if (
    !authority.hostname ||
    authority.username ||
    authority.password ||
    authority.pathname !== "/" ||
    authority.search ||
    authority.hash
  ) {
    return undefined;
  }

  const port = authority.port ? Number(authority.port) : undefined;
  if (port === 0) {
    return undefined;
  }

  return {
    scheme,
    port,
    transport,
  };
}

function requireProductionTurnCoverage(turnUrls: readonly string[]): void {
  const endpoints = turnUrls.map((value) => parseIceEndpoint(value)!);
  const hasTurnUdp = endpoints.some(
    ({ scheme, transport }) => scheme === "turn" && transport === "udp",
  );
  const hasTurnTcp = endpoints.some(
    ({ scheme, transport }) => scheme === "turn" && transport === "tcp",
  );
  if (!hasTurnUdp || !hasTurnTcp) {
    throw new Error(
      "TURN_URLS must include explicit TURN/UDP and TURN/TCP endpoints in production",
    );
  }
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

  const accessPassword = environment.ACCESS_PASSWORD?.trim() || undefined;
  const roomDatabasePath =
    environment.ROOM_DATABASE_PATH?.trim() || undefined;
  const turnSharedSecret = environment.TURN_SHARED_SECRET?.trim() || undefined;
  const stunUrls = parseIceUrlList(
    environment.STUN_URLS,
    "STUN_URLS",
    new Set(["stun:", "stuns:"]),
  );
  const turnUrls = parseIceUrlList(
    environment.TURN_URLS,
    "TURN_URLS",
    new Set(["turn:", "turns:"]),
  );
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
  const peerAssistedRoomIds = parsePeerAssistedRoomIds(
    environment.PEER_ASSISTED_ROOM_IDS,
  );
  const livekitFallback = parseLiveKitFallback(environment, nodeEnv);

  if (peerAssistedRoomIds && !peerAssistedMedia) {
    throw new Error(
      "PEER_ASSISTED_ROOM_IDS requires PEER_ASSISTED_MEDIA=true",
    );
  }
  if (livekitFallback && !peerAssistedMedia) {
    throw new Error("LiveKit fallback requires PEER_ASSISTED_MEDIA=true");
  }
  if ((turnUrls.length > 0) !== Boolean(turnSharedSecret)) {
    throw new Error(
      "TURN_URLS and TURN_SHARED_SECRET must either both be configured or both be absent",
    );
  }
  const configuredSecrets = [
    accessPassword,
    turnSharedSecret,
    livekitFallback?.apiKey,
    livekitFallback?.apiSecret,
  ].filter((secret): secret is string => secret !== undefined);
  if (new Set(configuredSecrets).size !== configuredSecrets.length) {
    throw new Error(
      "ACCESS_PASSWORD, TURN_SHARED_SECRET, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must use independent values",
    );
  }
  if (
    accessPassword &&
    (!VISIBLE_ASCII_PATTERN.test(accessPassword) ||
      Buffer.byteLength(accessPassword) > MAX_ACCESS_PASSWORD_BYTES)
  ) {
    throw new Error(
      "ACCESS_PASSWORD must contain at most 128 visible ASCII characters",
    );
  }
  if (roomDatabasePath && !accessPassword) {
    throw new Error("ROOM_DATABASE_PATH requires ACCESS_PASSWORD");
  }
  if (nodeEnv === "production" && roomDatabasePath === ":memory:") {
    throw new Error("ROOM_DATABASE_PATH must be file-backed in production");
  }
  if (nodeEnv === "production" && turnUrls.length === 0) {
    throw new Error("TURN is required in production");
  }
  if (nodeEnv === "production" && stunUrls.length === 0) {
    throw new Error("STUN is required in production");
  }
  if (
    nodeEnv === "production" &&
    turnSharedSecret &&
    Buffer.byteLength(turnSharedSecret) < MIN_TURN_SECRET_BYTES
  ) {
    throw new Error("TURN_SHARED_SECRET must contain at least 32 bytes in production");
  }
  if (nodeEnv === "production") {
    requireProductionTurnCoverage(turnUrls);
  }
  if (peerAssistedMedia && maxViewersPerRoom > MAX_PEER_ASSISTED_VIEWERS) {
    throw new Error(
      "PEER_ASSISTED_MEDIA currently supports at most 8 viewers per room",
    );
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
    accessPassword,
    roomDatabasePath,
    roomTtlMs:
      parsePositiveInteger(environment.ROOM_TTL_SECONDS, 14_400, "ROOM_TTL_SECONDS") *
      1_000,
    maxRooms: parsePositiveInteger(environment.MAX_ROOMS, 1_000, "MAX_ROOMS"),
    maxViewersPerRoom,
    peerAssistedMedia,
    peerAssistedRoomIds,
    livekitFallback,
    stunUrls,
    turnUrls,
    turnSharedSecret,
    turnCredentialTtlSeconds: parseBoundedInteger(
      environment.TURN_CREDENTIAL_TTL_SECONDS,
      3_600,
      "TURN_CREDENTIAL_TTL_SECONDS",
      60,
      MAX_TURN_CREDENTIAL_TTL_SECONDS,
    ),
  };
}
