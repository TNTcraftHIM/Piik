import assert from "node:assert/strict";

// Vite can place shared build metadata in an eagerly loaded dependency. Check
// the modules named by the served HTML, not an unrelated file in the image.
export function webSourceAssets(html) {
  const main = html.match(/<script\b[^>]*\bsrc="((?:\.?\/)?assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  assert.ok(main, "Package must serve the Web UI");
  const preloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="((?:\.?\/)?assets\/[A-Za-z0-9_-]+\.js)"/g)]
    .map(match => match[1]);
  return [...new Set([main, ...preloads].map(asset => new URL(asset, "http://piik.invalid/").pathname))];
}

export async function checkWebSourceIdentity(html, revision, readScript) {
  const scripts = await Promise.all(webSourceAssets(html).map(asset => readScript(asset)));
  assert.ok(scripts.some(script => script.includes(revision)), "Web and runtime must have the same source identity");
}
