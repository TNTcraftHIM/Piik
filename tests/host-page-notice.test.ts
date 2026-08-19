import { describe, expect, it } from "vitest";

import { sourceSwitchNotice } from "../src/client/pages/host-page-notices.ts";

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
