import { afterEach, expect, test, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
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
