import {
  AccessToken,
  RoomConfiguration,
  TrackSource,
} from "livekit-server-sdk";

import type { Role } from "../shared/protocol.js";

const LIVEKIT_TOKEN_TTL_SECONDS = 5 * 60;

export interface SfuParticipant {
  roomId: string;
  role: Role;
  peerId: string;
}

export interface SfuTokenIssuer {
  issueToken(participant: SfuParticipant): Promise<string>;
}

export interface LiveKitTokenIssuerOptions {
  apiKey: string;
  apiSecret: string;
  maxViewersPerRoom: number;
}

export class LiveKitTokenIssuer implements SfuTokenIssuer {
  constructor(private readonly options: LiveKitTokenIssuerOptions) {}

  async issueToken(participant: SfuParticipant): Promise<string> {
    const room = `screener-${participant.roomId}`;
    const isHost = participant.role === "host";
    const token = new AccessToken(
      this.options.apiKey,
      this.options.apiSecret,
      {
        identity: isHost ? "host" : `viewer:${participant.peerId}`,
        ttl: LIVEKIT_TOKEN_TTL_SECONDS,
      },
    );
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: isHost,
      canPublishSources: isHost
        ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
        : undefined,
      canSubscribe: !isHost,
      canPublishData: false,
    });
    token.roomConfig = new RoomConfiguration({
      name: room,
      maxParticipants: this.options.maxViewersPerRoom + 1,
    });

    return await token.toJwt();
  }
}
