import { afterEach, expect, test, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { observeWatchSources, PageSuppliedMedia, preparePortableWatchMedia } from "../src/client/channel/watch-page-media";
import { readFileSync } from "node:fs";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import * as watchResource from "../src/client/channel/watch-resource";
class Video extends EventTarget {
  currentTime = 12; duration = 30; paused = true; playbackRate = 1; readyState = 4; ended = false; error = null; src = "";
  buffered = { length: 1, start: () => 0, end: () => 30 };
  play = vi.fn(async () => { this.paused = false; }); pause() { this.paused = true; }
  removeAttribute() { this.src = ""; } load() {} remove() {}
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('main media owns state and events while its page owns only resource lifetime', async () => {
  const video = new Video();vi.stubGlobal('document', { createElement: () => video });
  vi.spyOn(watchResource, 'openWatchResource').mockResolvedValue({ url: 'https://source.test/file.mp4', close: vi.fn() });
  const dispose = vi.fn(), page = new AppPage(crypto.randomUUID(), 'https://source.test/video', vi.fn(), dispose, vi.fn());
  const candidateId = page.selectedCandidateId = crypto.randomUUID(), pageEvent = vi.fn();
  page.listen(pageEvent);
  const media = new PageSuppliedMedia(page, { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: 'file' });
  page.close();
  const changed = vi.fn();media.listen(changed);
  page.receive({type:'page_sample',pageId:page.id,candidateId,event:'seeked'});
  expect(pageEvent).toHaveBeenCalledWith('seeked');
  expect(changed).not.toHaveBeenCalled();expect((await media.read()).position).toBe(12);
  await media.patch({position:20,paused:false});expect(video.currentTime).toBe(20);expect(video.paused).toBe(false);
  video.dispatchEvent(new Event('seeked'));expect(changed).toHaveBeenCalledWith('seeked');
  page.receive({type:'page_closed',pageId:page.id});
  expect(video.src).toBe('');expect(changed).toHaveBeenCalledWith('closed');expect(dispose).toHaveBeenCalledOnce();
  media.close();expect(dispose).toHaveBeenCalledOnce();
});

test('players on the same page release independent references', async () => {
  vi.stubGlobal('document', { createElement: () => new Video() });
  vi.spyOn(watchResource, 'openWatchResource').mockResolvedValue({ url: 'https://source.test/file.mp4', close: vi.fn() });
  const closePage = vi.fn();
  const page = new AppPage(crypto.randomUUID(), 'https://source.test/video', vi.fn(), closePage, vi.fn());
  const source = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: 'file' as const };
  const first = new PageSuppliedMedia(page, source);
  const replacement = new PageSuppliedMedia(page, source, 'media');
  page.close();
  await replacement.ready(new AbortController().signal);
  first.close();
  first.close();
  expect(closePage).not.toHaveBeenCalled();
  expect(replacement.retainedByteSource).toBe(source);
  replacement.close();
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

test('failed source checks retry on request while automatic discovery keeps their cache', async () => {
  const { default: initializeCore } = await import('../prototype/channel-browser/pkg/piik_channel_browser');
  await initializeCore({ module_or_path: readFileSync('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const bytes = Uint8Array.from(readFileSync(new URL('./fixtures/indexed-av1.mp4', import.meta.url)));
  const working = { id: crypto.randomUUID(), name: 'Working track', hostname: 'source.test', totalSize: bytes.length, mimeType: 'video/mp4' };
  const failed = { ...working, id: crypto.randomUUID(), name: 'Failed track' };
  const publish = vi.fn();
  const page = new AppPage(crypto.randomUUID(), 'https://source.test/player', async () => ({
    choices: [], indexedCandidates: [working, failed], mpdCandidates: [], byteSource: null,
  }), vi.fn(), vi.fn());
  let failedReads = 0, pending: AbortSignal | undefined;
  const read = vi.spyOn(page, 'readMediaMetadata').mockImplementation(async (id, offset, length, signal) => {
    if (id === working.id) return { totalSize: bytes.length, bytes: bytes.subarray(offset, offset + length), mimeType: 'video/mp4' };
    if (++failedReads === 1) throw new Error('watch_media_unavailable');
    pending = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const observer = observeWatchSources(page, new AbortController().signal, publish);
  try {
    const first = await observer.ready;
    expect(first.indexed[0].error).toBeUndefined();
    expect(first.indexed[0].inspection).toBeDefined();
    expect(first.indexed[1].error).toBe('watch_media_unavailable');
    const successfulReads = read.mock.calls.filter(([id]) => id === working.id).length;
    page.receive({ type: 'page_media_changed', pageId: page.id });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(failedReads).toBe(1);
    const retry = first.retryIndexed!();
    await vi.waitFor(() => expect(pending).toBeDefined());
    expect(read.mock.calls.filter(([id]) => id === working.id)).toHaveLength(successfulReads);
    page.close();
    await retry;
    expect(pending!.aborted).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  } finally { observer.unsubscribe(); page.close(); }
});
