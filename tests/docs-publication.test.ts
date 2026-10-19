import { describe, expect, it } from "vitest";
import { documentLink } from "../site/docs/pages.mjs";
import { githubSlug } from "../scripts/markdown-slug.mjs";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { THEME_STORAGE_KEY } from "../src/client/ui/theme";

describe("reader documentation publication", () => {
  it("uses the shared appearance key before the native documentation runtime starts", () => {
    const config = readFileSync(new URL("../site/docs/.vitepress/config.mjs", import.meta.url), "utf8");
    const template = config.match(/appearance\[2\] = (`[\s\S]*?`);/)?.[1];
    expect(template).toBeTruthy();
    const script = runInNewContext(template!, { THEME_STORAGE_KEY });
    for (const [preference, systemDark, blocked, expected] of [
      ["light", true, false, false], ["dark", false, false, true],
      [null, true, false, true], ["auto", false, false, false],
      [null, true, true, true],
    ] as const) {
      let dark = false;
      runInNewContext(script, {
        document: { documentElement: { classList: { toggle: (_name: string, value: boolean) => { dark = value; } } } },
        localStorage: { getItem: (key: string) => {
          if (blocked) throw new Error("Storage disabled");
          expect(key).toBe("piik:ui-theme");
          return preference;
        } },
        window: { matchMedia: () => ({ matches: systemDark }) },
      });
      expect(dark).toBe(expected);
    }
  });
  it("preserves repository anchors for apostrophes, numbered steps and Chinese punctuation", () => {
    expect(githubSlug("Join a friend's room")).toBe("join-a-friends-room");
    expect(githubSlug("2. Enable HTTPS")).toBe("2-enable-https");
    expect(githubSlug("可选：启用媒体兜底")).toBe("可选启用媒体兜底");
    expect(githubSlug("Piik &amp; **friends**")).toBe("piik-friends");
  });

  it("keeps translated guides and anchors local, while linking unpublished references to their source", () => {
    const guide = "docs/guide/getting-started.zh-CN.md";
    expect(documentLink("../../cmd/piik-app/README.zh-CN.md#诊断", guide)).toBe("./app.html#诊断");
    expect(documentLink("./getting-started.md#share-with-piik-app", guide)).toBe("./../getting-started.html#share-with-piik-app");
    expect(documentLink("/docs/operations/self-hosting.zh-CN.md", guide)).toBe("./self-hosting.html");
    expect(documentLink("../standards/configuration.md#diagnostics", guide))
      .toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/configuration.md#diagnostics");
    expect(documentLink("../todo.md", guide)).toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/todo.md");
    for (const href of ["#选择-app-模式", "?lang=en", "https://demo.piik.tv", "mailto:example@example.com"]) {
      expect(documentLink(href, guide)).toBe(href);
    }
  });
});
