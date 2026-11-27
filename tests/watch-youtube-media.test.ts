import { afterEach, expect, test, vi } from "vitest";
import { youtubeVideoId, youtubeSourceId, youtubeStartSeconds } from "../src/client/channel/watch-youtube-source";

class Element {
  isConnected = false; children: Element[] = []; src = ""; title = ""; className = "";
  onerror: (() => void) | null = null;
  append(child: Element) { this.children.push(child); child.isConnected = this.isConnected; }
  remove() { this.isConnected = false; }
}
class Player {
  state = 5; position = 0; rate = 1; destroyed = false;
  constructor(readonly frame: Element, readonly options: {events: Record<string, (e: {data:number})=>void>}) { players.push(this); }
  fire(name:string,data=0) { this.options.events[name]?.({data}); }
  getVideoUrl() { return "https://www.youtube.com/watch?v=M7lc1UVf-VE"; }
  getCurrentTime() { return this.position; }
  getDuration() { return 120; }
  getPlayerState() { return this.state; }
  getPlaybackRate() { return this.rate; }
  getAvailablePlaybackRates() { return [1,1.5]; }
  playVideo() { this.state=1;this.fire('onStateChange',1); }
  pauseVideo() { this.state=2;this.fire('onStateChange',2); }
  seekTo(position:number) { this.position=position; }
  setPlaybackRate(rate:number) { this.rate=rate;this.fire('onPlaybackRateChange',rate); }
  destroy() { this.destroyed=true;this.frame.remove(); }
}
let players: Player[] = [];
async function setup(cold=false, startSeconds?: number, suspendWhenHidden = false) {
  vi.resetModules();players=[];
  const head=new Element();head.isConnected=true;
  const window: {YT?:object;onYouTubeIframeAPIReady?:()=>void}={};
  if(!cold)window.YT={Player};
  vi.stubGlobal('window',window);vi.stubGlobal('location',{origin:'https://piik.test'});
  vi.stubGlobal('document',{head,documentElement:{moveBefore(){}},createElement:()=>new Element()});
  const {YouTubeMedia}=await import('../src/client/channel/watch-youtube-media');
  const media=new YouTubeMedia('M7lc1UVf-VE', startSeconds,suspendWhenHidden);
  const mount=async()=>{(media.presentation.element as unknown as Element).isConnected=true;media.presentation.setVisible(true);await Promise.resolve();await Promise.resolve();};
  return {media,mount,head,window};
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

test('only explicit fixed embed sources advertise Browser support',()=>{
  expect(youtubeVideoId('https://youtu.be/M7lc1UVf-VE?si=tracking')).toBe('M7lc1UVf-VE');
  expect(youtubeVideoId('https://www.youtube.com/watch?v=M7lc1UVf-VE&v=abcdefghijk')).toBeNull();
  expect(youtubeVideoId('https://youtube.com.evil.test/watch?v=M7lc1UVf-VE')).toBeNull();
  expect(youtubeSourceId({kind:'website',url:'https://www.youtube.com/watch?v=M7lc1UVf-VE'})).toBeNull();
  expect(youtubeSourceId({kind:'website',url:'https://www.youtube.com/embed/M7lc1UVf-VE'})).toBe('M7lc1UVf-VE');
});

test('a Shorts link selects one video without publishing the original webpage', () => {
  const id = 'oozRsI-EUic';
  const short = `https://www.youtube.com/shorts/${id}`;
  expect(youtubeVideoId(`${short}?si=tracking`)).toBe(id);
  expect(youtubeVideoId(`https://m.youtube.com/shorts/${id}/`)).toBe(id);
  expect(youtubeVideoId(`${short}/other`)).toBeNull();
  expect(youtubeSourceId({ kind: 'website', url: short })).toBeNull();
});

test('cold SDK preparation stays pending through API ready until the visible candidate plays',async()=>{
  const {media,mount,head,window}=await setup(true);let ready=false;
  const prepared=media.ready(new AbortController().signal).then(()=>{ready=true;});
  expect(head.children).toHaveLength(1);await mount();expect(players).toHaveLength(0);
  window.YT={Player};window.onYouTubeIframeAPIReady!();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const player=players[0];player.fire('onReady');await Promise.resolve();expect(ready).toBe(false);
  expect((await media.read()).buffered).toBeNull();
  player.playVideo();await prepared;expect(ready).toBe(true);
  expect(player.frame.src).toContain('origin=https%3A%2F%2Fpiik.test');media.close();
});

test('cancel before SDK completion never creates a late iframe',async()=>{
  const {media,mount,window}=await setup(true);const prepared=media.ready(new AbortController().signal);await mount();
  media.close();await expect(prepared).rejects.toMatchObject({name:'AbortError'});
  window.YT={Player};window.onYouTubeIframeAPIReady!();await Promise.resolve();await Promise.resolve();
  expect(players).toHaveLength(0);
});

test.each([false, true])('embed denial rejects preparation and reports the failure once (API ready: %s)', async apiReady => {
  const { media, mount } = await setup();
  await mount();
  const failed = vi.fn();
  media.listen(event => { if (event === 'error') failed(); });
  const prepared = media.ready(new AbortController().signal);
  try {
    if (apiReady) players[0].fire('onReady');
    players[0].fire('onError', 150);
    await expect(prepared).rejects.toThrow('watch_media_unavailable');
    await expect(media.read()).rejects.toThrow('watch_media_unavailable');
    expect(failed).toHaveBeenCalledOnce();
  } finally { media.close(); }
});

test('confirmed commands report real state, unsupported rates fail, hiding pauses only this player',async()=>{
  const {media,mount}=await setup();await mount();const player=players[0];player.fire('onReady');player.playVideo();
  await media.ready(new AbortController().signal);
  await media.patch({position:60,paused:true,rate:1.5});
  expect(await media.read()).toMatchObject({position:60,paused:true,rate:1.5,buffered:null});
  await expect(media.patch({rate:1.25})).rejects.toThrow('watch_media_unsupported');
  media.presentation.setVisible(false);expect(media.playbackAvailable()).toBe(false);expect(player.state).toBe(2);
  media.close();expect(player.destroyed).toBe(true);
});

test('closing a play waiting for visible eligibility rejects its caller',async()=>{
  vi.useFakeTimers();const {media,mount}=await setup();await mount();const player=players[0];player.fire('onReady');player.playVideo();
  await media.ready(new AbortController().signal);player.pauseVideo();media.presentation.setVisible(true,false);
  const command=media.patch({paused:false});await Promise.resolve();await Promise.resolve();media.close();
  await expect(command).rejects.toMatchObject({name:'AbortError'});expect(vi.getTimerCount()).toBe(0);
});

test('presentation handoff waits for the actual stage and aborts with its source selection',async()=>{
  const {media}=await setup();const controller=new AbortController();
  const pending=media.waitForPresentation(controller.signal);controller.abort();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  const moved=media.waitForPresentation(new AbortController().signal);media.presentation.mounted();await moved;media.close();
});

test('a receiver can mount without state-preserving moves and hiding suspends local playback without reporting autoplay denial', async () => {
  const {media,mount}=await setup(false, undefined, true);
  delete (document.documentElement as unknown as {moveBefore?:unknown}).moveBefore;
  const {YouTubeMedia}=await import('../src/client/channel/watch-youtube-media');
  const receiver=new YouTubeMedia('M7lc1UVf-VE');receiver.close();
  const events:string[]=[];media.listen(event=>events.push(event));await mount();
  players[0].fire('onReady');players[0].playVideo();await media.ready(new AbortController().signal);
  media.presentation.setVisible(false);media.presentation.setVisible(true);
  expect(events).not.toContain('blocked');expect(events).toContain('visibility-resumed');expect((await media.read()).paused).toBe(true);players[0].fire('onAutoplayBlocked');expect(events).toContain('blocked');
  await media.patch({paused:false});expect((await media.read()).paused).toBe(false);media.close();
});

test('hiding the sharer does not pause the SDK player', async () => {
  const {media, mount} = await setup();
  await mount();
  players[0].fire('onReady');
  players[0].playVideo();
  media.presentation.setVisible(false);
  expect((await media.read()).paused).toBe(false);
  media.close();
});

test('scripted play waits for observed visible eligibility after focus changes', async () => {
  vi.useFakeTimers();const {media,mount}=await setup();await mount();const player=players[0];
  player.fire('onReady');player.playVideo();await media.ready(new AbortController().signal);player.pauseVideo();
  media.presentation.setVisible(true,false);const play=vi.spyOn(player,'playVideo');const pending=media.patch({paused:false});
  await vi.advanceTimersByTimeAsync(300);expect(play).not.toHaveBeenCalled();
  media.presentation.setVisible(true,true);await vi.advanceTimersByTimeAsync(100);await pending;
  expect(play).toHaveBeenCalledOnce();media.close();
});


test("an explicit embed start initializes the preview without becoming source identity", async () => {
  const raw = "https://www.youtube.com/embed/M7lc1UVf-VE?start=90&playlist=abcdefghijk&autoplay=1";
  expect(youtubeVideoId(raw)).toBe("M7lc1UVf-VE");
  const { media, mount } = await setup(false, 90);
  try {
    await mount();
    const frame = new URL(players[0].frame.src);
    expect(frame.searchParams.get("start")).toBe("90");
    expect(frame.searchParams.get("autoplay")).toBe("0");
    expect(frame.searchParams.has("playlist")).toBe(false);
    expect(media.sourceURL).toBe("https://www.youtube.com/embed/M7lc1UVf-VE");
    players[0].position = 88; // The official SDK may start at the preceding keyframe.
    players[0].fire("onReady"); players[0].playVideo();
    await media.ready(new AbortController().signal);
    expect((await media.read()).position).toBe(88);
  } finally { media.close(); }
});

test("only an unambiguous documented integer embed start is an initial position", () => {
  expect(youtubeStartSeconds("https://www.youtube.com/embed/M7lc1UVf-VE?start=90")).toBe(90);
  for (const tail of ["start=-1", "start=1.5", "start=1&start=2", "start=9007199254740992", "start=not-a-time"])
    expect(youtubeStartSeconds("https://www.youtube.com/embed/M7lc1UVf-VE?" + tail)).toBeUndefined();
  expect(youtubeStartSeconds("https://www.youtube.com/embed?list=PLowned&start=90")).toBeUndefined();
  expect(youtubeVideoId("https://www.youtube.com/embed?listType=playlist&list=PLowned")).toBeNull();
  expect(youtubeSourceId({ kind: "website", url: "https://www.youtube.com/embed/M7lc1UVf-VE?start=90" })).toBeNull();
});

test("share links preserve seconds and ordered time units on the selected video", () => {
  expect(youtubeStartSeconds("https://youtu.be/M7lc1UVf-VE?t=90")).toBe(90);
  expect(youtubeStartSeconds("https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s")).toBe(90);
  expect(youtubeStartSeconds("https://youtu.be/M7lc1UVf-VE?t=1h2m3s")).toBe(3723);
  for (const query of ["", "t=0", "t=1s2m", "t=-3", "t=1.5", "t=9007199254740992", "t=3&t=4", "start=90"])
    expect(youtubeStartSeconds("https://youtu.be/M7lc1UVf-VE?" + query)).toBeUndefined();
  expect(youtubeStartSeconds("https://www.youtube.com/embed/M7lc1UVf-VE?t=90")).toBeUndefined();
});

test('closing between SDK resolution and mount does not create a player', async () => {
  const { media, mount } = await setup();
  const mounting = mount();
  queueMicrotask(() => media.close());
  await mounting;
  expect(players).toHaveLength(0);
});

test('a receiver pauses a provider that first reports playing after the stage hides', async () => {
  const { media, mount } = await setup(false, undefined, true);
  try {
    await mount();
    const player = players[0];
    player.fire("onReady");
    media.presentation.setVisible(false);
    player.playVideo();
    expect((await media.read()).paused).toBe(true);
  } finally { media.close(); }
});
