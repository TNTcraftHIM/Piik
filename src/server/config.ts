import { createHash, timingSafeEqual } from "node:crypto";

export type RuntimeEnvironment = "development" | "test" | "production";

const MAX_TURN_CREDENTIAL_TTL_SECONDS = 3_600;
const MIN_PRODUCTION_SECRET_BYTES = 32;

export interface ServerConfig {
  nodeEnv: RuntimeEnvironment;
  port: number;
  publicBaseUrl: URL;
  allowedOrigins: ReadonlySet<string>;
  roomCreationToken?: string;
  roomTtlMs: number;
  maxRooms: number;
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSharedSecret?: string;
  turnCredentialTtlSeconds: number;
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
  const nodeEnv = parseEnvironment(environment.NODE_ENV);
  const port = parsePositiveInteger(environment.PORT, 8787, "PORT");
  if (port > 65_535) {
    throw new Error("PORT must be at most 65535");
  }

  const publicBaseUrl = new URL(
    environment.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
  );
  if (
    publicBaseUrl.protocol !== "http:" &&
    publicBaseUrl.protocol !== "https:"
  ) {
    throw new Error("PUBLIC_BASE_URL must use http or https");
  }
  if (nodeEnv === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https in production");
  }

  const roomCreationToken = environment.ROOM_CREATION_TOKEN?.trim() || undefined;
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

  if ((turnUrls.length > 0) !== Boolean(turnSharedSecret)) {
    throw new Error(
      "TURN_URLS and TURN_SHARED_SECRET must either both be configured or both be absent",
    );
  }
  if (nodeEnv === "production" && !roomCreationToken) {
    throw new Error("ROOM_CREATION_TOKEN is required in production");
  }
  if (
    nodeEnv === "production" &&
    roomCreationToken &&
    Buffer.byteLength(roomCreationToken) < MIN_PRODUCTION_SECRET_BYTES
  ) {
    throw new Error("ROOM_CREATION_TOKEN must contain at least 32 bytes in production");
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
    Buffer.byteLength(turnSharedSecret) < MIN_PRODUCTION_SECRET_BYTES
  ) {
    throw new Error("TURN_SHARED_SECRET must contain at least 32 bytes in production");
  }

  return {
    nodeEnv,
    port,
    publicBaseUrl,
    allowedOrigins: parseOrigins(
      environment.ALLOWED_ORIGINS,
      publicBaseUrl.origin,
    ),
    roomCreationToken,
    roomTtlMs:
      parsePositiveInteger(environment.ROOM_TTL_SECONDS, 14_400, "ROOM_TTL_SECONDS") *
      1_000,
    maxRooms: parsePositiveInteger(environment.MAX_ROOMS, 1_000, "MAX_ROOMS"),
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

export function secretsEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
