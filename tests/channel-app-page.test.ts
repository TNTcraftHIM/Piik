import { afterEach, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceShortcuts } from "../src/client/channel/use-voice-shortcuts";
import { APP_PROTOCOL, ChannelApp, channelAppDiscovery } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { NATIVE_PAGE_METADATA_PREFIX_BYTES, NATIVE_PAGE_READ_BYTES, nativePageStateSchema } from "../src/client/native/wire";
import { AppPageMedia, waitForWatchMedia } from "../src/client/channel/watch-media";
import { AppPage } from "../src/client/channel/app-link";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { observeWatchSources } from "../src/client/channel/watch-page-media";

class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (() => void) | null;
  constructor() { Socket.current = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(result: unknown) { this.receive({ id: this.sent.at(-1)!.id, result }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
afterEach(() => vi.unstubAllGlobals());
async function setup(backgroundVoiceShortcuts = false, receiveVoiceShortcuts = false) {
  vi.stubGlobal("WebSocket", Socket);
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793, pagePlayer: true, backgroundVoiceShortcuts }, "site", "user", "credential", "Me", () => {}, () => {}, undefined, undefined, undefined, () => receiveVoiceShortcuts);
  const socket = Socket.current;
  socket.onopen?.(); socket.reply(null); await app.ready;
  return { app, socket };
}
async function openPage(app: ChannelApp, socket: Socket) {
  const opening = app.preparePage("https://video.test/page", vi.fn(), new AbortController().signal);
  socket.reply({ pageId: socket.sent.at(-1)!.pageId });
  return opening;
}
const state = { position: 12, paused: false, rate: 1, duration: null, readyState: 4, ended: false, buffered: [[0, 60]] as [number, number][] };

test("background voice shortcuts accept small clock differences and discard delayed or far-future events", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793, backgroundVoiceShortcuts: true }, "site", "user", "credential", "Me",
  () => {}, () => {}, undefined, undefined, undefined, () => true);
  const socket = Socket.current;
  socket.onopen?.(); socket.reply(null); await app.ready;
  const listener = vi.fn();
  const unsubscribe = app.backgroundVoiceShortcuts!.subscribe(listener);
  const now = 1_795_326_377_608;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    socket.receive({ type: "voice_shortcut", action: "toggle_microphone", activatedAtMs: now + 1, device: "keyboard" });
    socket.receive({ type: "voice_shortcut", action: "toggle_listening", activatedAtMs: now });
    socket.receive({ type: "voice_shortcut", action: "toggle_microphone", activatedAtMs: now - 1_450 });
    socket.receive({ type: "voice_shortcut", action: "toggle_listening", activatedAtMs: now + 10_000 });
    expect(listener.mock.calls).toEqual([["microphone"], ["listening"]]);
  } finally { clock.mockRestore(); unsubscribe(); app.close(); }
});

test("background voice shortcuts send the App only the toggles it registers", async () => {
  const { app, socket } = await setup(true);
  try {
    const binding = (key: string) => ({ key, ctrl: true, alt: false, shift: true, meta: false });
    const bindings = { microphone: binding("M"), listening: null, talk: binding("V") };
    const configured = app.backgroundVoiceShortcuts!.configure(bindings);
    expect(socket.sent.at(-1)).toEqual({ type: "voice_shortcuts", id: socket.sent.at(-1)!.id, enabled: true, microphone: binding("M"), listening: null });
    socket.reply({ microphone: "registered", listening: "unbound" });
    await configured;
  } finally { app.close(); }
});

test("native voice bindings yield to text and remote input in the focused page or PiP window", async () => {
  const surface = () => {
    const view = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
    const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: view, hasFocus: () => !!doc.activeElement,
      activeElement: null as { nodeType: number; closest(selector: string): boolean } | null });
    return Object.assign(view, { document: doc });
  };
  const page = surface(), panel = surface();
  const pip = Object.assign(new EventTarget(), { window: null as typeof panel | null });
  Object.assign(page, { top: page, isSecureContext: true, documentPictureInPicture: pip });
  vi.stubGlobal("window", page); vi.stubGlobal("document", page.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument: page.document });
  const root = createRoot(container as unknown as HTMLElement);
  const { app, socket } = await setup(true);
  let shortcuts: ReturnType<typeof useVoiceShortcuts>;
  function Dock() { shortcuts = useVoiceShortcuts("room", () => true, app.backgroundVoiceShortcuts); return null; }
  const configured = async (bound: boolean) => {
    const binding = (key: string) => bound ? expect.objectContaining({ key }) : null;
    expect(socket.sent.at(-1)).toMatchObject({ type: "voice_shortcuts", enabled: true, microphone: binding("M"), listening: binding("D") });
    await act(async () => socket.reply({ microphone: bound ? "registered" : "unbound", listening: bound ? "registered" : "unbound" }));
  };
  try {
    await act(async () => root.render(createElement(Dock)));
    await act(async () => shortcuts.background.enable(true));
    await configured(true);
    for (const [view, selector] of [[page, "textarea"], [panel, ".lr-remote-input-surface"]] as const) {
      if (view === panel) { pip.window = panel; await act(async () => pip.dispatchEvent(new Event("enter"))); }
      view.document.activeElement = { nodeType: 1, closest: selectors => selectors.split(", ").includes(selector) };
      await act(async () => view.dispatchEvent(new Event("focus")));
      await configured(false);
      view.document.activeElement = null;
      await act(async () => view.dispatchEvent(new Event("blur")));
      await configured(true);
    }
  } finally { await act(async () => root.unmount()); app.close(); }
});

