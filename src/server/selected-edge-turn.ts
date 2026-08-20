import { createHmac } from "node:crypto";

import type { SelectedEdgeTurnConfig } from "./config.js";

export interface SelectedEdgeTurnIdentity {
  roomId: string;
  shareGeneration: string;
  revision: number;
  parentPeerId: string;
  parentSessionId: string;
  viewerPeerId: string;
  viewerSessionId: string;
  oldConnectionId: string;
  newConnectionId: string;
}

export function issueSelectedEdgeTurnCredential(
  config: SelectedEdgeTurnConfig,
  identity: SelectedEdgeTurnIdentity,
  nowMs: number,
) {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error("Selected-edge TURN grant time is invalid");
  }
  const expiresAtSeconds =
    Math.floor(nowMs / 1_000) + config.credentialTtlSeconds;
  const opaqueIdentity = createHmac("sha256", config.sharedSecret)
    .update(
      JSON.stringify([
        "screener-selected-edge-turn-v1",
        identity.roomId,
        identity.shareGeneration,
        identity.revision,
        identity.parentPeerId,
        identity.parentSessionId,
        identity.viewerPeerId,
        identity.viewerSessionId,
        identity.oldConnectionId,
        identity.newConnectionId,
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
    iceServer: {
      urls: [...config.urls] as [string],
      username,
      credential,
    },
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
