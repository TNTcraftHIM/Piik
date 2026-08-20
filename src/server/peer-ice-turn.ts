import { createHmac } from "node:crypto";

import type { Role } from "../shared/protocol.js";
import type { PeerIceTurnConfig } from "./config.js";

export interface PeerIceTurnIdentity {
  roomId: string;
  role: Role;
  peerId: string;
  sessionId: string;
}

export interface PeerIceTurnGrant {
  urls: readonly string[];
  username: string;
  credential: string;
  expiresAt: string;
  expiresAtMs: number;
}

export function issuePeerIceTurnGrant(
  config: PeerIceTurnConfig,
  identity: PeerIceTurnIdentity,
  nowMs: number,
): PeerIceTurnGrant {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error("Peer ICE TURN grant time is invalid");
  }

  const expiresAtSeconds =
    Math.floor(nowMs / 1_000) + config.credentialTtlSeconds;
  const opaqueIdentity = createHmac("sha256", config.sharedSecret)
    .update(
      JSON.stringify([
        "screener-peer-ice-turn-v1",
        identity.roomId,
        identity.role,
        identity.peerId,
        identity.sessionId,
        expiresAtSeconds,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);
  const username = `${expiresAtSeconds}:${opaqueIdentity}`;
  const credential = createHmac("sha1", config.sharedSecret)
    .update(username)
    .digest("base64");
  const expiresAtMs = expiresAtSeconds * 1_000;

  return {
    urls: [...config.urls],
    username,
    credential,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  };
}