test("native voice registration owns pending and active chords across dock targets", async () => {
  const surface = () => {
    const view = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
    const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: view, hasFocus: () => !!doc.activeElement,
      activeElement: null as { nodeType: number; closest(selector: string): boolean } | null });
    return Object.assign(view, { document: doc });
  };
  const page = surface(), panel = surface();
  const pip = Object.assign(new EventTarget(), { window: null as typeof panel | null });
  Object.assign(page, { top: page, isSecureContext: true, documentPictureInPicture: pip });
  vi.stubGlobal("window", page); vi.stubGlobal("document", page.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument: page.document });
  const root = createRoot(container as unknown as HTMLElement);
  const { app, socket } = await setup(true, true);
  let shortcuts: ReturnType<typeof useVoiceShortcuts>;
  const toggles = vi.fn();
  function Dock({ room }: { room: string }) {
    shortcuts = useVoiceShortcuts(room, action => { toggles(room, action); return true; }, app.backgroundVoiceShortcuts);
    return null;
  }
  const configured = async (bound: boolean) => {
    const binding = (key: string) => bound ? expect.objectContaining({ key }) : null;
    expect(socket.sent.at(-1)).toMatchObject({ type: "voice_shortcuts", enabled: true, microphone: binding("M"), listening: binding("D") });
    await act(async () => socket.reply({ microphone: bound ? "registered" : "unbound", listening: bound ? "registered" : "unbound" }));
  };
  const keydown = () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key: "M", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, getModifierState: () => false,
    });
    page.document.dispatchEvent(event);
  };
  const native = () => socket.receive({ type: "voice_shortcut", action: "toggle_microphone", activatedAtMs: Date.now() });
  try {
    await act(async () => root.render(createElement(Dock, { room: "first" })));
    await act(async () => shortcuts.background.enable(true));
    keydown();
    await configured(true);
    native();
    keydown();
    expect(toggles.mock.calls).toEqual([["first", "microphone"]]);

    await act(async () => root.render(createElement(Dock, { room: "second" })));
    keydown();
    native();
    await configured(true);
    native();
    keydown();
    expect(toggles.mock.calls).toEqual([["first", "microphone"], ["second", "microphone"]]);

    page.document.activeElement = { nodeType: 1, closest: selectors => selectors.includes("input") };
    await act(async () => page.dispatchEvent(new Event("focus")));
    native();
    expect(toggles).toHaveBeenCalledTimes(2);
    await configured(false);
    page.document.activeElement = null;
    await act(async () => page.dispatchEvent(new Event("blur")));
    await act(async () => socket.reply({ microphone: "unavailable", listening: "registered" }));
    keydown();
    native();
    expect(toggles.mock.calls.at(-1)).toEqual(["second", "microphone"]);
    expect(toggles).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); app.close(); }
});

test("page readiness rechecks events delivered before an older read reply", async () => {
  vi.useFakeTimers();
  const { app, socket } = await setup(), cancel = new AbortController();
  let ready: Promise<void> | undefined;
  try {
    const page = await openPage(app, socket);
    const candidateId = crypto.randomUUID();
    socket.receive({ type: "page_candidates", pageId: page.id, url: page.url, candidates: [{ id: candidateId, pageURL: page.url, title: "Video", url: null, duration: 60 }] });
    const selecting = page.select(candidateId); socket.reply({ ...state, readyState: 0 }); await selecting;
    ready = waitForWatchMedia(page, cancel.signal);
    void ready.catch(() => {});
    let settled = false;
    void ready.then(() => { settled = true; }, () => { settled = true; });
    const oldRead = socket.sent.at(-1)!;
    expect(oldRead.type).toBe("page_read");
    // Native can drain later samples before sending an already-captured read snapshot.
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "loadeddata" });
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "playing" });
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(1);
    socket.receive({ id: oldRead.id, result: { ...state, readyState: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(2);
    expect(settled).toBe(false);
    socket.reply({ ...state, readyState: 1 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(2);
    expect(settled).toBe(false);
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "loadeddata" });
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(3);
    socket.reply(state);
    await ready;
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "playing" });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(3);
    expect(app.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { cancel.abort(); await ready?.catch(() => {}); app.close(); vi.useRealTimers(); }
});

test.each(["abort", "close", "read error", "media error"] as const)("page readiness %s discards an event queued during a read", async outcome => {
  vi.useFakeTimers();
  const { app, socket } = await setup(), cancel = new AbortController();
  try {
    const page = await openPage(app, socket), candidateId = crypto.randomUUID();
    socket.receive({ type: "page_candidates", pageId: page.id, url: page.url, candidates: [{ id: candidateId, pageURL: page.url, title: "Video", url: null, duration: 60 }] });
    const selecting = page.select(candidateId); socket.reply({ ...state, readyState: 0 }); await selecting;
    const ready = waitForWatchMedia(page, cancel.signal);
    const rejected = outcome === "abort" ? expect(ready).rejects.toMatchObject({ name: "AbortError" })
      : expect(ready).rejects.toThrow(outcome === "read error" ? "page_player_timeout" : "watch_media_failed");
    const oldRead = socket.sent.at(-1)!;
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "loadeddata" });
    if (outcome === "abort") cancel.abort();
    else if (outcome === "close") {
      socket.receive({ type: "page_closed", pageId: page.id });
      socket.reply(null);
    } else if (outcome === "read error") socket.receive({ id: oldRead.id, error: "page_player_timeout" });
    else socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "error" });
    // A ready result cannot override cancellation, closure or an observed failure.
    socket.receive({ id: oldRead.id, result: state });
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter(value => value.type === "page_read")).toHaveLength(1);
    expect(app.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { app.close(); vi.useRealTimers(); }
});

function mpdCatalog() {
  return { sourceId: crypto.randomUUID(), tracks: [
    { id: crypto.randomUUID(), kind: "video", label: "1080p", mimeType: "video/mp4", codec: "avc1.640028",
      language: "", role: "", width: 1920, height: 1080, bandwidth: 4000000, frameRate: 30 },
    { id: crypto.randomUUID(), kind: "audio", label: "Audio", mimeType: "audio/mp4", codec: "mp4a.40.2",
      language: "en", role: "main", width: null, height: null, bandwidth: 128000, frameRate: null },
  ] };
}

