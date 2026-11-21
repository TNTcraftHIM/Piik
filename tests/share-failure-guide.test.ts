import { describe, expect, it } from "vitest";
import { shareFailureGuideSection } from "../src/client/components/living/ShareFailureHelp";
import { guidePaths } from "../src/client/lib/use-project-link";
import { hostFailureChecks } from "../src/client/pages/host-page-notices";

describe("sharing failure help", () => {
  it.each([
    ["browser/NotAllowedError", "no-screen-picker"],
    ["browser/NotReadableError", "sharing-does-not-start-after-source-selection"],
    ["app/start-share/disconnected", "app-windows-or-screens-are-missing"],
    ["site/http-403", "room-creation-returns-403"],
    ["site/http-500", undefined],
  ])("uses the relevant troubleshooting section for %s", (code, section) => {
    expect(shareFailureGuideSection(code, hostFailureChecks(code))?.en).toBe(section);
  });

  it("uses the Chinese article and section for Traditional Chinese", () => {
    const code = "site/http-403";
    const anchors = shareFailureGuideSection(code, hostFailureChecks(code));
    expect(guidePaths("zh-Hant", "troubleshooting", anchors)).toEqual({
      path: "/docs/zh/troubleshooting.html#创建房间返回-403",
      fallback: "https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/troubleshooting.zh-CN.md#创建房间返回-403",
    });
  });
});
