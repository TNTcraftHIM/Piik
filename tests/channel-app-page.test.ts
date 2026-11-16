import { afterEach, expect, test, vi } from "vitest";
import { APP_PROTOCOL, ChannelApp } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";
import { NATIVE_PAGE_METADATA_PREFIX_BYTES, NATIVE_PAGE_READ_BYTES, nativePageStateSchema } from "../src/client/native/wire";

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
async function setup() {
  vi.stubGlobal("WebSocket", Socket);
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793, pagePlayer: true }, "site", "user", "credential", "Me", () => {}, () => {});
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
    expect(socket.sent.at(-1)).toMatchObject({type:'page_media_resource',action:'cancel',pageId:page.id,sourceId,readId:request.readId});socket.reply(null);
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
test("App webpage selection has its own candidates and closes pending reads with the window", async () => {
  const { app, socket } = await setup();
  try {
    const preparing = app.preparePage("https://video.test/page", vi.fn(), new AbortController().signal);
    const pageId = socket.sent.at(-1)!.pageId as string;
    socket.reply({ pageId });
    const page = await preparing;
    const candidateId = crypto.randomUUID();
    socket.receive({ type: "page_candidates", pageId, url: "https://video.test/page", candidates: [{ id: candidateId, title: "Episode", url: null, duration: null }] });
    expect(page.candidates).toHaveLength(1);
    const selecting = page.select(candidateId); socket.reply(state); await selecting;
    const reading = page.read();
    const rejected = expect(reading).rejects.toThrow("watch_page_closed");
    const events: string[] = []; page.listen(event => events.push(event));
    socket.receive({ type: "page_closed", pageId });
    await rejected;
    expect(events).toEqual(["closed"]);
    socket.reply(null);
    expect((app as unknown as { requests: Map<string, unknown> }).requests.size).toBe(0);
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

test('watch byte source registration retains the original webpage and stop retires only its reader', async () => {
  const { app, socket } = await setup();
  try {
    const opening = app.preparePage('https://video.test/page', vi.fn(), new AbortController().signal);
    const pageId = socket.sent.at(-1)!.pageId as string; socket.reply({ pageId });
    const page = await opening;
    const choiceId = crypto.randomUUID();
    const choices = page.mediaSources();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_sources', pageId });
    socket.reply({ choices: [{ id: choiceId, displayURL: 'https://media.test/movie.m3u8', name: 'Movie', format: 'hls' }], indexedCandidates: [], byteSource: null });
    expect((await choices).choices).toHaveLength(1);
    const preparing = page.prepareMedia(choiceId);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_prepare', pageId, choiceId });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: 'hls' };
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
    socket.reply({ choices: [direct], indexedCandidates: [candidate], byteSource: null });
    await expect(sources).resolves.toEqual({ choices: [direct], indexedCandidates: [candidate], byteSource: null });
    const missingHost = page.mediaSources();
    const { hostname: _hostname, ...oldCandidate } = candidate;
    socket.reply({ choices: [], indexedCandidates: [oldCandidate], byteSource: null });
    await expect(missingHost).rejects.toThrow();
    const privateHost = page.mediaSources();
    socket.reply({ choices: [], indexedCandidates: [{ ...candidate, hostname: "media.test?private=grant" }], byteSource: null });
    await expect(privateHost).rejects.toThrow();
    const obsolete = page.mediaSources();
    socket.reply({ choices: [direct], byteSource: null });
    await expect(obsolete).rejects.toThrow();
    const leaked = page.mediaSources();
    socket.reply({ choices: [direct], indexedCandidates: [{ ...candidate, url: "https://media.test/private-track" }], byteSource: null });
    await expect(leaked).rejects.toThrow();
  } finally { app.close(); }
});

test("selected-page metadata reads use opaque IDs and enforce both byte-window bounds before sending", async () => {
  const { app, socket } = await setup();
  try {
    const page = await openPage(app, socket), choiceId = crypto.randomUUID(), signal = new AbortController().signal;
    const offset = NATIVE_PAGE_METADATA_PREFIX_BYTES - 3;
    const reading = page.readMediaMetadata(choiceId, offset, 3, signal);
    expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), type: "page_media_read_metadata", pageId: page.id, choiceId, offset, length: 3 });
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
    const preparing = page.prepareIndexedMedia({ video }, signal);
    expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), type: "page_media_prepare_indexed", pageId: page.id, video });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" };
    socket.reply(source); await expect(preparing).resolves.toEqual(source);
    const invalid = page.prepareIndexedMedia({ video }, signal);
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
    await expect(page.prepareIndexedMedia({ video, audio }, signal)).rejects.toThrow("watch_resource_limit");
    expect(socket.sent).toHaveLength(sent);
    const cancel = new AbortController();
    const preparing = page.prepareIndexedMedia({ video: { ...video, initBase64: "AAAA" } }, cancel.signal);
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


test("hello timeout and its pending rejection retire the App link once", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const closed = vi.fn();
  const app = new ChannelApp({ service: "piik-channel-app", protocol: APP_PROTOCOL, domainProtocol: CHANNEL_PROTOCOL,
    token: "test-token", port: 8793 }, "site", "user", "credential", "Me", closed, () => {});
  const failed = expect(app.ready).rejects.toThrow("app_disconnected");
  Socket.current.onopen?.();
  try {
    await vi.advanceTimersByTimeAsync(10000);
    await failed;
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    app.close();
    vi.useRealTimers();
  }
});
