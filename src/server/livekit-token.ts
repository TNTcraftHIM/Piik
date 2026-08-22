import {
  AccessToken,
  RoomConfiguration,
  TrackSource,
} from "livekit-server-sdk";

import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  type Role,
} from "../shared/protocol.js";

const LIVEKIT_TOKEN_TTL_SECONDS = 5 * 60;
const ROOM_ID_PATTERN = /^[1-9]\d{0,11}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface SfuTokenRequest {
  roomId: string;
  role: Role;
  peerId: string;
  publicationGeneration: string;
  allowlistedRootPeerIds: readonly string[];
}

export interface SfuTokenIssuer {
  issueToken(request: SfuTokenRequest): Promise<string>;
}

export interface LiveKitTokenIssuerOptions {
  apiKey: string;
  apiSecret: string;
  maxViewersPerRoom: number;
}

export class LiveKitTokenIssuer implements SfuTokenIssuer {
  constructor(private readonly options: LiveKitTokenIssuerOptions) {
    if (!options.apiKey || Buffer.byteLength(options.apiSecret) < 32) {
      throw new Error("LiveKit API credentials are invalid");
    }
    if (
      !Number.isSafeInteger(options.maxViewersPerRoom) ||
      options.maxViewersPerRoom < 1 ||
      options.maxViewersPerRoom > MAX_VIEWERS_PER_ROOM_LIMIT
    ) {
      throw new Error("LiveKit viewer limit is invalid");
    }
  }

  async issueToken(request: SfuTokenRequest): Promise<string> {
    validateTokenRequest(request, this.options.maxViewersPerRoom);

    const isHost = request.role === "host";
    const room = liveKitRoomName(
      request.roomId,
      request.publicationGeneration,
    );
    const token = new AccessToken(
      this.options.apiKey,
      this.options.apiSecret,
      {
        identity: isHost ? "host" : `viewer:${request.peerId}`,
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
      canUpdateOwnMetadata: false,
    });
    token.roomConfig = new RoomConfiguration({
      name: room,
      maxParticipants: this.options.maxViewersPerRoom + 1,
    });

    return await token.toJwt();
  }
}

function validateTokenRequest(
  request: SfuTokenRequest,
  maxViewersPerRoom: number,
): void {
  if (!ROOM_ID_PATTERN.test(request.roomId)) {
    throw new Error("LiveKit room ID is invalid");
  }
  if (
    !OPAQUE_ID_PATTERN.test(request.peerId) ||
    !OPAQUE_ID_PATTERN.test(request.publicationGeneration)
  ) {
    throw new Error("LiveKit participant identity is invalid");
  }
  if (
    request.allowlistedRootPeerIds.length > maxViewersPerRoom ||
    request.allowlistedRootPeerIds.some(
      (peerId) => !OPAQUE_ID_PATTERN.test(peerId),
    )
  ) {
    throw new Error("LiveKit SFU root allowlist is invalid");
  }

  const roots = new Set(request.allowlistedRootPeerIds);
  if (roots.size !== request.allowlistedRootPeerIds.length) {
    throw new Error("LiveKit SFU root allowlist contains duplicates");
  }
  if (request.role === "viewer" && !roots.has(request.peerId)) {
    throw new Error("LiveKit viewer is not an allowlisted SFU root");
  }
}

function liveKitRoomName(
  roomId: string,
  publicationGeneration: string,
): string {
  return `screener-${roomId}-${publicationGeneration}`;
}
