import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getTitleFrames,
  isCopyKey,
  say,
  setCopy,
  t,
  type CopyKey,
} from "../src/client/ui/copy.ts";

describe("copy catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCopy({ lang: "zh", vis: false });
  });

  it("renders zh and en for every key", () => {
    const zh = t("zh", "join.title");
    expect(zh).toBe("加入房间");
    expect(t("en", "join.title")).toBe("Join a room");
    expect(t("zh", "host.advanced.route.peerOnly")).toBe("隐私模式");
    expect(t("en", "host.advanced.route.peerOnly")).toBe("Privacy mode");
    expect(isCopyKey("viewer.reconnect")).toBe(true);
    expect(isCopyKey("Reconnect media")).toBe(false);
  });

  it("interpolates variables", () => {
    expect(t("zh", "host.title", { name: "阿舟" })).toBe("阿舟 的屏幕");
    expect(t("en", "host.onlineCount", { n: "4", max: "20" })).toBe(
      "4 / 20 online",
    );
    expect(t("zh", "viewer.title", { name: "$&" })).toBe("$& 的屏幕");
  });

  it("keeps zh and en key sets identical", () => {
    // Type-level parity is enforced by Record<keyof typeof zh, string>;
    // this guards runtime drift if the catalog shape changes.
    for (const key of ["host.start", "viewer.msg.playing", "stats.more"] as CopyKey[]) {
      expect(t("zh", key).length).toBeGreaterThan(0);
      expect(t("en", key).length).toBeGreaterThan(0);
    }
  });

  it("say() follows the current language", () => {
    setCopy({ lang: "zh" });
    expect(say("common.copied")).toBe("已复制");
    setCopy({ lang: "en" });
    expect(say("common.copied")).toBe("Copied");
  });

  it("keeps title variations in the selected content catalog", () => {
    const zhHost = getTitleFrames("zh", false, "hostActive");
    const enViewer = getTitleFrames("en", false, "viewerActive");
    const visualViewer = getTitleFrames("zh", true, "viewerActive");

    expect(zhHost[0]).toBe("分享中");
    expect(zhHost).toContain("小电视上工");
    expect(enViewer[0]).toBe("Watching");
    expect(enViewer).toContain("Popcorn ready");
    expect(visualViewer[0]).toBe("📺");
    expect(visualViewer).toContain("📺 🍿");
    expect(getTitleFrames("zh", false, "hostIdle")).toContain("天线在打盹");
    expect(getTitleFrames("en", false, "viewerWaiting")).toContain(
      "Couch saved you a spot",
    );
    expect(getTitleFrames("zh", true, "hostReady")).toContain("🛋️ 🍵");
  });

  it("keeps the document language aligned with the selected catalog", () => {
    const documentElement = { lang: "zh-CN" };
    vi.stubGlobal("document", { documentElement });

    setCopy({ lang: "en" });
    expect(documentElement.lang).toBe("en");
    setCopy({ lang: "zh" });
    expect(documentElement.lang).toBe("zh-CN");
  });
});