test("MPD inspection retains long display labels and propagates catalog-limit errors", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), choiceId = crypto.randomUUID(), catalog = mpdCatalog();
    catalog.tracks[0]!.label = "v".repeat(513);
    const inspecting = page.inspectMpd(choiceId, new AbortController().signal);
    socket.reply(catalog);
    await expect(inspecting).resolves.toEqual(catalog);
    const selection = { sourceId: catalog.sourceId, videoId: catalog.tracks[0]!.id, audioId: catalog.tracks[1]!.id };
    const preparing = page.prepareMedia(selection, new AbortController().signal);
    expect(socket.sent.at(-1)).toEqual({ type: "page_media_prepare_mpd", pageId: page.id, ...selection, id: expect.any(String) });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "dash" };
    socket.reply(source);
    await expect(preparing).resolves.toEqual(source);
    const oversized = page.inspectMpd(choiceId, new AbortController().signal);
    socket.receive({ id: socket.sent.at(-1)!.id, error: "watch_resource_limit" });
    await expect(oversized).rejects.toThrow("watch_resource_limit");
    const reading = page.read(); socket.reply(state); await expect(reading).resolves.toEqual(state);
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});

test("MPD inspection cancellation and source replacement retain opaque catalog identity", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), choiceId = crypto.randomUUID(), cancel = new AbortController();
    const inspecting = page.inspectMpd(choiceId, cancel.signal), old = socket.sent.at(-1)!;
    expect(old).toMatchObject({ type: "page_media_resource", action: "inspect_mpd", pageId: page.id, choiceId, readId: expect.any(String) });
    const cancelled = expect(inspecting).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort(); await cancelled;
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_media_resource", action: "cancel", pageId: page.id, readId: old.readId });
    socket.reply(null);
    socket.receive({ id: old.id, result: mpdCatalog() });
    const fresh = mpdCatalog(), reading = page.inspectMpd(choiceId, new AbortController().signal);
    socket.reply(fresh); await expect(reading).resolves.toEqual(fresh);
    const selection = { sourceId: fresh.sourceId, videoId: fresh.tracks[0].id, audioId: fresh.tracks[1].id };
    const stale = page.prepareMedia(selection, new AbortController().signal);
    socket.receive({ id: socket.sent.at(-1)!.id, error: "watch_source_changed" });
    await expect(stale).rejects.toThrow("watch_source_changed");
    expect(socket.sent.some(value => value.type === "page_media_stop" || value.type === "page_close")).toBe(false);
    const next = mpdCatalog(), nextInspect = page.inspectMpd(choiceId, new AbortController().signal);
    socket.reply(next); await nextInspect;
    const prepare = page.prepareMedia({ sourceId: next.sourceId,
      videoId: next.tracks[0].id }, new AbortController().signal);
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_media_prepare_mpd", pageId: page.id, sourceId: next.sourceId });
    expect(socket.sent.at(-1)).not.toHaveProperty("url");
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "dash" };
    socket.reply(source); await expect(prepare).resolves.toEqual(source);
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});

test("MPD prepare cancellation uses selection stop while closing one page preserves sibling inspection", async () => {
  const { app, socket } = await setup();
  try {
    const a = await openPage(app, socket), b = await openPage(app, socket), catalog = mpdCatalog();
    const selection = { sourceId: catalog.sourceId, videoId: catalog.tracks[0].id };
    const cancel = new AbortController(), preparing = a.prepareMedia(selection, cancel.signal), request = socket.sent.at(-1)!;
    const rejected = expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort(); await rejected;
    const stopping = a.stopMedia(); socket.reply(null); await stopping;
    socket.receive({ id: request.id, result: { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "dash" } });
    const pendingA = a.inspectMpd(crypto.randomUUID(), new AbortController().signal), lateA = socket.sent.at(-1)!;
    const endedA = expect(pendingA).rejects.toThrow("watch_page_closed");
    const pendingB = b.inspectMpd(crypto.randomUUID(), new AbortController().signal), replyB = socket.sent.at(-1)!;
    a.close(); await endedA; socket.reply(null);
    socket.receive({ id: lateA.id, result: catalog });
    socket.receive({ id: replyB.id, result: catalog }); await expect(pendingB).resolves.toEqual(catalog);
    expect(app.connected).toBe(true);
    expect(socket.sent.filter(value => value.type === "page_close").map(value => value.pageId)).toEqual([a.id]);
    const wrongFormat = b.prepareMedia(selection, new AbortController().signal);
    socket.reply({ sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" });
    await expect(wrongFormat).rejects.toThrow();
    const reading = b.read(); socket.reply(state); await expect(reading).resolves.toEqual(state);
  } finally { app.close(); }
});

test("MPD replies discard extra fields and reject unknown track kinds without retiring control", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), candidate = { id: crypto.randomUUID(), name: "Manifest", hostname: "media.test" };
    const listing = page.mediaSources();
    socket.reply({ choices: [], indexedCandidates: [], mpdCandidates: [candidate], byteSource: null });
    expect((await listing).mpdCandidates).toEqual([candidate]);
    const missing = page.mediaSources(); socket.reply({ choices: [], indexedCandidates: [], byteSource: null });
    await expect(missing).rejects.toThrow();
    const catalog = mpdCatalog(), inspecting = page.inspectMpd(candidate.id, new AbortController().signal);
    socket.reply({ ...catalog, url: "https://media.test/private?grant=fixture", tracks: catalog.tracks.map(track => ({ ...track, colorSpace: "bt709" })) });
    await expect(inspecting).resolves.toEqual(catalog);
    const unknown = page.inspectMpd(candidate.id, new AbortController().signal);
    socket.reply({ ...catalog, tracks: [{ ...catalog.tracks[0], kind: "unknown" }] });
    await expect(unknown).rejects.toThrow();
    const before = socket.sent.length;
    await expect(page.prepareMedia({ sourceId: catalog.sourceId, videoId: "not-an-opaque-id" }, new AbortController().signal)).rejects.toThrow();
    expect(socket.sent).toHaveLength(before);
    const playback = page.read(); socket.reply(state); await expect(playback).resolves.toEqual(state);
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});

