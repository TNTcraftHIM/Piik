import { describe, expect, it } from "vitest";
import { diagnoseChannelFact } from "../src/client/channel/diagnosis";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";

describe("diagnosis using the current operation", () => {
  it("explains when an operation requires peer transport", () => {
    expect(channelErrorPresentation("peer_transport_unavailable", key => key)).toEqual({
      message: "channel.error.peerTransportUnavailable", connectionHelp: false,
    });
  });
  it("offers the local approval page when discovery succeeds, and asserts denied access only on an explicit refusal", () => {
    expect(diagnoseChannelFact({ area: "app", state: "approval" })).toMatchObject({ message: "client.connect.found", next: "client.connect.open" });
    expect(diagnoseChannelFact({ area: "app", state: "approving" })).toBeNull();
    expect(channelErrorPresentation("site_not_approved", key => key).message).toBe("client.sites.notAllowed");
    expect(diagnoseChannelFact({ area: "app", state: "unavailable" })).toMatchObject({ message: "client.connect.unavailable", topic: "appConnection" });
    expect(diagnoseChannelFact({ area: "app", state: "incompatible" })).toMatchObject({ message: "client.connect.incompatible", topic: "appVersion" });
  });

  it("keeps admission and the selected picture's retry separate", () => {
    expect(diagnoseChannelFact({ area: "error", code: "room_access_required" })?.topic).toBe("room");
    expect(diagnoseChannelFact({ area: "error", code: "ice_failed" })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: true })?.message).toBe("diagnosis.noPicture");
    expect(diagnoseChannelFact({ area: "screen", paused: true, deliveryFailed: true })).toBeNull();
    expect(diagnoseChannelFact({ area: "screen", paused: false, deliveryFailed: false })).toBeNull();
  });

  it("keeps source permissions, failed reads and incompatible storage tied to their own operations", () => {
    expect(diagnoseChannelFact({ area: "error", code: "watch_media_access_denied" })?.message).toBe("watch.mediaAccessDenied");
    for (const code of ["watch_media_timeout", "watch_read_timeout"]) {
      expect(diagnoseChannelFact({ area: "error", code })).toMatchObject({ message: "watch.forward.readTimeout", topic: "webpage" });
    }
    expect(diagnoseChannelFact({ area: "error", code: "capture_targets_failed" })?.topic).toBe("capture");
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_storage_version" })?.topic).toBe("storage");
    expect(diagnoseChannelFact({ area: "error", code: "unsupported_backup_version" })).toBeNull();
  });
});
