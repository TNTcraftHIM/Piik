import { describe, expect, it } from "vitest";
import { documentLink } from "../site/docs/pages.mjs";
import { githubSlug } from "../scripts/markdown-slug.mjs";

describe("reader documentation publication", () => {
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