test('local resource playback uses the prepared root and cancels only its opaque read', async () => {
  const {app,socket}=await setup();
  try{
    const page=await openPage(app,socket),sourceId=crypto.randomUUID(),resourceId=crypto.randomUUID();
    const pending=page.readMediaResource(sourceId,resourceId,2*1024*1024,4,new AbortController().signal);
    expect(socket.sent.at(-1)).toMatchObject({type:'page_media_resource',action:'read',pageId:page.id,sourceId,resourceId,offset:2*1024*1024,length:4});
    socket.reply({bytesBase64:btoa('data'),mimeType:'video/mp4',totalSize:3*1024*1024,eof:false});
    expect((await pending).bytes).toEqual(new TextEncoder().encode('data'));
    const abort=new AbortController(),reading=page.readMediaResource(sourceId,resourceId,0,4,abort.signal);
    const request=socket.sent.at(-1)!;const rejected=expect(reading).rejects.toMatchObject({name:'AbortError'});abort.abort();await rejected;
    expect(socket.sent.at(-1)).toMatchObject({type:'page_media_resource',action:'cancel',pageId:page.id,readId:request.readId});socket.reply(null);
    socket.receive({id:request.id,result:{bytesBase64:btoa('late'),mimeType:'video/mp4',totalSize:4,eof:true}});
    await expect(page.readMediaResource(sourceId,resourceId,0,65537,new AbortController().signal)).rejects.toThrow();
  }finally{app.close();}
});

test("source invalidation has its own listener lifetime and never becomes a playback event", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const changed = vi.fn(), playback = vi.fn(), afterClose = vi.fn();
    const unlisten = page.listenMediaSources(changed);
    page.listen(playback);
    socket.receive({ type: "page_media_changed", pageId: page.id });
    expect(changed).toHaveBeenCalledOnce();
    expect(playback).not.toHaveBeenCalled();
    unlisten();
    socket.receive({ type: "page_media_changed", pageId: page.id });
    expect(changed).toHaveBeenCalledOnce();
    page.listenMediaSources(afterClose);
    page.close();
    page.receive({ type: "page_media_changed", pageId: page.id });
    expect(afterClose).not.toHaveBeenCalled();
  } finally { app.close(); }
});
test("App playback samples require actual valid buffered ranges", () => {
  expect(nativePageStateSchema.parse({ ...state, buffered: [[0, 11], [13, 15]] }).buffered).toEqual([[0, 11], [13, 15]]);
  const { buffered: _buffered, ...obsolete } = state;
  expect(nativePageStateSchema.safeParse(obsolete).success).toBe(false);
  expect(nativePageStateSchema.safeParse({ ...state, buffered: [[15, 13]] }).success).toBe(false);
});
test.each(["caller", "unsubscribe"])("%s cancellation stops source enumeration without retiring playback", async retirement => {
  const { app, socket } = await setup();
  const page = await openPage(app, socket), media = new AppPageMedia(page);
  await media.opening;
  const reading = media.read();
  await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "page_read", pageId: page.id }));
  const readRequest = socket.sent.at(-1)!;
  const lifetime = new AbortController(), publish = vi.fn();
  const observer = observeWatchSources(page, lifetime.signal, publish);
  const old = socket.sent.at(-1)!;
  let failure: unknown;
  const result = observer.ready.catch(error => { failure = error; });
  let fresh: ReturnType<typeof observeWatchSources> | undefined;
  try {
    expect(old).toMatchObject({ type: "page_media_sources", pageId: page.id });
    if (retirement === "caller") lifetime.abort(); else observer.unsubscribe();
    await vi.waitFor(() => expect(failure).toMatchObject({ name: "AbortError" }), { timeout: 200 });
    expect(app.connected).toBe(true);
    expect(socket.sent.some(command => command.type === "page_close" || command.type === "page_media_stop")).toBe(false);
    socket.receive({ id: old.id, result: { choices: [], indexedCandidates: [], mpdCandidates: [], byteSource: null } });
    expect(publish).not.toHaveBeenCalled();
    socket.receive({ id: readRequest.id, result: state });
    await expect(reading).resolves.toEqual(state);
    const seek = media.patch({ position: 20 });
    await vi.waitFor(() => expect(socket.sent.at(-1)).toMatchObject({ type: "page_patch", pageId: page.id, patch: { position: 20 } }));
    socket.reply(null); await seek;
    fresh = observeWatchSources(page, new AbortController().signal, publish);
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_media_sources", pageId: page.id });
    socket.reply({ choices: [], indexedCandidates: [], mpdCandidates: [], byteSource: null });
    await fresh.ready;
    expect(publish).toHaveBeenCalledOnce();
    expect(media.page).toBe(page);
    expect(app.connected).toBe(true);
  } finally {
    observer.unsubscribe(); fresh?.unsubscribe(); media.close(); app.close();
    await result; await reading.catch(() => {});
  }
});

