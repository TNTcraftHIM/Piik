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
  return { bodies, iframes, discover, flush: () => flush(), hide() { listeners.get("pagehide")?.forEach(listener => listener({})); },
    setVideos(next: typeof videos) { for (const old of videos) if (!next.includes(old)) old.isConnected = false; videos = next; discover(); if (!clock) flush(); },
    message(event: unknown) { return Promise.all((listeners.get("message") ?? []).map(listener => listener(event))); },
  };
}
function ownedVideo(index: number) {
  const events = new EventTarget();
  return { isConnected: true, currentSrc: `https://media.test/${index}.mp4?signature=${"a".repeat(3900)}`,
    title: `Video ${index}`, duration: 30, currentTime: 0, paused: true, playbackRate: 1, readyState: 4, ended: false,
    buffered: { length: 0 }, pause() { this.paused = true; }, async play() { this.paused = false; },
    getAttribute(_name: string): string | null { return null; }, querySelectorAll: (_selector: string): { src: string; getAttribute(name: string): string | null }[] => [],
    addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
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

test("original page seeks its selected element after a Blob resource replacement", async () => {
  const bridge = candidateBridge(), video = ownedVideo(0);
  bridge.setVideos([video]);
  const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
  video.currentSrc = "blob:https://owned.test/replacement";
  await bridge.message({ data: { bridge: "piik-page-command", frame, media, revision, originalPage: true,
    kind: "patch", request: webcrypto.randomUUID(), patch: { position: 12 } } });
  expect(video.currentTime).toBe(12);
});

test.each(["currentSrc", "src", "source"])("rebuilding the sole player of the same resource keeps its commands on the replacement (%s)", async declaration => {
  const bridge = candidateBridge(), first = ownedVideo(0);
  const next = { ...ownedVideo(0), currentSrc: declaration === "currentSrc" ? first.currentSrc : "", src: first.currentSrc,
    getAttribute: (name: string) => name === "src" && declaration === "src" ? first.currentSrc : null,
    querySelectorAll: (selector: string) => selector === ":scope > source" && declaration === "source"
      ? [{ src: first.currentSrc, getAttribute: () => first.currentSrc }] : [] };
  bridge.setVideos([first]);
  const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
  bridge.setVideos([next]);
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ removed: [], candidates: [{ media, resource: first.currentSrc }] });
  await bridge.message({ data: { bridge: "piik-page-command", frame, media, revision, kind: "patch",
    request: webcrypto.randomUUID(), patch: { position: 12 } } });
  expect(next.currentTime).toBe(12);
  expect(first.currentTime).toBe(0);
  bridge.setVideos([ownedVideo(0), ownedVideo(0)]);
  expect(JSON.parse(bridge.bodies.at(-1)!).removed).toEqual([media]);
});

test("a page rebuilding several players transfers commands only for each unique source", async () => {
  const bridge = candidateBridge();
  bridge.setVideos([ownedVideo(0), ownedVideo(1), ownedVideo(1)]);
  const { frame, candidates: [selected, duplicate, otherDuplicate] } = JSON.parse(bridge.bodies.at(-1)!);
  const next = ownedVideo(0), other = ownedVideo(1);
  bridge.setVideos([other, next]);
  const { candidates, removed } = JSON.parse(bridge.bodies.at(-1)!);
  expect(removed).toEqual([duplicate.media, otherDuplicate.media]);
  expect(candidates[1].media).toBe(selected.media);
  await bridge.message({ data: { bridge: "piik-page-command", frame, media: selected.media, revision: selected.revision, kind: "patch",
    request: webcrypto.randomUUID(), patch: { position: 12 } } });
  expect(next.currentTime).toBe(12);
  expect(other.currentTime).toBe(0);
});

test.each([0, 1, 2])("one candidate report resolves a detached player's %i same-source replacements", async count => {
  vi.useFakeTimers();
  try {
    const bridge = candidateBridge({ setTimeout, clearTimeout }), first = ownedVideo(0);
    bridge.setVideos([first]);
    vi.advanceTimersByTime(80);
    const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
    bridge.setVideos([]);
    vi.advanceTimersByTime(30);
    const replacements = Array.from({ length: count }, () => ownedVideo(0));
    for (let i = 1; i <= count; i++) bridge.setVideos(replacements.slice(0, i));
    vi.advanceTimersByTime(50);
    const report = JSON.parse(bridge.bodies.at(-1)!);
    expect(report.candidates).toHaveLength(count);
    expect(report.removed).toEqual(count === 1 ? [] : [media]);
    await bridge.message({ data: { bridge: "piik-page-command", frame, media, revision, kind: "patch",
      request: webcrypto.randomUUID(), patch: { position: 12 } } });
    expect(replacements.map(video => video.currentTime)).toEqual(count === 1 ? [12] : replacements.map(() => 0));
    expect(first.currentTime).toBe(0);
  } finally { vi.useRealTimers(); }
});

test.each(["object", "long URL"])("the selected %s keeps a bounded resource token only while its full identity matches", kind => {
  const bridge = candidateBridge();
  const prefix = `https://media.test/?token=${"a".repeat(4096)}`;
  const original = { ...ownedVideo(0), currentSrc: prefix + "one", srcObject: kind === "object" ? {} : null };
  if (kind === "object") original.currentSrc = "https://media.test/previous.mp4";
  const report = () => JSON.parse(bridge.bodies.at(-1)!);
  bridge.setVideos([original]);
  const first = report().candidates[0];
  expect(first.resource).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.url).toBeNull();
  const replacement = { ...original };
  bridge.setVideos([replacement]);
  expect(report()).toMatchObject({ candidates: [first], removed: [] });
  if (kind === "object") replacement.srcObject = {};
  else replacement.currentSrc = prefix + "two";
  bridge.setVideos([replacement]);
  expect(report().candidates[0]).toMatchObject({ media: first.media, url: null });
  expect(report().candidates[0].resource).not.toBe(first.resource);
});

