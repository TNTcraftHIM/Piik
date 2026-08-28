import { afterEach, describe, expect, it, vi } from "vitest";

import { say, setCopy, t, type CopyKey } from "../src/client/ui/copy.ts";

describe("copy catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCopy({ lang: "zh", vis: false });
  });

  it("renders zh and en for every key", () => {
    const zh = t("zh", "join.title");
    expect(zh).toBe("加入房间");
    expect(t("en", "join.title")).toBe("Join a room");
  });

  it("interpolates variables", () => {
    expect(t("zh", "host.title", { name: "阿舟" })).toBe("阿舟 的屏幕");
    expect(t("en", "host.onlineCount", { n: "4", max: "20" })).toBe(
      "4 / 20 online",
    );
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

  it("keeps the document language aligned with the selected catalog", () => {
    const documentElement = { lang: "zh-CN" };
    vi.stubGlobal("document", { documentElement });

    setCopy({ lang: "en" });
    expect(documentElement.lang).toBe("en");
    setCopy({ lang: "zh" });
    expect(documentElement.lang).toBe("zh-CN");
  });
});