test("App webpage selection closes pending reads on an extended window-close notification", async () => {
  const { app, socket } = await setup();
  try {
    const preparing = app.preparePage("https://video.test/page", vi.fn(), new AbortController().signal);
    const pageId = socket.sent.at(-1)!.pageId as string;
    socket.reply({ pageId });
    const page = await preparing;
    const candidateId = crypto.randomUUID();
    socket.receive({ type: "page_candidates", pageId, url: "https://video.test/page", candidates: [{ pageURL: "https://video.test/page", id: candidateId, title: "Episode", url: null, duration: null }] });
    expect(page.candidates).toHaveLength(1);
    const selecting = page.select(candidateId); socket.reply(state); await selecting;
    const reading = page.read();
    const rejected = expect(reading).rejects.toThrow("watch_page_closed");
    const events: string[] = []; page.listen(event => events.push(event));
    const capacity = app.relayCapacity();
    const result = { sessionId: crypto.randomUUID(), relayOverride: 2 };
    const confirmed = expect(capacity).resolves.toEqual(result);
    const capacityId = socket.sent.at(-1)!.id;
    socket.receive({ type: "page_closed", pageId, reason: "window_closed" });
    await rejected;
    expect(events).toEqual(["closed"]);
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_close", pageId });
    socket.reply(null);
    socket.receive({ id: capacityId, result });
    await confirmed;
    expect((app as unknown as { requests: Map<string, unknown> }).requests.size).toBe(0);
  } finally { app.close(); }
});
test.each(["page_future_event", "future_event"])("unknown App notification %s leaves page listeners and correlated reads active", async type => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const candidateId = crypto.randomUUID();
    socket.receive({ type: "page_candidates", pageId: page.id, url: page.url,
      candidates: [{ id: candidateId, pageURL: page.url, title: "Episode", url: null, duration: 60 }] });
    const selecting = page.select(candidateId); socket.reply(state); await selecting;
    const listen = vi.fn();
    page.listen(listen, candidateId);
    const reading = expect(page.read()).resolves.toEqual(state);
    const id = socket.sent.at(-1)!.id;
    socket.receive({ type, id, result: { ...state, position: 25 }, pageId: page.id, candidateId });
    for (const event of ["canplay", "closed", "blocked", "visibility-resumed"])
      socket.receive({ type: "page_sample", pageId: page.id, candidateId, event });
    socket.receive({ type: "page_sample", pageId: page.id, candidateId, event: "playing", origin: "player" });
    socket.reply(state);
    await reading;
    expect(listen.mock.calls).toEqual([["playing"]]);
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});
test("page candidate descriptions can grow during another App request", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const candidate = { id: crypto.randomUUID(), pageURL: null, title: "Episode", url: null, duration: 60 };
    const capacity = app.relayCapacity();
    socket.receive({ type: "page_candidates", pageId: page.id, url: "https://video.test/page",
      title: "Upcoming episodes", candidates: [{ ...candidate, language: "en" }] });
    const result = { sessionId: crypto.randomUUID(), relayOverride: 2 };
    socket.reply(result);
    await expect(capacity).resolves.toEqual(result);
    expect(page.candidates).toEqual([candidate]);
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});
test.each([undefined, -1])("invalid required candidate duration (%s) retires the App connection", async duration => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const rejected = expect(app.relayCapacity()).rejects.toThrow("app_disconnected");
    socket.receive({ type: "page_candidates", pageId: page.id, url: "https://video.test/page",
      candidates: [{ pageURL: "https://video.test/page", id: crypto.randomUUID(), title: "Episode", url: null, duration }] });
    await rejected;
    expect(app.connected).toBe(false);
    expect(socket.readyState).toBe(3);
  } finally { app.close(); }
});
test("cancelling prepare retires the page and ignores its late confirmation", async () => {
  const { app, socket } = await setup();
  try {
    const cancel = new AbortController();
    const preparing = app.preparePage("https://video.test/page", vi.fn(), cancel.signal);
    const command = socket.sent.at(-1)!;
    const rejected = expect(preparing).rejects.toThrow("watch_page_closed");
    cancel.abort(); await rejected;
    socket.receive({ id: command.id, result: { pageId: command.pageId } });
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_close", pageId: command.pageId });
    socket.reply(null);
    expect((app as unknown as { requests: Map<string, unknown> }).requests.size).toBe(0);
  } finally { app.close(); }
});

test.each(['file', 'hls'] as const)('%s byte source registration retains the page and stop retires only its reader', async format => {
  const { app, socket } = await setup();
  try {
    const opening = app.preparePage('https://video.test/page', vi.fn(), new AbortController().signal);
    const pageId = socket.sent.at(-1)!.pageId as string; socket.reply({ pageId });
    const page = await opening;
    const choiceId = crypto.randomUUID();
    const choices = page.mediaSources();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_sources', pageId });
    socket.reply({ choices: [{ id: choiceId, displayURL: 'https://media.test/movie.m3u8', name: 'Movie', format }], indexedCandidates: [], mpdCandidates: [], byteSource: null });
    expect((await choices).choices[0]?.format).toBe(format);
    const preparing = page.prepareMedia(choiceId, new AbortController().signal);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_prepare', pageId, choiceId });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format };
    socket.reply(source); await expect(preparing).resolves.toEqual(source);
    const stopping = page.stopMedia();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_stop', pageId });
    socket.reply(null); await stopping;
    const reading = page.read(); socket.reply(state);
    await expect(reading).resolves.toEqual(state);
    expect(socket.sent.some(command => command.type === 'page_close')).toBe(false);
  } finally { app.close(); }
});

