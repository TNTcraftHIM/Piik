import { describe, expect, it } from "vitest";
import { documentBody, documentLink, pages } from "../site/docs/pages.mjs";
import { githubSlug } from "../scripts/markdown-slug.mjs";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { THEME_STORAGE_KEY } from "../src/client/ui/theme";

describe("reader documentation publication", () => {
  it("omits the repository language row while keeping ordinary linked instructions", () => {
    const title = "# Join a room\n\n";
    const navigation = "English · [简体中文](./joining.zh-CN.md)";
    const start = "Open your [invitation](./invite.md).\n";
    expect(documentBody(title + navigation + " · [Back to Piik](../../README.md)\n\n" + start, "docs/guide/joining.md"))
      .toBe(title + start);
    const linkedNote = title + navigation + " is available in the reader menu.\n\n" + start;
    expect(documentBody(linkedNote, "docs/guide/joining.md")).toBe(linkedNote);
  });

  it("publishes both help homepages with three starting tasks and header-owned language navigation", () => {
    const homepages = pages.filter(page => page.path === "index.md" || page.path === "zh/index.md");
    expect(homepages.map(page => page.path).sort()).toEqual(["index.md", "zh/index.md"]);
    for (const page of homepages) {
      const source = readFileSync(new URL("../" + page.source, import.meta.url), "utf8");
      const body = documentBody(source, page.source);
      expect(body).toContain("# " + page.text + "\n\n");
      expect(body).not.toMatch(/English.*简体中文/);
      const tasks = body.match(/<section class="help-actions">([\s\S]*?)<\/section>/)?.[1];
      expect(tasks?.match(/^- /gm)).toHaveLength(3);
    }
  });

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
    expect(documentLink("/docs/guide/network.zh-CN.md", guide)).toBe("./network.html");
    expect(documentLink("../deployment.md", guide)).toBe("./../deployment.html");
    expect(documentLink("../standards/configuration.md#diagnostics", guide))
      .toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/configuration.md#diagnostics");
    expect(documentLink("../todo.md", guide)).toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/todo.md");
    for (const href of ["#选择-app-模式", "?lang=en", "https://demo.piik.tv", "mailto:example@example.com"]) {
      expect(documentLink(href, guide)).toBe(href);
    }
  });
});
