import { afterEach, expect, test, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { observeWatchSources, PageSuppliedMedia, preparePortableWatchMedia } from "../src/client/channel/watch-page-media";
import { readFileSync } from "node:fs";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
class Video extends EventTarget {
  currentTime = 12; duration = 30; paused = true; playbackRate = 1; readyState = 4; ended = false; error = null; src = "";
  buffered = { length: 1, start: () => 0, end: () => 30 };
  play = vi.fn(async () => { this.paused = false; }); pause() { this.paused = true; }
  removeAttribute() { this.src = ""; } load() {} remove() {}
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('main media owns state and events while its page owns only resource lifetime', async () => {
  const video = new Video();vi.stubGlobal('document', { createElement: () => video });
  const dispose = vi.fn(), page = new AppPage(crypto.randomUUID(), 'https://source.test/video', vi.fn(), dispose, vi.fn());
  const media = new PageSuppliedMedia(page, new HTMLVideoMedia('https://source.test/file.mp4', 'file'), {sessionId:crypto.randomUUID(),resourceId:crypto.randomUUID(),format:'hls'});
  const changed = vi.fn();media.listen(changed);
  page.receive({type:'page_sample',pageId:page.id,event:'seeked'});
  expect(changed).not.toHaveBeenCalled();expect((await media.read()).position).toBe(12);
  await media.patch({position:20,paused:false});expect(video.currentTime).toBe(20);expect(video.paused).toBe(false);
  video.dispatchEvent(new Event('seeked'));expect(changed).toHaveBeenCalledWith('seeked');
  page.receive({type:'page_closed',pageId:page.id});
  expect(video.src).toBe('');expect(changed).toHaveBeenCalledWith('closed');expect(dispose).toHaveBeenCalledOnce();
  media.close();expect(dispose).toHaveBeenCalledOnce();
});

test('a failed local retry keeps the provider open and only its committed successor closes it', () => {
  vi.stubGlobal('document', { createElement: () => new Video() });
  const closePage = vi.fn();
  const page = new AppPage(crypto.randomUUID(), 'https://source.test/video', vi.fn(), closePage, vi.fn());
  const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: 'file' as const };
  const first = new PageSuppliedMedia(page, new HTMLVideoMedia('https://source.test/file.mp4', 'file'), source);
  first.retryCandidate('media').close();
  expect(closePage).not.toHaveBeenCalled();
  const replacement = first.retryCandidate('media');
  first.transferPageTo(replacement);
  first.close();
  expect(closePage).not.toHaveBeenCalled();
  expect(replacement.retainedByteSource).toBe(source);
  replacement.close();
  expect(closePage).toHaveBeenCalledOnce();
});

test.each(['unsubscribe', 'caller', 'page'] as const)('page-source %s retirement cancels metadata and suppresses its late publication', async retirement => {
  const bytes = readFileSync(new URL('./fixtures/indexed-av1.mp4', import.meta.url));
  const candidate = { id: crypto.randomUUID(), name: 'Owned track', hostname: 'source.test', totalSize: bytes.length, mimeType: 'video/mp4' };
  const dispose = vi.fn(), publish = vi.fn(), lifetime = new AbortController();
  let complete!: (value: unknown) => void, reading!: AbortSignal;
  const request = vi.fn(async (command: { type: string; action?: unknown }, signal: AbortSignal): Promise<unknown> => {
    if (command.type === 'page_media_sources') return { choices: [], indexedCandidates: [candidate], mpdCandidates: [], byteSource: null };
    if (command.action === 'read_metadata') { reading = signal; return new Promise(resolve => { complete = resolve; }); }
    return null;
  });
  const page = new AppPage(crypto.randomUUID(), 'https://source.test/player', request, dispose, vi.fn());
  const observeResources = vi.spyOn(page, 'listenMediaSources'), observePage = vi.spyOn(page, 'listen');
  const observer = observeWatchSources(page, lifetime.signal, publish);
  const retired = expect(observer.ready).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(complete).toBeDefined());
    if (retirement === 'page') page.close();
    else if (retirement === 'caller') lifetime.abort();
    else observer.unsubscribe();
    expect(reading.aborted).toBe(true);
    complete({ totalSize: bytes.length, mimeType: 'video/mp4', bytesBase64: bytes.toString('base64') });
    await retired;
    expect(publish).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(retirement === 'page' ? 1 : 0);
    page.receive({ type: 'page_media_changed', pageId: page.id });
    await Promise.resolve();
    expect(request.mock.calls.filter(([command]) => command.type === 'page_media_sources')).toHaveLength(1);
    expect(observeResources).toHaveBeenCalledOnce(); expect(observePage).toHaveBeenCalledOnce();
  } finally { observer.unsubscribe(); page.close(); }
});

test('leaving while preparing main playback keeps the original page playing', async () => {
  const video = new Video(), selection = new AbortController();
  vi.stubGlobal('document', { createElement: () => video });
  const page = new AppPage(crypto.randomUUID(), 'https://source.test/video', vi.fn(), vi.fn(), vi.fn());
  vi.spyOn(page, 'read').mockResolvedValue({ position: 12, rate: 1, paused: false, readyState: 4, duration: 30, ended: false, buffered: [] });
  const pausePage = vi.spyOn(page, 'patch').mockResolvedValue();
  vi.spyOn(HTMLVideoMedia.prototype, 'patch').mockImplementation(async () => { selection.abort(); });
  await expect(preparePortableWatchMedia(page, 'https://source.test/file.mp4', selection.signal, 'file')).rejects.toMatchObject({ name: 'AbortError' });
  expect(pausePage).not.toHaveBeenCalled();
  expect(video.src).toBe('');
});
