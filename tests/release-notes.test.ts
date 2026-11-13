import { expect, test } from "vitest";
import { renderReleaseNotes } from "../src/client/lib/release-notes";
import previewRelease from "../src/client/pages/preview-release.json";

test("release prose retains headings, lists, tables, code and safe external links", () => {
  const html = renderReleaseNotes("# Release\n\n## Changes\n\n- **Sharing**\n- Voice\n\n| App | Notes |\n| --- | --- |\n| Desktop | Fixed |\n\n```sh\npiik-app --browser\n```\n\n[Guide](https://example.org/guide) <team@example.org>");
  for (const tag of ["h1", "h2", "ul", "strong", "table", "pre", "code"]) expect(html).toContain(`<${tag}`);
  expect(html).toContain("piik-app --browser");
  expect(html).toContain('href="https://example.org/guide" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('href="mailto:team@example.org" target="_blank" rel="noopener noreferrer"');
});

test("release HTML remains text and unsafe or App-relative links cannot navigate", () => {
  const html = renderReleaseNotes('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[script](javascript:alert(1)) [data](data:text/html,hello) [local](/client) [file](file:///private) [encoded](jav&#x61;script:alert(1))');
  expect(html).not.toMatch(/<(?:script|img|iframe)\b/);
  expect(html).not.toContain("href=");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("only the mirror's complete matching provenance tail is hidden from the reader", () => {
  // Actual AtomGit v2.6.2 tail, produced by scripts/mirror-release.mjs.
  const revision = "ad02ae0bbcb70456611c44fd42fa1198d0d5d639";
  const source = `Source: https://github.com/TNTcraftHIM/Piik/commit/${revision}`;
  const marker = `<!-- piik-source: ${revision} -->`;
  const tail = `${source}\n\n${marker}\n`;
  expect(renderReleaseNotes(`## Changes\n\nPublished text.\n\n${tail}`))
    .toBe(renderReleaseNotes("## Changes\n\nPublished text.\n"));
  expect(renderReleaseNotes(tail)).toBe("");
  for (const authored of [source, tail.replace(revision, "a".repeat(40)),
    tail.replace("TNTcraftHIM/Piik", "other/project"), `${tail}\nMore published text.`,
    `\`\`\`text\n${tail}\`\`\``]) {
    expect(renderReleaseNotes(authored)).toContain("Source:");
  }
  expect(renderReleaseNotes(marker)).toContain("&lt;!-- piik-source:");
  expect(renderReleaseNotes("   \n")).toBe("");
});

test("the published v2.6.3 body keeps all release prose without its generated build details", () => {
  const html = renderReleaseNotes(previewRelease.body);
  for (const heading of ["English", "中文", "Security / 安全更新", "Capture reliability / 采集稳定性", "Verification / 验证"])
    expect(html).toContain(`<h3>${heading}</h3>`);
  expect(html).toContain("Full changelog / 完整变更");
  expect(html).toContain("曾保存过旧临时网址的用户");
  expect(html).not.toMatch(/piik-build-checksums|&lt;details&gt;|Build and checksums|piik-app-windows-amd64.zip/);
  expect(previewRelease.body).toContain("<!-- piik-build-checksums:start -->");
  expect(renderReleaseNotes("<details>Authored HTML stays literal</details>"))
    .toContain("&lt;details&gt;Authored HTML stays literal&lt;/details&gt;");
});
