import { afterEach, expect, test, vi } from "vitest";
import { APP_PROTOCOL, ChannelApp } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";

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
const state = { position: 12, paused: false, rate: 1, duration: null, readyState: 4, ended: false };
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
    expect(app.page(pageId)).toBeUndefined();
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
    expect(app.page(command.pageId as string)).toBeUndefined();
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
    socket.reply({ choices: [{ id: choiceId, displayURL: 'https://media.test/movie.m3u8', name: 'Movie', format: 'hls' }], byteSource: null });
    expect((await choices).choices).toHaveLength(1);
    const preparing = page.prepareMedia(choiceId);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_prepare', pageId, choiceId });
    const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: 'hls' };
    socket.reply(source); await expect(preparing).resolves.toEqual(source);
    const stopping = page.stopMedia();
    expect(socket.sent.at(-1)).toMatchObject({ type: 'page_media_stop', pageId });
    socket.reply(null); await stopping;
    expect(app.page(pageId)).toBe(page);
    expect(socket.sent.some(command => command.type === 'page_close')).toBe(false);
  } finally { app.close(); }
});
