import { describe, expect, it } from "vitest";
import { diagnoseChannelFact } from "../src/client/ui/diagnosis";
import { channelErrorPresentation } from "../src/client/components/error-presentation";
import { roomOpenFailure } from "../src/client/channel/types";

describe("diagnosis using the current operation", () => {
  it("distinguishes setting a password, requesting admission, and contention during a backup", () => {
    const message = (code: string) => channelErrorPresentation(code, key => key).message;
    expect(message("invalid_room_password")).toBe("channel.error.invalidRoomPassword");
    expect(message("password_failed")).toBe("channel.error.setRoomPasswordFailed");
    expect(message("room_access_required")).toBe("channel.error.roomAccessDenied");
    expect(message("rate_limited")).toBe("remote.reason.retry");
    expect(message("storage_busy")).toBe("channel.error.busy");
    expect(message("unknown_outcome")).toBe("channel.error.unknownOutcome");
    expect(message("room_storage_in_use")).toBe("channel.error.roomHostConflict");
  });

  it("explains when an operation requires peer transport", () => {
    expect(channelErrorPresentation("peer_transport_unavailable", key => key)).toEqual({
      message: "channel.error.peerTransportUnavailable", connectionHelp: false,
    });
  });
  it.each([
    ["app-update", "client.connect.appUpdateRequired"],
    ["site-update", "client.connect.siteUpdateRequired"],
    ["domain_update_required", "channel.error.domainUpdateRequired"],
  ] as const)("shows which side to update for the source picker's %s error", (code, key) => {
    expect(channelErrorPresentation(code, value => value, "host.sourcePicker.failed").message).toBe(key);
  });

  it("offers the local approval page when discovery succeeds, and asserts denied access only on an explicit refusal", () => {
    expect(diagnoseChannelFact({ area: "app", state: "approval" })).toMatchObject({ message: "client.connect.found", next: "client.connect.open" });
    expect(diagnoseChannelFact({ area: "app", state: "approving" })).toBeNull();
    expect(channelErrorPresentation("site_not_approved", key => key).message).toBe("client.sites.notAllowed");
    expect(diagnoseChannelFact({ area: "app", state: "unavailable" })).toMatchObject({ message: "client.connect.unavailable", topic: "appConnection" });
    expect(diagnoseChannelFact({ area: "app", state: "app-update" })).toMatchObject({ message: "client.connect.appUpdateRequired", topic: "appVersion" });
  });

  it("keeps admission and the selected picture's retry separate", () => {
    expect(diagnoseChannelFact({ area: "error", code: "room_access_required" })?.topic).toBe("room");
    expect(diagnoseChannelFact({ area: "error", code: "ice_failed" })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: true })?.message).toBe("diagnosis.noPicture");
    expect(diagnoseChannelFact({ area: "screen", paused: true, deliveryFailed: true })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: false })).toBeNull();
  });

  it("explains that watching continues while awaiting a picture without offering a retry, and lets failures and pause take precedence", () => {
    expect(diagnoseChannelFact({ area: "screen", paused: false, waitingForInput: true }))
      .toEqual({ message: "diagnosis.waitingForPicture", topic: "picture" });
    expect(diagnoseChannelFact({ area: "screen", paused: false, waitingForInput: true, deliveryFailed: true }))
      .toMatchObject({ message: "diagnosis.noPicture", next: "screen.retryPicture" });
    expect(diagnoseChannelFact({ area: "screen", paused: false, waitingForInput: true, playbackError: 3 })?.message).toBe("screen.decodeFailed");
    expect(diagnoseChannelFact({ area: "screen", paused: true, waitingForInput: true })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, waitingForInput: false })).toBeNull();
  });

  it("keeps source permissions, failed reads and incompatible storage tied to their own operations", () => {
    expect(diagnoseChannelFact({ area: "error", code: "watch_media_access_denied" })?.message).toBe("watch.mediaAccessDenied");
    expect(diagnoseChannelFact({ area: "error", code: "watch_media_timeout" })).toMatchObject({ message: "watch.forward.readTimeout", topic: "webpage" });
    expect(diagnoseChannelFact({ area: "error", code: "capture_targets_failed" })?.topic).toBe("capture");
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_storage_version" })?.topic).toBe("storage");
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_backup_version" })).toBeNull();
  });

  it("names why a room this device holds could not open, from what the Browser store reports", () => {
    expect(roomOpenFailure(new Error("unsupported_storage_version"))).toBe("unsupported_version");
    for (const error of [new Error("invalid_room_policy"), new Error("owner_mismatch"), new Error("storage_failed"),
      new DOMException("Unreadable", "UnknownError"), "invalid_request"]) expect(roomOpenFailure(error)).toBe("unreadable");
    expect(diagnoseChannelFact({ area: "roomOpen", failure: "unsupported_version" }))
      .toEqual({ message: "channel.error.unsupportedStorageVersion", topic: "storage" });
    expect(diagnoseChannelFact({ area: "roomOpen", failure: "unreadable" })).toEqual({ message: "room.unopened.unreadable", topic: "storage" });
  });
});