test("unresolved replacement with multiple declared sources cannot inherit the selected player", () => {
  const bridge = candidateBridge(), first = ownedVideo(0);
  bridge.setVideos([first]);
  const { media } = JSON.parse(bridge.bodies.at(-1)!).candidates[0];
  const next = { ...ownedVideo(1), currentSrc: "", querySelectorAll: () => [first.currentSrc, "https://media.test/ad.mp4"]
    .map(src => ({ src, getAttribute: () => src })) };
  bridge.setVideos([next]);
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ removed: [media] });
});

test.each(["URL", "stream"])("a selected empty player reports its first %s in the sample before the candidate update", kind => {
  const bridge = candidateBridge();
  const video = { ...ownedVideo(0), currentSrc: "", srcObject: null as object | null };
  const last = () => JSON.parse(bridge.bodies.at(-1)!);
  bridge.setVideos([video]);
  const { media, resource } = last().candidates[0];
  expect(resource).toBe("");
  if (kind === "URL") video.currentSrc = "https://media.test/movie.mp4";
  else video.srcObject = {};
  video.dispatchEvent(new Event("loadedmetadata"));
  const ready = last().resource;
  expect(ready).toEqual(kind === "URL" ? video.currentSrc : expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(last()).toMatchObject({ kind: "sample", media, event: "loadedmetadata" });
  bridge.flush();
  expect(last()).toMatchObject({ kind: "candidates", candidates: [{ media, resource: ready }], removed: [] });
  if (kind === "URL") video.currentSrc = "https://media.test/next.mp4";
  else video.srcObject = {};
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(last().resource).not.toBe(ready);
});

test("an original-page read reports a detached candidate before the catalog update", async () => {
  const bridge = candidateBridge(), video = ownedVideo(0);
  bridge.setVideos([video]);
  const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
  video.isConnected = false;
  const request = webcrypto.randomUUID();
  await bridge.message({ data: { bridge: "piik-page-command", frame, media, revision, originalPage: true, kind: "read", request } });
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "reply", request, error: "page_candidate_unavailable" });
});

test("changing the selected resource rejects old reads and seeks before the next candidate report", async () => {
  const bridge = candidateBridge(), video = ownedVideo(0);
  bridge.setVideos([video]);
  const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
  video.currentSrc = "https://media.test/replacement.mp4";
  for (const kind of ["read", "patch"]) {
    const request = webcrypto.randomUUID();
    await bridge.message({ data: { bridge: "piik-page-command", frame, media, revision, request, kind, patch: { position: 15 } } });
    expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "reply", request, error: "page_candidate_unavailable" });
  }
  expect(video.currentTime).toBe(0);
});

test("a pending original-page play admits a later pause and seek and reports only the current play failure", async () => {
  const bridge = candidateBridge(), video = ownedVideo(0);
  let rejectPlay!: (error: Error) => void;
  video.play = () => new Promise<void>((_, reject) => { rejectPlay = reject; });
  bridge.setVideos([video]);
  const { frame, candidates: [{ media, revision }] } = JSON.parse(bridge.bodies.at(-1)!);
  const patch = (values: object) => {
    const request = webcrypto.randomUUID();
    void bridge.message({ data: { bridge: "piik-page-command", kind: "patch", frame, media, revision, request, patch: values } });
    expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "reply", request });
  };
  patch({ paused: false });
  patch({ paused: true, position: 15 });
  expect(video).toMatchObject({ paused: true, currentTime: 15 });
  const before = bridge.bodies.length;
  rejectPlay(new DOMException("denied", "NotAllowedError"));
  await Promise.resolve();
  expect(bridge.bodies).toHaveLength(before);
  patch({ paused: false });
  rejectPlay(new DOMException("denied", "NotAllowedError"));
  await Promise.resolve();
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "blocked", media });
  patch({ paused: false });
  rejectPlay(new Error("decode failure"));
  await Promise.resolve();
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ kind: "sample", media, event: "error" });
  patch({ paused: false });
  const previousSource = bridge.bodies.length;
  video.currentSrc = "https://media.test/replacement.mp4";
  rejectPlay(new Error("late failure from the previous source"));
  await Promise.resolve();
  expect(bridge.bodies).toHaveLength(previousSource);
});

test("a new empty element cannot inherit the previous empty player's selection", () => {
  const bridge = candidateBridge(), first = { ...ownedVideo(0), currentSrc: "" };
  bridge.setVideos([first]);
  const { media } = JSON.parse(bridge.bodies.at(-1)!).candidates[0];
  bridge.setVideos([{ ...first }]);
  expect(JSON.parse(bridge.bodies.at(-1)!)).toMatchObject({ removed: [media], candidates: [{ resource: "", media: expect.not.stringMatching(media) }] });
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
    media: child.candidates[0].media, revision: child.candidates[0].revision, kind: "patch", request: webcrypto.randomUUID(), patch: { paused: false, position: 12 } } };
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

test("candidate titles keep a supplementary character at the Native scalar limit", () => {
  const bridge = candidateBridge(), first = ownedVideo(0), next = ownedVideo(1);
  const prefix = "a".repeat(255), face = String.fromCodePoint(0x1f3ac);
  next.title = prefix + face + " episode";
  bridge.setVideos([first, next]);
  const { candidates } = JSON.parse(bridge.bodies.at(-1)!);
  expect(candidates.map((candidate: { title: string }) => candidate.title)).toEqual([first.title, prefix + face]);
});