test("App 13 keeps indexed resource candidates separate from direct media choices", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const candidate = { id: crypto.randomUUID(), name: "Observed track", hostname: "media.test", mimeType: "video/mp4", totalSize: 1000000 };
    const direct = { id: crypto.randomUUID(), displayURL: "https://media.test/movie.m3u8", name: "Movie", format: "hls" };
    const sources = page.mediaSources();
    socket.reply({ choices: [direct], indexedCandidates: [candidate], mpdCandidates: [], byteSource: null });
    await expect(sources).resolves.toEqual({ choices: [direct], indexedCandidates: [candidate], mpdCandidates: [], byteSource: null });
    const missingHost = page.mediaSources();
    const { hostname: _hostname, ...oldCandidate } = candidate;
    socket.reply({ choices: [], indexedCandidates: [oldCandidate], mpdCandidates: [], byteSource: null });
    await expect(missingHost).rejects.toThrow();
    const privateHost = page.mediaSources();
    socket.reply({ choices: [], indexedCandidates: [{ ...candidate, hostname: "media.test?private=grant" }], mpdCandidates: [], byteSource: null });
    await expect(privateHost).rejects.toThrow();
    const obsolete = page.mediaSources();
    socket.reply({ choices: [direct], byteSource: null });
    await expect(obsolete).rejects.toThrow();
    const extended = page.mediaSources();
    const byteSource = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" };
    socket.reply({ choices: [{ ...direct, label: "video" }], indexedCandidates: [{ ...candidate, url: "https://media.test/private-track" }],
      mpdCandidates: [], byteSource: { ...byteSource, label: "audio" }, discoveredAt: 1 });
    await expect(extended).resolves.toEqual({ choices: [direct], indexedCandidates: [candidate], mpdCandidates: [], byteSource });
  } finally { app.close(); }
});

test("selected-page metadata reads use opaque IDs and enforce both byte-window bounds before sending", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), choiceId = crypto.randomUUID(), signal = new AbortController().signal;
    const offset = NATIVE_PAGE_METADATA_PREFIX_BYTES - 3;
    const reading = page.readMediaMetadata(choiceId, offset, 3, signal);
    expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), type: "page_media_resource", action: "read_metadata", readId: expect.any(String), pageId: page.id, choiceId, offset, length: 3 });
    socket.reply({ mimeType: "video/mp4", totalSize: 2000000, bytesBase64: "AP8q" });
    await expect(reading).resolves.toEqual({ mimeType: "video/mp4", totalSize: 2000000, bytes: Uint8Array.of(0, 255, 42) });
    const sent = socket.sent.length;
    await expect(page.readMediaMetadata(choiceId, 0, NATIVE_PAGE_READ_BYTES + 1, signal)).rejects.toThrow();
    await expect(page.readMediaMetadata(choiceId, NATIVE_PAGE_METADATA_PREFIX_BYTES - 1, 2, signal)).rejects.toThrow();
    expect(socket.sent).toHaveLength(sent);
  } finally { app.close(); }
});

test("metadata response validation catches oversized decoded bytes and malformed or truncated replies", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), choiceId = crypto.randomUUID(), signal = new AbortController().signal;
    // 65536 and 65537 bytes have the same padded Base64 string length: decoded size needs checking.
    const oversized = page.readMediaMetadata(choiceId, 0, NATIVE_PAGE_READ_BYTES, signal);
    socket.reply({ mimeType: "video/mp4", totalSize: 1000000, bytesBase64: btoa("x".repeat(NATIVE_PAGE_READ_BYTES + 1)) });
    await expect(oversized).rejects.toThrow("invalid_app_response");
    const malformed = page.readMediaMetadata(choiceId, 0, 3, signal);
    socket.reply({ mimeType: "video/mp4", totalSize: 1000000, bytesBase64: "A===" });
    await expect(malformed).rejects.toThrow();
    const truncated = page.readMediaMetadata(choiceId, 0, 3, signal);
    socket.reply({ mimeType: "video/mp4", totalSize: 1000000, bytesBase64: "AA==" });
    await expect(truncated).rejects.toThrow("invalid_app_response");
    const playback = page.read(); socket.reply(state);
    await expect(playback).resolves.toEqual(state);
  } finally { app.close(); }
});

test.each(["caller", "page"] as const)("%s retirement cancels metadata reads and discards their late replies", async owner => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), cancel = new AbortController();
    const reading = page.readMediaMetadata(crypto.randomUUID(), 0, 3, cancel.signal);
    const command = socket.sent.at(-1)!;
    const rejected = owner === "caller" ? expect(reading).rejects.toMatchObject({ name: "AbortError" })
      : expect(reading).rejects.toThrow("watch_page_closed");
    if (owner === "caller") cancel.abort(); else page.close();
    await rejected;
    socket.receive({ id: command.id, result: { mimeType: "video/mp4", totalSize: 1000000, bytesBase64: "AP8q" } });
    if (owner === "caller") {
      expect(socket.sent.at(-1)).toMatchObject({ type: "page_media_resource", action: "cancel", pageId: page.id, readId: command.readId });
      socket.reply(null);
      expect(socket.sent.some(value => value.type === "page_close")).toBe(false);
      const playback = page.read(); socket.reply(state);
      await expect(playback).resolves.toEqual(state);
    } else socket.reply(null);
    expect((app as unknown as { requests: Map<string, unknown> }).requests.size).toBe(0);
  } finally { app.close(); }
});

test("indexed preparation keeps the page owner and returns only an HLS byte source", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), signal = new AbortController().signal;
    const video = { choiceId: crypto.randomUUID(), totalSize: 1000, codec: "av01.0.08M.08", timescale: 16000,
      mediaOffset: 100, initBase64: "AAAA", segments: [[900, 80000] as [number, number]] };
    const preparing = page.prepareMedia({ video }, signal);
    expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), type: "page_media_prepare_indexed", pageId: page.id, video });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" };
    socket.reply(source); await expect(preparing).resolves.toEqual(source);
    const invalid = page.prepareMedia({ video }, signal);
    socket.reply({ ...source, format: "file" }); await expect(invalid).rejects.toThrow();
    const playback = page.read(); socket.reply(state); await expect(playback).resolves.toEqual(state);
  } finally { app.close(); }
});

