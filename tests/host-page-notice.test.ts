import { describe, expect, it } from "vitest";

import { setCopy } from "../src/client/ui/copy.ts";
import { NativeMediaBridgeError } from "../src/client/native/media-bridge";
import {
  hostActionErrorNotice,
  hostServerErrorNotice,
  shouldPauseLocalPreview,
  sourceSwitchNotice,
} from "../src/client/pages/host-page-notices.ts";

setCopy({ lang: "zh" });

describe("host error notices", () => {
  it("classifies the native preview bridge as a connection failure", () => {
    expect(hostActionErrorNotice(new NativeMediaBridgeError("private detail"), "capture"))
      .toBe(hostActionErrorNotice(new Error("private detail"), "connection"));
  });

  it("maps every server error code without exposing server text", () => {
    const notices = {
      AUTH_REQUIRED: "站点访问已失效，请重新验证",
      INVALID_MESSAGE: "页面版本已更新，请刷新后重试",
      INVALID_TOKEN: "分享凭证已失效，请重新创建房间",
      ROOM_NOT_FOUND: "房间不存在",
      ROOM_ACCESS_DENIED: "当前操作没有权限",
      ROOM_FULL: "房间已满",
      HOST_ALREADY_CONNECTED: "此房间已在另一个页面中分享",
      PEER_NOT_FOUND: "对应的观看连接已经离开",
      FORBIDDEN: "当前操作不可用",
      SERVER_ERROR: "服务暂时不可用，请稍后重试",
    } as const;

    for (const [code, notice] of Object.entries(notices)) {
      expect(
        hostServerErrorNotice(code as keyof typeof notices),
      ).toBe(notice);
      expect(notice).not.toContain("server-internal-sentinel");
    }
  });

  it("uses stable action messages instead of arbitrary exception text", () => {
    const sentinel = new Error("browser-internal-sentinel");
    expect(hostActionErrorNotice(sentinel, "quality")).toBe(
      "应用画质设置失败",
    );
    expect(hostActionErrorNotice(sentinel, "connection")).toBe(
      "观看连接处理失败",
    );
    expect(hostActionErrorNotice(sentinel, "room")).toBe("房间操作失败");
    expect(hostActionErrorNotice(sentinel, "source")).toBe("切换分享来源失败");
  });

  it.each([
    ["NotAllowedError", "屏幕选择已取消或没有共享权限"],
    ["NotFoundError", "没有可用的屏幕分享来源"],
    ["NotReadableError", "浏览器暂时无法读取所选分享来源"],
    ["SecurityError", "当前页面无法启动屏幕分享"],
  ])("maps capture DOMException %s", (name, notice) => {
    expect(
      hostActionErrorNotice(new DOMException("raw-browser-text", name), "capture"),
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
    ).toBe("SFU 分享来源未切换成功，正在恢复观看连接");
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
