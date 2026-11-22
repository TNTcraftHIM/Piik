import { describe, expect, it } from "vitest";
import { diagnoseChannelFact } from "../src/client/channel/diagnosis";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";

describe("diagnosis using the current operation", () => {
  it("offers the local approval page when discovery succeeds, and asserts denied access only on an explicit refusal", () => {
    expect(diagnoseChannelFact({ area: "app", state: "approval" })).toMatchObject({ message: "client.connect.found", next: "client.connect.open" });
    expect(diagnoseChannelFact({ area: "app", state: "approving" })).toBeNull();
    expect(channelErrorPresentation("site_not_approved", key => key).message).toBe("client.sites.notAllowed");
    expect(diagnoseChannelFact({ area: "app", state: "unavailable" })).toMatchObject({ message: "client.connect.unavailable", topic: "appVersion" });
  });

  it("keeps room availability, admission and the selected picture's retry separate", () => {
    expect(diagnoseChannelFact({ area: "room", room: { available: false, authorized: false } })?.message).toBe("room.offline.access");
    expect(diagnoseChannelFact({ area: "room", room: { available: true, authorized: false } })).toBeNull();
    expect(diagnoseChannelFact({ area: "error", code: "room_access_required" })?.topic).toBe("room");
    expect(diagnoseChannelFact({ area: "error", code: "ice_failed" })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: true })?.message).toBe("diagnosis.noPicture");
    expect(diagnoseChannelFact({ area: "screen", paused: true, deliveryFailed: true })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: false })).toBeNull();
  });

  it("keeps source permissions, failed reads, attachment waits and incompatible storage tied to their own operations", () => {
    expect(diagnoseChannelFact({ area: "error", code: "watch_media_access_denied" })?.message).toBe("watch.mediaAccessDenied");
    expect(diagnoseChannelFact({ area: "error", code: "watch_media_timeout" })?.message).toBe("watch.forward.sourceUnavailable");
    expect(diagnoseChannelFact({ area: "error", code: "capture_targets_failed" })?.topic).toBe("capture");
    expect(diagnoseChannelFact({ area: "attachment", state: "waiting-source" })?.topic).toBe("attachment");
    expect(diagnoseChannelFact({ area: "attachment", state: "connecting" })).toBeNull();
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_storage_version" })?.topic).toBe("storage");
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_backup_version" })).toBeNull();
  });
});