test("indexed preparation measures the whole App request before sending and discards late cancelled replies", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), signal = new AbortController().signal;
    const video = { choiceId: crypto.randomUUID(), totalSize: 1000, codec: "av01.0.08M.08", timescale: 16000,
      mediaOffset: 100, initBase64: btoa("x".repeat(100000)), segments: [[900, 80000] as [number, number]] };
    const audio = { ...video, choiceId: crypto.randomUUID(), codec: "mp4a.40.2" }, sent = socket.sent.length;
    await expect(page.prepareMedia({ video, audio }, signal)).rejects.toThrow("watch_resource_limit");
    expect(socket.sent).toHaveLength(sent);
    const cancel = new AbortController();
    const preparing = page.prepareMedia({ video: { ...video, initBase64: "AAAA" } }, cancel.signal);
    const command = socket.sent.at(-1)!, rejected = expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort(); await rejected;
    socket.receive({ id: command.id, result: { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" } });
    // Native cleanup remains the explicit page operation owned by the cancelling selection.
    const stopped = page.stopMedia(); socket.reply(null); await stopped;
    const playback = page.read(); socket.reply(state); await expect(playback).resolves.toEqual(state);
    expect(socket.sent.some(value => value.type === "page_close")).toBe(false);
  } finally { app.close(); }
});


test("hiding and refocusing a source page preserves its requests and lifetime", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const hide = page.hide();
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_hide", pageId: page.id });
    socket.reply(null); await hide;
    expect(socket.sent.some(command => command.type === "page_close")).toBe(false);
    const reading = page.read(); socket.reply(state); expect(await reading).toEqual(state);
    const focus = page.focus();
    expect(socket.sent.at(-1)).toMatchObject({ type: "page_focus", pageId: page.id });
    socket.reply(null); await focus;
    page.close(); expect(socket.sent.at(-1)).toMatchObject({ type: "page_close", pageId: page.id });
  } finally { app.close(); }
});


test("opening a Native room confirms the reserved room summary", async () => {
  const { app, socket } = await setup();
  const settings = { id: "room", icon: "couch", name: "Room", access: "private", hidden: false } as const;
  const room = { ...settings, creatorId: "user", hasPassword: false, voiceBitrate: 64000, relayCapacity: 1 };
  try {
    const opened = { type: "opened", room };
    for (const result of [room, { type: "opened", room: { id: room.id } },
      { type: "opened", room: { ...room, id: "other" } }, opened]) {
      const opening = app.open(settings);
      await Promise.resolve();
      socket.reply(result);
      if (result === opened) await expect(opening).resolves.toEqual(room);
      else await expect(opening).rejects.toThrow("invalid_app_response");
    }
  } finally { app.close(); }
});

test.each(["incompatible_protocol", "admission failed: incompatible_protocol"])("Native hello rejection %s retires App control and preserves upgrade guidance", async error => {
  vi.stubGlobal("WebSocket", Socket);
  const closed = vi.fn();
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", closed, () => {});
  Socket.current.onopen?.();
  Socket.current.receive({ id: Socket.current.sent[0].id, error });
  await expect(app.ready.catch(channelAppDiscovery.isIncompatible)).resolves.toBe(true);
  expect(closed).toHaveBeenCalledOnce();
  expect(app.connected).toBe(false);
  expect(Socket.current.readyState).toBe(3);
});

test.each([
  { name: "no outcome", reply: {} },
  { name: "both outcomes", reply: { result: null, error: "app_failed" } },
  { name: "non-null acknowledgement", reply: { result: { type: "deferred" } } },
  { name: "empty error", reply: { error: "" } },
  { name: "non-string error", reply: { error: 42 } },
])("a correlated App reply with $name rejects only its request", async ({ reply }) => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const focus = page.focus();
    const id = socket.sent.at(-1)!.id;
    const reading = page.read();
    socket.receive({ id, ...reply });
    socket.reply(state);
    await Promise.all([
      expect(focus).rejects.toThrow("invalid_app_response"),
      expect(reading).resolves.toEqual(state),
    ]);

    expect(app.connected).toBe(true);
    const retry = page.focus();
    socket.reply(null);
    await expect(retry).resolves.toBeUndefined();
  } finally { app.close(); }
});

test.each([0, null])("an invalid App message type %s cannot confirm a valid read result", async type => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const reading = expect(page.read()).rejects.toThrow("watch_page_closed");
    socket.receive({ type, id: socket.sent.at(-1)!.id, result: state });
    await reading;
    expect(app.connected).toBe(false);
    expect(socket.readyState).toBe(3);
  } finally { app.close(); }
});

test.each([
  { name: "no outcome", reply: {} },
  { name: "a non-null result", reply: { result: {} } },
])("hello with $name leaves App control disconnected", async ({ reply }) => {
  vi.stubGlobal("WebSocket", Socket);
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", () => {}, () => {});
  Socket.current.onopen?.();
  Socket.current.receive({ id: Socket.current.sent[0].id, ...reply });
  await expect(app.ready).rejects.toThrow("invalid_app_response");
  expect(app.connected).toBe(false);
  expect(Socket.current.readyState).toBe(3);
});

test("socket close and its pending hello rejection retire the App link once", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const closed = vi.fn();
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", closed, () => {});
  const failed = expect(app.ready).rejects.toThrow("app_disconnected");
  Socket.current.onopen?.();
  Socket.current.close();
  await failed;
  expect(closed).toHaveBeenCalledOnce();
});

test("cancelling the only pending readiness caller retires admission but preserves ready control", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const closed = vi.fn();
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", closed, () => {});
  const attempt = new AbortController();
  const cancelled = expect(app.waitReady(attempt.signal)).rejects.toMatchObject({ name: "AbortError" });
  Socket.current.onopen?.();
  attempt.abort();
  await cancelled;
  expect(Socket.current.readyState).toBe(3);
  expect(closed).toHaveBeenCalledOnce();

  const { app: ready } = await setup();
  const readyAttempt = new AbortController();
  try {
    await ready.waitReady(readyAttempt.signal);
    readyAttempt.abort();
    expect(ready.connected).toBe(true);
  } finally { ready.close(); }
});

