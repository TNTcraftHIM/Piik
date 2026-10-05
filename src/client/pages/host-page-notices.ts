import type { ServerMessage } from "../../shared/protocol";
import { NativeRequestError } from "../native/client";
import { NativeMediaBridgeError, NativeMediaBridgeInitializationError } from "../native/media-bridge";
import { currentLang, joinSentences, say, type CopyKey } from "../ui/copy";

export type HostAction =
  | "capture"
  | "source"
  | "sourceAudio"
  | "quality"
  | "connection"
  | "room";

const HOST_ACTION_FALLBACK: Record<HostAction, CopyKey> = {
  capture: "host.fail.start",
  source: "host.fail.source",
  sourceAudio: "host.fail.sourceAudio",
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
  ROOM_FULL: "join.full",
  HOST_ALREADY_CONNECTED: "host.err.alreadyConnected",
  PEER_NOT_FOUND: "host.err.peerGone",
  FORBIDDEN: "host.err.forbidden",
  SERVER_ERROR: "host.err.serverError",
};

export function isCapturePermissionFailure(error: unknown, action: HostAction): boolean {
  return (action === "capture" || action === "source") &&
    error instanceof DOMException && error.name === "NotAllowedError";
}

export function hostActionErrorNotice(
  error: unknown,
  action: HostAction,
): string {
  if (error instanceof NativeRequestError) {
    switch (error.reason) {
      case "unavailable":
      case "disconnected":
      case "send-failed": return say("native.fail.controlDisconnected");
      case "timeout": return say("native.fail.requestTimeout");
      case "invalid-response": return say("native.fail.invalidResponse");
      case "rejected":
        if (error.operation === "start-share") return say("native.fail.captureStart");
        if (error.operation === "prepare-edge") return say("native.fail.edgePrepare");
        break;
    }
  }
  if (error instanceof NativeMediaBridgeInitializationError) return say("native.fail.browserMedia");
  if (error instanceof NativeMediaBridgeError) return say("native.fail.edge");
  if (isCapturePermissionFailure(error, action)) return say("host.capture.cancelled");
  if (
    error instanceof DOMException &&
    (action === "capture" || action === "source")
  ) {
    switch (error.name) {
      case "NotFoundError":
        return say("host.capture.noSource");
      case "NotReadableError":
        return say("host.capture.readFailed");
      case "SecurityError":
        return say("host.capture.unavailable");
      case "InvalidStateError":
        return say("host.capture.inactive");
      case "OverconstrainedError":
        return say("host.capture.constraints");
    }
  }
  return say(HOST_ACTION_FALLBACK[action]);
}

/** Safe support context: never copy arbitrary exception text or request fields. */
export function hostFailureCode(error: unknown, action: HostAction, source: "browser" | "camera" = "browser"): string {
  if (error instanceof NativeRequestError) return `app/${error.operation}/${error.reason}`;
  if (error instanceof NativeMediaBridgeInitializationError) return "app/browser-media/init";
  if (error instanceof NativeMediaBridgeError) return "app/browser-media/connection";
  if (error instanceof DOMException && ["NotAllowedError", "NotFoundError", "NotReadableError",
    "SecurityError", "InvalidStateError", "OverconstrainedError", "AbortError"].includes(error.name)) {
    return `${source}/${error.name}`;
  }
  return `${source === "camera" ? "camera" : action}/unknown`;
}

export function hostFailureChecks(code: string): CopyKey[] {
  const [scope, operation, reason] = code.split("/");
  if (scope === "camera") return ["shareHelp.camera"];
  if (scope === "site" || scope === "room") return ["shareHelp.site"];
  if (scope === "app") {
    if (["unavailable", "disconnected", "send-failed", "timeout", "invalid-response"].includes(reason)) return ["shareHelp.appConnection"];
    if (operation === "browser-media" || operation === "prepare-edge") return ["shareHelp.mediaConnection"];
    if (operation === "start-share" || operation === "capture") return ["shareHelp.source", "shareHelp.compare"];
  }
  if (scope === "browser") {
    return ["NotAllowedError", "SecurityError", "InvalidStateError"].includes(operation)
      ? ["shareHelp.permission"] : ["shareHelp.source"];
  }
  if (scope === "capture" || scope === "source") return ["shareHelp.source"];
  // A room/session or settings failure is not evidence that capture failed.
  return [];
}

export function hostServerErrorNotice(code: ServerErrorCode): string {
  return say(HOST_SERVER_ERROR_NOTICE[code]);
}

export function sourceSwitchNotice({
  failedPeerCount,
  sfuReplaced,
}: {
  failedPeerCount: number;
  sfuReplaced: boolean;
}): string {
  const peerWarning =
    failedPeerCount > 0 ? say("host.notice.reconnecting") : null;
  if (!sfuReplaced) {
    const parts = [
      say("host.notice.sfuRecovering"),
      peerWarning,
    ].filter((message): message is string => message !== null);
    return joinSentences(currentLang(), parts);
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
