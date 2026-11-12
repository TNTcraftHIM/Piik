import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelMessageContent } from "../src/client/channel/components/ChannelMessageContent";
import { setCopy } from "../src/client/ui/copy";

const users = [{ id: "bo", name: "Bo", version: "0".repeat(64) }];
function render(text: string, mentions: { userId: string; start: number; end: number }[] = []) {
  setCopy({ lang: "en", vis: false });
  return renderToStaticMarkup(createElement(ChannelMessageContent, { message: { text, mentions }, users, selfUserId: "bo" }));
}

test("chat uses readable emphasis, lists, quotes, explicit and automatic links with line breaks", () => {
  const html = render("**bold** *italic* ~~gone~~ `literal *code*`\nnext\n\n- one\n- two\n\n> quote\n\n[docs](https://example.org/path) https://example.org/");
  for (const tag of ["strong", "em", "s", "code", "ul", "li", "blockquote", "br", "a"]) expect(html).toContain(`<${tag}`);
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("literal *code*");
});

test("HTML and images stay literal, unsafe links never become navigation and code stays text", () => {
  const html = render('<img src=x onerror=alert(1)> ![remote](https://example.org/private.png) [bad](javascript:alert(1)) [data](data:text/html,hello)\n\n```html\n<script>alert(1)</script>\n```');
  expect(html).not.toMatch(/<(?:img|script|iframe)\b/);
  expect(html).not.toMatch(/href="(?:javascript:|data:)/);
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("Copy code");
});

test("only confirmed UTF-16 ranges become identity mentions, while code and destinations remain literal", () => {
  const text = "😀 **@Bo** and @Fake\n\n`@Bo`\n\n```\n@Bo\n```\n\n[link](https://example.org/@Bo)";
  const starts = [...text.matchAll(/@Bo/g)].map(match => match.index);
  const mentions = starts.map(start => ({ userId: "bo", start, end: start + 3 }));
  const html = render(text, mentions);
  expect(html.match(/<mark\b/g)).toHaveLength(1);
  expect(html).toContain('<strong><mark class="c3-message-mention is-self" title="Bo">@Bo</mark></strong>');
  expect(html).toContain("and @Fake");
  expect(html).toContain("<code>@Bo</code>");
  expect(html).toContain('href="https://example.org/@Bo"');
  expect(html).not.toContain("\uE000");
});

test("literal internal-marker-like text cannot forge a mention and code content is not syntax highlighted", () => {
  const text = "\uE0000\uE000 **@Bo**\n\n```js\nconst value = '<img>';\n```";
  const start = text.indexOf("@Bo");
  const html = render(text, [{ userId: "bo", start, end: start + 3 }]);
  expect(html.match(/<mark\b/g)).toHaveLength(1);
  expect(html).toContain("\uE0000\uE000");
  expect(html).toContain("const value = &#x27;&lt;img&gt;&#x27;;\n");
  expect(html).not.toContain("language-js");
});

test("percent-encoded user URLs are not changed when confirmed mentions are protected", () => {
  const href = "https://example.org/%EE%80%800%EE%80%80";
  const text = `@Bo [literal](${href})`;
  const html = render(text, [{ userId: "bo", start: 0, end: 3 }]);
  expect(html).toContain(`href="${href}"`);
  expect(html.match(/<mark\b/g)).toHaveLength(1);
});

test("Markdown entity decoding cannot forge mention markers in text or destinations", () => {
  const text = "@Bo &#xE000;0&#57344; [literal](https://example.org/&#xE000;0&#57344;)\n\n`&#xE000;0&#57344;`\n\n```\n&#xE000;0&#57344;\n```";
  const html = render(text, [{ userId: "bo", start: 0, end: 3 }]);
  expect(html.match(/<mark\b/g)).toHaveLength(1);
  expect(html).toContain("\uE0000\uE000");
  expect(html).toContain('href="https://example.org/%EE%80%800%EE%80%80"');
  expect(html).toContain("<code>&amp;#xE000;0&amp;#57344;</code>");
  expect(html).toContain("<code>&amp;#xE000;0&amp;#57344;\n</code>");
});
