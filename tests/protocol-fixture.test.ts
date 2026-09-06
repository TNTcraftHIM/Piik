import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
  MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
} from "../src/shared/media-copy-accounting.js";
import {
  DEFAULT_HOST_DISPLAY_NAME_PREFIX,
  DEFAULT_QUALITY_SETTINGS,
  DEFAULT_ROUTE_POLICY,
  DEFAULT_VIEWER_DISPLAY_NAME,
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_ICE_SERVER_URLS,
  MAX_MEDIA_ROUTE_REVISION,
  MAX_NAT_PREDICTION_AUXILIARY_STUN_URLS,
  MAX_PARTICIPANTS_PER_ROOM_LIMIT,
  MAX_SFU_TOKEN_LENGTH,
  MAX_SIGNAL_BYTES,
  MAX_VIEWER_PASSWORD_LENGTH,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  MIN_VIEWER_PASSWORD_LENGTH,
  PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS,
  ROOM_CODE_LENGTH,
  SIGNAL_CLOSE_CODES,
  SIGNALING_PROTOCOL,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
  VIEWER_QUALITY_EVIDENCE_INTERVAL_MS,
  clientMessageSchema,
  createRoomRequestSchema,
  replaceRoomRequestSchema,
  roomAccessUpdateRequestSchema,
  serverMessageSchema,
} from "../src/shared/protocol.js";

interface ClientSample {
  name: string;
  schema: "client" | "createRoomRequest" | "replaceRoomRequest" | "roomAccessUpdateRequest";
  json: string;
  valid: boolean;
}

interface ServerSample {
  name: string;
  json: string;
}

interface WireFixture {
  constants: Record<string, unknown>;
  clientMessages: ClientSample[];
  serverMessages: ServerSample[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/wire-samples.json", import.meta.url)),
    "utf8",
  ),
) as WireFixture;

const requestSchemas = {
  client: clientMessageSchema,
  createRoomRequest: createRoomRequestSchema,
  replaceRoomRequest: replaceRoomRequestSchema,
  roomAccessUpdateRequest: roomAccessUpdateRequestSchema,
} as const;

describe("shared wire fixture", () => {
  it("carries the protocol constants the Go port mirrors", () => {
    expect(fixture.constants).toEqual({
      signalingProtocol: SIGNALING_PROTOCOL,
      maxViewersPerRoomLimit: MAX_VIEWERS_PER_ROOM_LIMIT,
      maxParticipantsPerRoomLimit: MAX_PARTICIPANTS_PER_ROOM_LIMIT,
      maxSignalBytes: MAX_SIGNAL_BYTES,
      roomCodeLength: ROOM_CODE_LENGTH,
      maxMediaRouteRevision: MAX_MEDIA_ROUTE_REVISION,
      maxSfuTokenLength: MAX_SFU_TOKEN_LENGTH,
      maxIceServerUrls: MAX_ICE_SERVER_URLS,
      maxNatPredictionAuxiliaryStunUrls: MAX_NAT_PREDICTION_AUXILIARY_STUN_URLS,
      maxViewerQualityEvidenceBytes: MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
      viewerQualityEvidenceIntervalMs: VIEWER_QUALITY_EVIDENCE_INTERVAL_MS,
      viewerQualityEvidenceExpiryMs: VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
      persistentNativeEdgeDegradedWindows: PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS,
      maxDisplayNameCodePoints: MAX_DISPLAY_NAME_CODE_POINTS,
      defaultViewerDisplayName: DEFAULT_VIEWER_DISPLAY_NAME,
      defaultHostDisplayNamePrefix: DEFAULT_HOST_DISPLAY_NAME_PREFIX,
      minViewerPasswordLength: MIN_VIEWER_PASSWORD_LENGTH,
      maxViewerPasswordLength: MAX_VIEWER_PASSWORD_LENGTH,
      defaultEndpointMediaCopyCapacity: DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
      maxEndpointMediaCopyCapacity: MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
      signalCloseCodeServiceRestart: SIGNAL_CLOSE_CODES.serviceRestart,
      signalCloseCodeSessionReplaced: SIGNAL_CLOSE_CODES.sessionReplaced,
      signalCloseCodeClientReconnect: SIGNAL_CLOSE_CODES.clientReconnect,
      signalCloseCodeAuthenticationFailed: SIGNAL_CLOSE_CODES.authenticationFailed,
      signalCloseCodeViewerAccessRevoked: SIGNAL_CLOSE_CODES.viewerAccessRevoked,
      defaultQualitySettings: DEFAULT_QUALITY_SETTINGS,
      defaultRoutePolicy: DEFAULT_ROUTE_POLICY,
    });
  });

  it("covers every client message type and request body", () => {
    const covered = new Set<string>();
    for (const sample of fixture.clientMessages) {
      if (!sample.valid) {
        continue;
      }
      const value = JSON.parse(sample.json) as Record<string, unknown>;
      covered.add(
        sample.schema === "client"
          ? `client:${String(value.type)}`
          : sample.schema === "roomAccessUpdateRequest"
            ? `roomAccessUpdateRequest:${String(value.action)}`
            : sample.schema,
      );
    }
    expect([...covered].sort()).toEqual(
      [
        "client:abandon-room",
        "client:authenticate",
        "client:refresh-sfu",
        "client:relay-capacity",
        "client:request-route-diagnostic",
        "client:reset-sender-quality",
        "client:restart-request",
        "client:route-failed",
        "client:route-media-unavailable",
        "client:route-ready",
        "client:route-transport-connected",
        "client:sender-quality-evidence",
        "client:set-display-name",
        "client:set-quality-settings",
        "client:set-sharing-paused",
        "client:sfu-publisher-quality-evidence",
        "client:signal",
        "client:signaling-challenge",
        "client:stop-sharing",
        "client:viewer-quality-evidence",
        "createRoomRequest",
        "replaceRoomRequest",
        "roomAccessUpdateRequest:revoke-viewer-grant",
        "roomAccessUpdateRequest:rotate-viewer-grant",
        "roomAccessUpdateRequest:set-code-entry-policy",
        "roomAccessUpdateRequest:set-viewer-password",
      ].sort(),
    );
  });

  it.each(fixture.clientMessages.map((sample) => [sample.name, sample] as const))(
    "client sample %s matches its recorded validity",
    (_name, sample) => {
      expect(
        requestSchemas[sample.schema].safeParse(JSON.parse(sample.json)).success,
      ).toBe(sample.valid);
    },
  );

  it("covers every server message variant", () => {
    const covered = new Set(
      fixture.serverMessages.map(
        (sample) => (JSON.parse(sample.json) as { type: string }).type,
      ),
    );
    expect([...covered].sort()).toEqual([
      "authenticated",
      "error",
      "host-status",
      "pause-sharing-source",
      "quality-settings",
      "restart-request",
      "room-closed",
      "route-diagnostic-snapshot",
      "route-policy",
      "route-status",
      "route-update",
      "sfu-config",
      "sharing-stopped",
      "signal",
      "signaling-challenge-response",
      "viewer-grant-revoked",
      "viewer-presence",
      "viewer-quality-evidence",
    ]);
  });

  it.each(fixture.serverMessages.map((sample) => [sample.name, sample] as const))(
    "server sample %s parses",
    (_name, sample) => {
      expect(serverMessageSchema.safeParse(JSON.parse(sample.json)).success).toBe(
        true,
      );
    },
  );
});