test('original-page selection retirement keeps the App and a newer pending candidate alive', async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), first = crypto.randomUUID(), next = crypto.randomUUID();
    socket.receive({ type: 'page_candidates', pageId: page.id, url: page.url, candidates: [first, next].map(id => ({ pageURL: page.url, id, title: 'Video', url: null, duration: 60 })) });
    const selecting = page.select(first, true); socket.reply(state); await selecting;
    const current = new AppPageMedia(page), candidate = new AppPageMedia(page, next, page.hold());
    await Promise.all([current.opening, candidate.opening]);
    const currentEvents = vi.fn(), nextEvents = vi.fn(); current.listen(currentEvents); candidate.listen(nextEvents);
    socket.receive({ type: 'page_selection_lost', pageId: page.id, candidateId: first });
    expect(page.selectedCandidateId).toBeUndefined();
    expect(currentEvents).toHaveBeenCalledExactlyOnceWith('source-unavailable');
    expect(nextEvents).not.toHaveBeenCalled();
    expect(app.connected).toBe(true);
    expect(socket.sent.some(command => command.type === 'page_close')).toBe(false);
    const switching = page.select(next, true); socket.reply(state); await switching;
    socket.receive({ type: 'page_selection_lost', pageId: page.id, candidateId: first });
    expect(page.selectedCandidateId).toBe(next);
    expect(nextEvents).not.toHaveBeenCalled();
    candidate.close(); current.close();
  } finally { app.close(); }
});

test('selection loss before a queued selection reply cannot restore the retired candidate', async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), candidateId = crypto.randomUUID();
    socket.receive({ type: 'page_candidates', pageId: page.id, url: page.url, candidates: [{ pageURL: page.url, id: candidateId, title: 'Video', url: null, duration: 60 }] });
    const selecting = page.select(candidateId, true);
    const rejected = expect(selecting).rejects.toThrow('watch_source_unavailable');
    const reply = socket.sent.at(-1)!;
    socket.receive({ type: 'page_selection_lost', pageId: page.id, candidateId });
    socket.receive({ id: reply.id, result: state });
    await rejected;
    expect(page.selectedCandidateId).toBeUndefined();
    expect(app.connected).toBe(true);
    expect(socket.sent.some(command => command.type === 'page_close')).toBe(false);
  } finally { app.close(); }
});

test.each(['ready', 'loading', 'removed'] as const)('prepared page candidate owns only its own media events (%s)', async phase => {
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const states = { a: { ...state, duration: 60, readyState: 4 }, b: { ...state, duration: 60, readyState: phase === 'ready' ? 4 : 1 } };
  const page = new AppPage(crypto.randomUUID(), 'https://video.test/a', async command => command.candidateId === b ? states.b : states.a, vi.fn(), vi.fn());
  const candidates = [{ id: a, pageURL: page.url, title: 'A', url: null, duration: 60 },
    { id: b, pageURL: 'https://video.test/b', title: 'B', url: null, duration: 60 }];
  page.receive({ type: 'page_candidates', pageId: page.id, url: page.url, candidates });
  await page.select(a, true);
  const incumbent = new AppPageMedia(page), incumbentEvents = vi.fn();
  incumbent.listen(incumbentEvents);
  const media = new AppPageMedia(page, b, page.hold());
  const player = new WatchPlayer('room', true, media, vi.fn()), published = vi.fn(async (_value: unknown) => {});
  try {
    await Promise.all([incumbent.opening, media.opening]);
    page.receive({ type: 'page_sample', pageId: page.id, candidateId: a, event: 'waiting' });
    page.receive({ type: 'page_blocked', pageId: page.id, candidateId: a });
    expect(incumbentEvents.mock.calls.map(([event]) => event)).toEqual(['waiting', 'blocked']);
    expect(player.blocked).toBe(false);
    let settled = false;
    const ready = player.ready().then(() => { settled = true; });
    if (phase === 'removed') {
      const rejected = expect(ready).rejects.toThrow('watch_source_unavailable');
      page.receive({ type: 'page_candidates', pageId: page.id, url: page.url, candidates: [candidates[0]] });
      await rejected;
      expect(page.selectedCandidateId).toBe(a);
      expect(incumbentEvents).toHaveBeenCalledTimes(2);
      return;
    }
    if (phase === 'loading') {
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      states.b.readyState = 4;
      page.receive({ type: 'page_sample', pageId: page.id, candidateId: b, event: 'loadeddata' });
    }
    await ready;
    player.calibrate(performance.now(), performance.now());
    await page.select(b, true);
    player.activate(published);
    await player.publish(true);
    expect(published.mock.lastCall?.[0]).toMatchObject({ paused: false, position: state.position });
    const receivedA = incumbentEvents.mock.calls.length;
    page.receive({ type: 'page_sample', pageId: page.id, candidateId: b, event: 'waiting' });
    await player.serialize(async () => {});
    expect(published.mock.lastCall?.[0]).toMatchObject({ paused: true });
    expect(incumbentEvents).toHaveBeenCalledTimes(receivedA);
  } finally { player.close(); incumbent.close(); page.close(); }
});

test("App 27 receives a surviving popup and its retirement while the opener has no navigable URL", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket);
    const address = page.url, id = crypto.randomUUID();
    const popup = { id, pageURL: "https://popup.test/episode", title: "Episode", url: null, duration: null };
    const opaque = { ...popup, id: crypto.randomUUID(), pageURL: null };
    const send = (candidates: object[]) => socket.receive({ type: "page_candidates", pageId: page.id, url: address, candidates });
    send([popup, opaque]);
    expect(page.candidatePageURL(id)).toBe(popup.pageURL);
    expect(page.candidatePageURL(opaque.id)).toBeNull();
    send([]);
    expect(page.candidates).toEqual([]);
    expect(() => page.candidatePageURL(id)).toThrow("watch_page_unavailable");
    expect(app.connected).toBe(true);
  } finally { app.close(); }
});
