import type { CopyKey } from "../ui/copy";

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
