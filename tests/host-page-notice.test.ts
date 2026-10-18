import { describe, expect, it } from "vitest";

import { say, setCopy } from "../src/client/ui/copy.ts";
import { NativeMediaBridgeError, NativeMediaBridgeInitializationError } from "../src/client/native/media-bridge";
import { NativeRequestError } from "../src/client/native/client";
import {
  hostActionErrorKey,
  hostFailureCode,
  hostFailureChecks,
  hostServerErrorKey,
  shouldPauseLocalPreview,
  sourceSwitchNotice,
} from "../src/client/pages/host-page-notices.ts";

setCopy({ lang: "zh" });

describe("host error notices", () => {
  it("keeps known App failure boundaries and support context without claiming a driver diagnosis", () => {
    const rejected = new NativeRequestError("rejected", "start-share", { cause: "private source title" });
    const timeout = new NativeRequestError("timeout", "start-share");
    const disconnected = new NativeRequestError("disconnected", "start-share");
    expect(hostActionErrorKey(rejected, "capture")).toBe("native.fail.captureStart");
    expect(hostActionErrorKey(timeout, "capture")).toBe("native.fail.requestTimeout");
    expect(hostActionErrorKey(disconnected, "capture")).toBe("native.fail.controlDisconnected");
    expect(hostFailureCode(rejected, "capture")).toBe("app/start-share/rejected");
    expect(hostFailureCode(new Error("secret invitation and source"), "capture")).toBe("capture/unknown");
    expect(hostFailureCode(new DOMException("secret", "UnrecognizedError"), "capture")).toBe("capture/unknown");
    expect(hostFailureCode(new DOMException("secret", "NotAllowedError"), "capture", "camera")).toBe("camera/NotAllowedError");
  });

  it.each([
    ["site/http-403", ["shareHelp.site"]],
    ["room/unknown", ["shareHelp.site"]],
    ["app/start-share/rejected", ["shareHelp.source", "shareHelp.compare"]],
    ["app/start-share/timeout", ["shareHelp.appConnection"]],
    ["app/control/disconnected", ["shareHelp.appConnection"]],
    ["app/prepare-edge/disconnected", ["shareHelp.appConnection"]],
    ["app/prepare-edge/rejected", ["shareHelp.mediaConnection"]],
    ["app/browser-media/connection", ["shareHelp.mediaConnection"]],
    ["app/capture/failed", ["shareHelp.source", "shareHelp.compare"]],
    ["browser/NotAllowedError", ["shareHelp.permission"]],
    ["browser/NotReadableError", ["shareHelp.source"]],
    ["camera/NotAllowedError", ["shareHelp.camera"]],
    ["status/unknown", []],
    ["connection/unknown", []],
    ["quality/unknown", []],
    ["app/update-share/rejected", []],
  ])("keeps troubleshooting relevant to %s", (code, checks) => {
    expect(hostFailureChecks(code as string)).toEqual(checks);
  });
  it.each([
    ["zh", "浏览器无法建立媒体连接，请刷新页面重试。"],
    ["en", "The browser could not create a media connection; reload to retry."],
  ] as const)("identifies Browser initialization failure in %s without blaming capture permission", (lang, notice) => {
    setCopy({ lang });
    try {
      const failure = new NativeMediaBridgeInitializationError("private detail", {
        cause: new DOMException("private cause", "NotAllowedError"),
      });
      expect(hostActionErrorKey(failure, "capture")).toBe("native.fail.browserMedia");
      expect(say(hostActionErrorKey(failure, "capture"))).toBe(notice);
    } finally {
      setCopy({ lang: "zh" });
    }
  });

  it("classifies the native preview bridge as a connection failure", () => {
    expect(hostActionErrorKey(new NativeMediaBridgeError("private detail"), "capture"))
      .toBe("native.fail.edge");
  });

  it("maps every server error code without exposing server text", () => {
    const notices = {
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
    } as const;

    for (const [code, notice] of Object.entries(notices)) {
      expect(
        hostServerErrorKey(code as keyof typeof notices),
      ).toBe(notice);
      expect(notice).not.toContain("server-internal-sentinel");
    }
  });

  it("uses stable action messages instead of arbitrary exception text", () => {
    const sentinel = new Error("browser-internal-sentinel");
    expect(hostActionErrorKey(sentinel, "quality")).toBe(
      "host.fail.quality",
    );
    expect(hostActionErrorKey(sentinel, "connection")).toBe(
      "host.fail.connection",
    );
    expect(hostActionErrorKey(sentinel, "room")).toBe("host.fail.room");
    expect(hostActionErrorKey(sentinel, "source")).toBe("host.fail.source");
    expect(hostActionErrorKey(sentinel, "sourceAudio")).toBe("host.fail.sourceAudio");
  });

  it.each([
    ["NotAllowedError", "host.capture.cancelled"],
    ["NotFoundError", "host.capture.noSource"],
    ["NotReadableError", "host.capture.readFailed"],
    ["SecurityError", "host.capture.unavailable"],
    ["InvalidStateError", "host.capture.inactive"],
    ["OverconstrainedError", "host.capture.constraints"],
  ])("maps capture DOMException %s", (name, notice) => {
    expect(
      hostActionErrorKey(new DOMException("raw-browser-text", name), "capture"),
    ).toBe(notice);
  });
});

describe("shouldPauseLocalPreview", () => {
  it("distinguishes local preview suspension from active focus", () => {
    expect(shouldPauseLocalPreview("hidden", true)).toBe(true);
    expect(shouldPauseLocalPreview("visible", false)).toBe(true);
    expect(shouldPauseLocalPreview("visible", true)).toBe(false);
  });
});

describe("sourceSwitchNotice", () => {
  it("does not report success when the SFU source replacement failed", () => {
    expect(
      sourceSwitchNotice({
        failedPeerCount: 0,
        sfuReplaced: false,
      }),
    ).toBe("服务器中转的画面来源未切换成功，正在恢复观看连接");
  });

  it("reports success only when every active route replacement succeeded", () => {
    expect(
      sourceSwitchNotice({
        failedPeerCount: 0,
        sfuReplaced: true,
      }),
    ).toBe("分享来源已切换");
  });
});
