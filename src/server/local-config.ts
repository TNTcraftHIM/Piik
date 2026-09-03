import { isIP } from "node:net";

import {
  MAX_ICE_SERVER_URLS,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  stunUrlSchema,
} from "../shared/protocol.js";
import { DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY } from "../shared/media-copy-accounting.js";
import type { ServerConfig } from "./config.js";

const DEFAULT_LOCAL_PORT = 8787;
const LOCAL_ROOM_LEASE_MS = 24 * 60 * 60 * 1_000;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]{8,128}$/;

export interface LocalServerConfigOptions {
  port?: number;
  publicAddress: string;
  publicOrigin?: string;
  allowedAddresses?: readonly string[];
  siteAccessPassword: string;
  stunUrls?: readonly string[];
}

export function createLocalServerConfig(
  options: LocalServerConfigOptions,
): ServerConfig {
  const port = options.port ?? DEFAULT_LOCAL_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Local server port must be an integer between 1 and 65535");
  }
  const publicAddress = localIPv4(options.publicAddress, "public address");
  if (publicAddress === "0.0.0.0" || publicAddress.startsWith("127.")) {
    throw new Error("Local server public address must be reachable from the LAN");
  }
  if (!VISIBLE_ASCII_PATTERN.test(options.siteAccessPassword)) {
    throw new Error("Local access password must contain 8 to 128 visible ASCII bytes");
  }

  const allowedAddresses = new Set([
    publicAddress,
    ...(options.allowedAddresses ?? []).map((address) =>
      localIPv4(address, "allowed address"),
    ),
  ]);
  const stunUrls = [...(options.stunUrls ?? [])];
  if (
    stunUrls.length > MAX_ICE_SERVER_URLS ||
    stunUrls.some((url) => !stunUrlSchema.safeParse(url).success)
  ) {
    throw new Error("Local STUN URLs are invalid");
  }
  const origin = (host: string) => `http://${host}:${port}`;
  const publicBaseUrl = options.publicOrigin
    ? publicHTTPSOrigin(options.publicOrigin)
    : new URL(origin(publicAddress));

  return {
    nodeEnv: "production",
    port,
    listenHost: "0.0.0.0",
    publicBaseUrl,
    allowedOrigins: new Set([
      origin("localhost"),
      origin("127.0.0.1"),
      ...[...allowedAddresses].map(origin),
      publicBaseUrl.origin,
    ]),
    siteAccessPassword: options.siteAccessPassword,
    roomLeaseMs: LOCAL_ROOM_LEASE_MS,
    maxViewersPerRoom: MAX_VIEWERS_PER_ROOM_LIMIT,
    peerAssistedMedia: true,
    endpointMediaCopyCapacity: DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
    stunUrls,
    natPredictionEnabled: false,
  };
}

export function loadLocalServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const publicAddress = environment.SCREENER_CLIENT_LAN_ADDRESS?.trim();
  const siteAccessPassword = environment.SCREENER_CLIENT_LOCAL_PASSWORD;
  if (!publicAddress || !siteAccessPassword) {
    throw new Error(
      "SCREENER_CLIENT_LAN_ADDRESS and SCREENER_CLIENT_LOCAL_PASSWORD are required",
    );
  }
  const portText = environment.SCREENER_CLIENT_PORT?.trim();
  const port = portText ? Number(portText) : undefined;
  const allowedAddresses = environment.SCREENER_CLIENT_ALLOWED_LAN_ADDRESSES
    ?.split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const stunUrls = environment.STUN_URLS
    ?.split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const publicOrigin = environment.SCREENER_CLIENT_PUBLIC_ORIGIN?.trim();
  return createLocalServerConfig({
    ...(port === undefined ? {} : { port }),
    publicAddress,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(allowedAddresses ? { allowedAddresses } : {}),
    siteAccessPassword,
    ...(stunUrls ? { stunUrls } : {}),
  });
}

function publicHTTPSOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local public origin must be an HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Local public origin must be an HTTPS origin");
  }
  return parsed;
}

function localIPv4(value: string, name: string): string {
  const address = value.trim();
  if (isIP(address) !== 4) {
    throw new Error(`Local server ${name} must be an IPv4 address`);
  }
  return address;
}
