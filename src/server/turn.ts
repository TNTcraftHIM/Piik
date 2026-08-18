import { createHmac } from "node:crypto";

import type { IceConfig } from "../shared/protocol.js";

export interface IceConfigOptions {
  stunUrls: readonly string[];
  turnUrls: readonly string[];
  turnSharedSecret?: string;
  credentialTtlSeconds: number;
}

export interface TurnCredentials {
  username: string;
  credential: string;
  expiresAt: string;
}

export function createTurnCredentials(
  sharedSecret: string,
  subject: string,
  ttlSeconds: number,
  nowMs = Date.now(),
  notAfterMs?: number,
): TurnCredentials {
  if (!sharedSecret) {
    throw new Error("TURN shared secret is required");
  }
  if (!subject || subject.includes("\n") || subject.includes("\r")) {
    throw new Error("TURN credential subject is invalid");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("TURN credential TTL must be a positive integer");
  }

  const nowSeconds = Math.floor(nowMs / 1_000);
  const requestedExpiry = nowSeconds + ttlSeconds;
  const expiresAtSeconds =
    notAfterMs === undefined
      ? requestedExpiry
      : Math.min(requestedExpiry, Math.floor(notAfterMs / 1_000));
  if (expiresAtSeconds <= nowSeconds) {
    throw new Error("TURN credential lifetime has elapsed");
  }
  const username = `${expiresAtSeconds}:${subject}`;
  const credential = createHmac("sha1", sharedSecret)
    .update(username)
    .digest("base64");

  return {
    username,
    credential,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

export function createIceConfig(
  options: IceConfigOptions,
  subject: string,
  nowMs = Date.now(),
  notAfterMs?: number,
): IceConfig {
  const iceServers: IceConfig["iceServers"] = [];

  if (options.stunUrls.length > 0) {
    iceServers.push({ urls: [...options.stunUrls] });
  }

  if (options.turnUrls.length === 0) {
    return {
      iceServers,
      expiresAt: null,
      relayAvailable: false,
    };
  }
  if (!options.turnSharedSecret) {
    throw new Error("TURN shared secret is required when TURN URLs are configured");
  }

  if (
    notAfterMs !== undefined &&
    Math.floor(notAfterMs / 1_000) <= Math.floor(nowMs / 1_000)
  ) {
    return {
      iceServers,
      expiresAt: null,
      relayAvailable: false,
    };
  }

  const credentials = createTurnCredentials(
    options.turnSharedSecret,
    subject,
    options.credentialTtlSeconds,
    nowMs,
    notAfterMs,
  );
  iceServers.push({
    urls: [...options.turnUrls],
    username: credentials.username,
    credential: credentials.credential,
  });

  return {
    iceServers,
    expiresAt: credentials.expiresAt,
    relayAvailable: true,
  };
}
