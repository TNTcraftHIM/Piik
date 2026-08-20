import { createHmac } from "node:crypto";

import type { SelectedEdgeTurnConfig } from "./config.js";

export interface PeerSelectedEdgeTurnIdentity {
  edgeKind: "peer-selected";
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

export interface HostSfuIngressTurnIdentity {
  edgeKind: "host-sfu-ingress";
  roomId: string;
  shareGeneration: string;
  revision: number;
  hostPeerId: string;
  hostSessionId: string;
  publicationGeneration: string;
  oldConnectionId: string;
  newConnectionId: string;
}

export type SelectedEdgeTurnIdentity =
  | PeerSelectedEdgeTurnIdentity
  | HostSfuIngressTurnIdentity;

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
  const opaquePayload =
    identity.edgeKind === "peer-selected"
      ? [
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
        ]
      : [
          "screener-selected-edge-turn-v2",
          identity.edgeKind,
          identity.roomId,
          identity.shareGeneration,
          identity.revision,
          identity.hostPeerId,
          identity.hostSessionId,
          identity.publicationGeneration,
          identity.oldConnectionId,
          identity.newConnectionId,
          expiresAtSeconds,
        ];
  const opaqueIdentity = createHmac("sha256", config.sharedSecret)
    .update(JSON.stringify(opaquePayload))
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
