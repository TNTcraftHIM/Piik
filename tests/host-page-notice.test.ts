import { describe, expect, it } from "vitest";

import {
  screenAudioQualityLockNotice,
  shouldPauseLocalPreview,
  sourceSwitchNotice,
  videoCodecLockNotice,
} from "../src/client/pages/host-page-notices.ts";

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
        sfuWarning: null,
      }),
    ).toBe("SFU 分享来源未切换成功，正在恢复观看连接");
  });

  it("surfaces an SFU sender warning after a successful replacement", () => {
    expect(
      sourceSwitchNotice({
        failedPeerCount: 1,
        sfuReplaced: true,
        sfuWarning: "浏览器改写了 SFU 发送参数",
      }),
    ).toBe("浏览器改写了 SFU 发送参数；部分观看者正在重新连接");
  });

  it("reports success only when every active route replacement succeeded", () => {
    expect(
      sourceSwitchNotice({
        failedPeerCount: 0,
        sfuReplaced: true,
        sfuWarning: null,
      }),
    ).toBe("分享来源已切换");
  });
});

describe("videoCodecLockNotice", () => {
  it("explains why codec controls are locked during a share", () => {
    expect(videoCodecLockNotice("starting")).toBe(
      "本次分享的编码已锁定，停止分享后可修改",
    );
    expect(videoCodecLockNotice("live")).toBe(
      "本次分享的编码已锁定，停止分享后可修改",
    );
    for (const phase of ["idle", "ended", "error"]) {
      expect(videoCodecLockNotice(phase)).toBeNull();
    }
  });
});

describe("screenAudioQualityLockNotice", () => {
  it("explains why audio quality is locked during a share", () => {
    expect(screenAudioQualityLockNotice("starting")).toBe(
      "本次分享的音频质量已锁定，停止分享后可修改",
    );
    expect(screenAudioQualityLockNotice("live")).toBe(
      "本次分享的音频质量已锁定，停止分享后可修改",
    );
    for (const phase of ["idle", "ended", "error"]) {
      expect(screenAudioQualityLockNotice(phase)).toBeNull();
    }
  });
});
