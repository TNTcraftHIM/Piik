import type { IceConfig } from "../shared/protocol.js";

export interface IceConfigOptions {
  stunUrls: readonly string[];
}

export interface PeerIceTurnGrantOptions {
  urls: readonly string[];
  username: string;
  credential: string;
  expiresAt: string;
}

export function createIceConfig(
  options: IceConfigOptions,
  peerIceTurn?: PeerIceTurnGrantOptions,
): IceConfig {
  return {
    iceServers: [
      ...(options.stunUrls.length > 0
        ? [{ urls: [...options.stunUrls] }]
        : []),
      ...(peerIceTurn
        ? [
            {
              urls: [...peerIceTurn.urls],
              username: peerIceTurn.username,
              credential: peerIceTurn.credential,
            },
          ]
        : []),
    ],
    ...(peerIceTurn
      ? { turnCredentialsExpiresAt: peerIceTurn.expiresAt }
      : {}),
  };
}
