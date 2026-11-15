import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

test("the actual page bridge reports late media after more than 128 startup resources", () => {
  const sent: { kind: string; urls?: string[] }[] = [];
  let report!: (list: { getEntries(): { name: string }[] }) => void;
  const page = { chrome: { webview: { postMessage: (message: string) => sent.push(JSON.parse(message)) } } };
  runInNewContext(readFileSync(new URL("../prototype/channel-server/src/app_windows/page-player.js", import.meta.url), "utf8"), {
    crypto: webcrypto, TextEncoder, window: page, top: page, document: {}, addEventListener() {},
    PerformanceObserver: class { constructor(callback: typeof report) { report = callback; } observe() {} },
    MutationObserver: class { observe() {} },
  });
  const scripts = Array.from({ length: 140 }, (_, i) => `https://page.test/static/${i}.js`);
  const media = "https://media.test/later-video.m4s";
  report({ getEntries: () => scripts.map(name => ({ name })) });
  report({ getEntries: () => [{ name: media }] });
  const batches = sent.filter(message => message.kind === "resources").map(message => message.urls!);
  expect(batches.every(batch => batch.length <= 128)).toBe(true);
  expect(batches.flat()).toEqual([...scripts, media]);
  expect(batches.at(-1)).toEqual([media]);
});

test("long resource URLs fit Native UTF-8 IPC with the full nested-frame envelope", () => {
  const bodies: string[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const child = {}, iframe = { contentWindow: child, isConnected: true };
  const page = { chrome: { webview: { postMessage: (message: string) => bodies.push(message) } } };
  runInNewContext(readFileSync(new URL("../prototype/channel-server/src/app_windows/page-player.js", import.meta.url), "utf8"), {
    crypto: webcrypto, TextEncoder, window: page, top: page,
    document: { querySelectorAll: () => [iframe] },
    addEventListener: (type: string, listener: (event: unknown) => void) => { if (type === "message") listeners.push(listener); },
    PerformanceObserver: class { observe() {} }, MutationObserver: class { observe() {} },
  });
  const urls = Array.from({ length: 128 }, (_, i) => `https://media.test/${i}.m4s?signature=${"a".repeat(3000)}&name=${"画".repeat(300)}`);
  const ancestors = Array.from({ length: 31 }, () => webcrypto.randomUUID());
  for (const listener of listeners) listener({ source: child, data: {
    bridge: "piik-page-player", kind: "resources", frame: webcrypto.randomUUID(), ancestors, urls,
  } });
  const resources = bodies.filter(body => JSON.parse(body).kind === "resources");
  expect(resources.length).toBeGreaterThan(1);
  expect(resources.every(body => Buffer.byteLength(body, "utf8") <= 65536)).toBe(true);
  const messages = resources.map(body => JSON.parse(body) as { ancestors: string[]; urls: string[] });
  expect(messages.every(message => message.ancestors.length === 32 && message.urls.length <= 128)).toBe(true);
  expect(messages.flatMap(message => message.urls)).toEqual(urls);
});
