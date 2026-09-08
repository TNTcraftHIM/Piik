import type { ServerMessage } from "../../shared/protocol";
import { NativeMediaBridgeError } from "../native/media-bridge";
import { joinSentences, say, type CopyKey } from "../ui/copy";

export type HostAction =
  | "capture"
  | "source"
  | "quality"
  | "connection"
  | "room";

const HOST_ACTION_FALLBACK: Record<HostAction, CopyKey> = {
  capture: "host.fail.start",
  source: "host.fail.source",
  quality: "host.fail.quality",
  connection: "host.fail.connection",
  room: "host.fail.room",
};

type ServerErrorCode = Extract<
  ServerMessage,
  { type: "error" }
>["code"];

const HOST_SERVER_ERROR_NOTICE: Record<ServerErrorCode, CopyKey> = {
  AUTH_REQUIRED: "gate.expired",
  INVALID_MESSAGE: "host.terminated.stale",
  INVALID_TOKEN: "host.err.invalidToken",
  ROOM_NOT_FOUND: "viewer.msg.notFound",
  ROOM_ACCESS_DENIED: "host.err.accessDenied",
  ROOM_EXPIRED: "host.err.roomExpired",
  ROOM_FULL: "join.full",
  HOST_ALREADY_CONNECTED: "host.err.alreadyConnected",
  PEER_NOT_FOUND: "host.err.peerGone",
  FORBIDDEN: "host.err.forbidden",
  SERVER_ERROR: "host.err.serverError",
};

export function hostActionErrorNotice(
  error: unknown,
  action: HostAction,
): string {
  if (error instanceof NativeMediaBridgeError) return say(HOST_ACTION_FALLBACK.connection);
  if (
    error instanceof DOMException &&
    (action === "capture" || action === "source")
  ) {
    switch (error.name) {
      case "NotAllowedError":
        return say("host.capture.cancelled");
      case "NotFoundError":
        return say("host.capture.noSource");
      case "NotReadableError":
        return say("host.capture.readFailed");
      case "SecurityError":
        return say("host.capture.unavailable");
    }
  }
  return say(HOST_ACTION_FALLBACK[action]);
}

export function hostServerErrorNotice(code: ServerErrorCode): string {
  return say(HOST_SERVER_ERROR_NOTICE[code]);
}

export function sourceSwitchNotice({
  failedPeerCount,
  sfuReplaced,
  sfuWarning,
}: {
  failedPeerCount: number;
  sfuReplaced: boolean;
  sfuWarning: string | null;
}): string {
  const peerWarning =
    failedPeerCount > 0 ? say("host.notice.reconnecting") : null;
  if (!sfuReplaced) {
    const parts = [
      sfuWarning ?? say("host.notice.sfuRecovering"),
      peerWarning,
    ].filter((message): message is string => message !== null);
    return joinSentences(parts);
  }
  if (sfuWarning) {
    const parts = [sfuWarning, peerWarning].filter(
      (message): message is string => message !== null,
    );
    return joinSentences(parts);
  }
  return peerWarning
    ? say("host.notice.sourceSwitch.partial", { warning: peerWarning })
    : say("host.notice.sourceSwitch.ok");
}

export function shouldPauseLocalPreview(
  visibilityState: DocumentVisibilityState,
  hasFocus: boolean,
): boolean {
  return visibilityState !== "visible" || !hasFocus;
}
