import { describe, expect, it } from "vitest";
import { documentBody, documentLink, pages } from "../site/docs/pages.mjs";
import { githubSlug } from "../scripts/markdown-slug.mjs";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
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

  it("names homepage task entries after their published article or section", () => {
    const read = (source: string) => readFileSync(new URL("../" + source, import.meta.url), "utf8");
    expect(pages.filter(page => !page.path.startsWith("zh/"))).toHaveLength(14);
    expect(pages.filter(page => page.path.startsWith("zh/"))).toHaveLength(14);
    for (const homepage of pages.filter(page => page.path === "index.md" || page.path === "zh/index.md")) {
      const entrances = read(homepage.source).match(/<div class="help-sections">([\s\S]*?)<\/div>/)?.[1];
      expect(entrances, homepage.source).toBeTruthy();
      const links = [...entrances!.matchAll(/^- \[([^\]]+)\]\((\.{1,2}\/[^)#]+\.md)(?:#([^)]*))?\)/gm)];
      expect(links.length, homepage.source).toBeGreaterThan(0);
      for (const [, label, path, fragment] of links) {
        const source = posix.join(posix.dirname(homepage.source), path);
        const target = pages.find(page => page.source === source);
        const context = homepage.source + " → " + path + (fragment ? "#" + fragment : "");
        expect(target, context).toBeDefined();
        const heading = fragment
          ? [...read(source).matchAll(/^#{2,6} (.+)$/gm)].map(match => match[1].trim())
              .find(text => githubSlug(text) === decodeURIComponent(fragment))
          : target?.text;
        expect(label, context).toBe(heading);
      }
    }

    for (const [article, anchors] of [
      ["getting-started", ["使用在线版"]],
      ["troubleshooting", ["问题排查", "邀请打不开或只有标题"]],
    ] as const) {
      const source = "docs/guide/" + article + ".zh-CN.md";
      const published = documentBody(read(source), source);
      for (const anchor of anchors) expect(published, source).toContain('<a id="' + anchor + '"></a>');
      expect(published, source).not.toContain("[English](./" + article + ".md) · 简体中文");
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
    expect(documentLink("/docs/operations/self-hosting.zh-CN.md", guide)).toBe("./self-hosting.html");
    expect(documentLink("../standards/configuration.md#diagnostics", guide))
      .toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/standards/configuration.md#diagnostics");
    expect(documentLink("../todo.md", guide)).toBe("https://github.com/TNTcraftHIM/Piik/blob/main/docs/todo.md");
    for (const href of ["#选择-app-模式", "?lang=en", "https://demo.piik.tv", "mailto:example@example.com"]) {
      expect(documentLink(href, guide)).toBe(href);
    }
  });
});
