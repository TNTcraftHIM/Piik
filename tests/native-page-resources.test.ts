import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

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

function candidateBridge(clock?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">) {
  const bodies: string[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let discover!: () => void, flush!: () => void;
  let videos: ReturnType<typeof ownedVideo>[] = [];
  const iframes: { contentWindow: object; isConnected: boolean }[] = [];
  const page = { chrome: { webview: { postMessage: (body: string) => bodies.push(body) } } };
  runInNewContext(readFileSync(new URL("../prototype/channel-server/src/app_windows/page-player.js", import.meta.url), "utf8"), {
    crypto: webcrypto, TextEncoder, URL, AbortController, window: page, top: page,
    location: { hostname: "owned.test" }, document: { title: "Owned", querySelectorAll: (tag: string) => tag === "video" ? videos : iframes },
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    PerformanceObserver: class { observe() {} }, MutationObserver: class { constructor(callback: () => void) { discover = callback; } observe() {} },
    setTimeout(callback: () => void) { flush = callback; return 1; }, clearTimeout() {}, ...clock,
  });
  return { bodies, iframes, discover, hide() { listeners.get("pagehide")?.forEach(listener => listener({})); },
    setVideos(next: typeof videos) { for (const old of videos) if (!next.includes(old)) old.isConnected = false; videos = next; discover(); if (!clock) flush(); },
    message(event: unknown) { return Promise.all((listeners.get("message") ?? []).map(listener => listener(event))); },
  };
}
function ownedVideo(index: number) {
  return { isConnected: true, currentSrc: `https://media.test/${index}.mp4?signature=${"a".repeat(3900)}`,
    title: `Video ${index}`, duration: 30, currentTime: 0, paused: true, playbackRate: 1, readyState: 4, ended: false,
    buffered: { length: 0 }, pause() { this.paused = true; }, async play() { this.paused = false; },
    getAttribute() { return null; }, addEventListener() {} };
}

test("candidate batches fit Native IPC and explicitly remove the replaced element without losing later candidates", () => {
  const bridge = candidateBridge(), first = ownedVideo(0);
  bridge.setVideos([first]);
  const old = JSON.parse(bridge.bodies.at(-1)!).candidates[0].media;
  bridge.bodies.length = 0;
  bridge.setVideos(Array.from({ length: 12 }, (_, i) => ownedVideo(i + 1)));
  expect(bridge.bodies.every(body => Buffer.byteLength(body, "utf8") <= 65536)).toBe(true);
  const batches = bridge.bodies.map(body => JSON.parse(body));
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flatMap(batch => batch.candidates)).toHaveLength(12);
  expect(batches.every(batch => batch.removed.includes(old))).toBe(true);
});

test("same element changes its resource without changing identity, and removing all elements emits the empty delta", () => {
  const bridge = candidateBridge(), video = ownedVideo(0);
  bridge.setVideos([video]);
  const id = JSON.parse(bridge.bodies.at(-1)!).candidates[0].media;
  video.currentSrc = "https://media.test/replaced.mp4";
  bridge.setVideos([video]);
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ candidates: [{ media: id, resource: video.currentSrc }], removed: [] });
  bridge.setVideos([]);
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ candidates: [], removed: [id] });
});

test("same iframe WindowProxy navigating retires its previous document without retiring a sibling", () => {
  const bridge = candidateBridge(), child = {}, sibling = {};
  bridge.iframes.push({ contentWindow: child, isConnected: true }, { contentWindow: sibling, isConnected: true });
  const previous = webcrypto.randomUUID(), next = webcrypto.randomUUID(), other = webcrypto.randomUUID();
  const send = (source: object, frame: string) => bridge.message({ source, data: {
    bridge: "piik-page-player", kind: "resources", frame, ancestors: [], urls: ["https://media.test/file.m3u8"],
  } });
  send(child, previous); send(sibling, other); send(child, next);
  expect(bridge.bodies.map(body => JSON.parse(body)).filter(value => value.kind === "removed").map(value => value.removed)).toEqual([previous]);
});


test("moving an existing player within its document retains its candidate while popup controls stay bound to their document", async () => {
  const main = candidateBridge(), popup = candidateBridge(), mainVideo = ownedVideo(0), popupVideo = ownedVideo(0);
  main.setVideos([mainVideo]); popup.setVideos([popupVideo]);
  const first = JSON.parse(main.bodies.at(-1)!);
  const child = JSON.parse(popup.bodies.at(-1)!);
  // A layout move and return delivers mutations but retains the live DOM element.
  main.setVideos([mainVideo]); main.setVideos([mainVideo]);
  expect(JSON.parse(main.bodies.at(-1)!)).toMatchObject({ frame: first.frame, candidates: [{ media: first.candidates[0].media }], removed: [] });
  expect(child.frame).not.toBe(first.frame);
  expect(child.candidates[0].media).not.toBe(first.candidates[0].media);
  const command = { data: { bridge: "piik-page-command", frame: child.frame,
    media: child.candidates[0].media, kind: "patch", request: webcrypto.randomUUID(), patch: { paused: false, position: 12 } } };
  await main.message(command); await popup.message(command);
  expect(mainVideo).toMatchObject({ paused: true, currentTime: 0 });
  expect(popupVideo).toMatchObject({ paused: false, currentTime: 12 });
  // Closing the popup is not an update/removal of the parent's same-URL candidate.
  popup.setVideos([]);
  expect(JSON.parse(popup.bodies.at(-1)!)).toMatchObject({ frame: child.frame, removed: [child.candidates[0].media] });
  expect(JSON.parse(main.bodies.at(-1)!)).toMatchObject({ frame: first.frame, candidates: [{ media: first.candidates[0].media }], removed: [] });
});

test("continuous mutations deliver candidate addition and retirement before pagehide cancels pending work", () => {
  vi.useFakeTimers();
  try {
    const bridge = candidateBridge({ setTimeout, clearTimeout });
    const churn = () => {
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(30);
        bridge.discover();
      }
    };
    bridge.setVideos([ownedVideo(1)]);
    churn();
    const selected = JSON.parse(bridge.bodies.at(-1)!).candidates[0].media;
    bridge.setVideos([]);
    churn();
    expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ removed: [selected] });
    bridge.setVideos([ownedVideo(2)]);
    bridge.hide();
    vi.runAllTimers();
    expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "removed" });
  } finally { vi.useRealTimers(); }
});
