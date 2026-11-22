import { HTMLVideoMedia, AppPageMedia, type AppPagePort, type WatchMediaEvent, type WatchMedia, type WatchMediaState } from "../src/client/channel/watch-media";
import { afterEach, expect, test, vi } from "vitest";
import { WatchPlayer } from "../src/client/channel/watch-playback";

class Video extends EventTarget {
  currentTime = 0; duration = 120; playbackRate = 1; paused = true; ended = false; readyState = 0;
  ranges: [number, number][] = [[0, 120]];
  get buffered() { return { length: this.ranges.length, start: (index: number) => this.ranges[index][0], end: (index: number) => this.ranges[index][1] }; }
  src = ""; error = null; volume = 1; muted = false;
  denied = false;
  play = vi.fn(async () => { if (this.denied) throw new DOMException("Playback denied", "NotAllowedError"); this.paused = false; this.dispatchEvent(new Event("playing")); });
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load = vi.fn();
  remove = vi.fn();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("a displayed frame suffices while paused and running playback needs data for the next frame", () => {
  const element = Object.assign(new Video(), { videoWidth: 640, readyState: 2 });
  const media: WatchMedia = { presentation: { kind: "video", element: element as unknown as HTMLVideoElement },
    read: vi.fn(), patch: vi.fn(), ready: vi.fn(), listen: () => () => {}, close: vi.fn() };
  const player = new WatchPlayer("room", false, media, vi.fn());
  try {
    expect(player.waitingForPicture).toBe(true);
    player.presentFrame();
    expect(player.waitingForPicture).toBe(false);
    element.paused = false;
    expect(player.waitingForPicture).toBe(true);
    element.ended = true;
    expect(player.waitingForPicture).toBe(false);
    element.ended = false;
    element.readyState = 3;
    expect(player.waitingForPicture).toBe(false);
  } finally { player.close(); }
});

test("one watch player retains its first-frame observation across presentation mounts and rejects a late retired callback", () => {
  const media: WatchMedia = { read: vi.fn(), patch: vi.fn(), ready: vi.fn(), listen: () => () => {}, close: vi.fn() };
  const changed = vi.fn(), player = new WatchPlayer('room', false, media, changed);
  expect(player.hasPresentedFrame).toBe(false);
  player.presentFrame(); player.presentFrame();
  expect(player.hasPresentedFrame).toBe(true); expect(changed).toHaveBeenCalledOnce();
  player.close(); player.presentFrame();
  expect(changed).toHaveBeenCalledOnce();
  const replacement = new WatchPlayer('room', false, media, changed);
  replacement.close(); replacement.presentFrame();
  expect(replacement.hasPresentedFrame).toBe(false);
});

test("program anchors use the domain clock and wait for the sharer when a paused point expires", async () => {
  vi.useFakeTimers(); let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const epoch = 1794744000;
  const state: WatchMediaState = { position: epoch + 8, paused: false, rate: 1, duration: null, readyState: 4, ended: false,
    buffered: [[epoch + 6, epoch + 12]], live: { active: true, seekable: [[epoch + 6, epoch + 18]], syncPosition: epoch + 12 } };
  const patch = vi.fn(async (value: object) => { Object.assign(state, value); });
  const media: WatchMedia = { read: async () => ({ ...state }), patch, ready: async () => {}, listen: () => () => {}, close() {} };
  const player = new WatchPlayer("room", false, media, vi.fn());
  try {
    player.calibrate(5000, 0, 0); player.update({ timeline: "program", position: epoch + 10, paused: true, rate: 1, anchorTime: 5000 });
    await player.ready(); expect(state.position).toBe(epoch + 10); expect(state.paused).toBe(true);
    state.live = { active: true, seekable: [[epoch + 20, epoch + 32]], syncPosition: epoch + 26 }; state.buffered = [];
    await vi.advanceTimersByTimeAsync(1000); expect(player.error).toBeNull(); // A locally retained pause is preserved.
    state.position = epoch + 26; patch.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.error).toBe("watch_live_position_unavailable");
    expect(patch.mock.calls.every(([value]) => !("position" in value))).toBe(true);
    player.update({ timeline: "program", position: epoch + 10, paused: false, rate: 1, anchorTime: 5000 });
    await player.serialize(async () => {}); patch.mockClear(); await player.resume();
    expect(state.paused).toBe(true);
    expect(patch.mock.calls.some(([value]) => (value as { paused?: boolean }).paused === false)).toBe(false);
    now = 5000;
    player.update({ timeline: "program", position: epoch + 25, paused: false, rate: 1, anchorTime: 9000 });
    await player.serialize(async () => {});
    expect(state.position).toBe(epoch + 26); expect(state.paused).toBe(false); expect(player.error).toBeNull();
    state.live.active = false; state.duration = 12;
    await vi.advanceTimersByTimeAsync(1000); expect(state.position).toBeGreaterThan(epoch);
    player.update({ timeline: "program", position: epoch + 32, paused: true, rate: 1, anchorTime: 10000 });
    await player.serialize(async () => {});
    expect(state.position).toBe(epoch + 32); expect(player.error).toBeNull();
  } finally { player.close(); }
});

test("unknown iframe buffering applies explicit updates without inventing periodic safe ranges", async () => {
  vi.useFakeTimers();
  const state: WatchMediaState = { position: 0, paused: true, rate: 1, duration: 120, readyState: 3, ended: false, buffered: null };
  const patch = vi.fn(async (value: object) => { Object.assign(state, value); });
  const media: WatchMedia = { read: async () => ({ ...state }), patch, ready: async () => {}, listen: () => () => {}, close() {}, seekTolerance: 2, playbackRates: () => [1, 1.5] };
  const player = new WatchPlayer("room", false, media, vi.fn());
  try {
    player.calibrate(5000, performance.now()); player.update({ timeline: "media" as const, position: 60, paused: true, rate: 1, anchorTime: 5000 }); await player.ready();
    expect(state.position).toBe(60); patch.mockClear(); state.position = 20;
    await vi.advanceTimersByTimeAsync(3000);
    expect(patch.mock.calls.every(([value]) => !("position" in value))).toBe(true);
    player.update({ timeline: "media" as const, position: 10, paused: true, rate: 1.25, anchorTime: 8000 });
 await player.serialize(async () => {});
    expect(player.error).toBe("watch_media_unsupported");
    expect(patch.mock.calls.every(([value]) => !("rate" in value))).toBe(true);
  } finally { player.close(); }
});

test("a player without seek events publishes an observed paused scrub on the existing tick", async () => {
  vi.useFakeTimers();
  const state: WatchMediaState = { position: 10, paused: true, rate: 1, duration: 120, readyState: 2, ended: false, buffered: null };
  const media: WatchMedia = { read: async () => ({ ...state }), patch: async () => {}, ready: async () => {}, listen: () => () => {}, close() {}, seekEvents: false, seekTolerance: 2 };
  const player = new WatchPlayer("room", true, media, vi.fn()), publish = vi.fn(async () => {});
  try {
    player.calibrate(5000, performance.now()); await player.ready(); player.activate(publish);
    state.position = 40; await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ position: 40, paused: true }));
  } finally { player.close(); }
});

test("an embedded viewer resumes at the current host anchor after a hidden interval", async () => {
  vi.useFakeTimers();let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
  const state:WatchMediaState={position:10,paused:false,rate:1,duration:120,readyState:3,buffered:null,ended:false};
  let notify:(event:WatchMediaEvent)=>void=()=>{},visible=true;
  const media:WatchMedia={read:async()=>({...state}),patch:async value=>{Object.assign(state,value);},ready:async()=>{},
    listen:fn=>{notify=fn;return()=>{};},close(){},playbackAvailable:()=>visible};
  const player=new WatchPlayer('room',false,media,vi.fn());
  try{
    player.calibrate(5000,0,0);player.update({ timeline: "media" as const,position:10,paused:false,rate:1,anchorTime:5000});await player.ready();
    visible=false;state.paused=true;notify('blocked');now=10000;await vi.advanceTimersByTimeAsync(1000);
    visible=true;await vi.advanceTimersByTimeAsync(1000);expect(state.position).toBe(10);expect(state.paused).toBe(true);
    await player.resume();expect(state.position).toBe(20);expect(state.paused).toBe(false);
  }finally{player.close();}
});

test("a local iframe scrub offers explicit resynchronization without periodic seek fights", async () => {
  vi.useFakeTimers();let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
  const state:WatchMediaState={position:10,paused:true,rate:1,duration:120,readyState:2,buffered:null,ended:false};
  const media:WatchMedia={read:async()=>({...state}),patch:async value=>{Object.assign(state,value);},ready:async()=>{},listen:()=>()=>{},close(){},seekEvents:false,seekTolerance:2};
  const player=new WatchPlayer('room',false,media,vi.fn());
  try{
    player.calibrate(5000,0,0);player.update({ timeline: "media" as const,position:10,paused:true,rate:1,anchorTime:5000});await player.ready();
    state.position=60;now=1000;await vi.advanceTimersByTimeAsync(1000);
    expect(player.blocked).toBe(true);expect(state.position).toBe(60);
    await player.resume();
    expect(state.position).toBe(10);
    expect(player.blocked).toBe(false);
    player.update({ timeline: "media", position: 10, paused: false, rate: 1, anchorTime: 6000 });
    await player.serialize(async () => {});
    expect(state.paused).toBe(false);
  }finally{player.close();}
});

test("late metadata and manual autoplay retry use the latest domain anchor; sound remains local", async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", false, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  try {
    player.calibrate(5100, 80, 120);
    player.update({ timeline: "media" as const, position: 10, anchorTime: 5100, paused: false, rate: 2 });
    now = 2100; video.readyState = 2; video.denied = true;
    await player.ready();
    video.dispatchEvent(new Event("loadedmetadata"));
    await player.serialize(async () => {});
    expect(video.currentTime).toBe(14);
    expect(player.blocked).toBe(true);
    video.volume = 0.2; now = 4100; video.denied = false;
    await player.resume();
    expect(video.currentTime).toBe(18);
    expect(video.volume).toBe(0.2);
    expect(player.blocked).toBe(false);
    player.update({ timeline: "media" as const, position: 3, anchorTime: 9100, paused: true, rate: 0.5 });
    await player.resume();
    expect(video.currentTime).toBe(3);
    expect(video.paused).toBe(true);
    video.currentTime = 3.2;
    player.update({ timeline: "media" as const, position: 3, anchorTime: 9100, paused: true, rate: 0.5 });
    expect(video.currentTime).toBe(3.2);
  } finally { player.close(); }
  expect(video.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

test("admitted creator native playback events are serialized and use integer domain milliseconds", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(100.75);
  const video = new Video(); video.readyState = 2;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  const send = vi.fn(async (_playback: unknown) => {});
  try {
    video.dispatchEvent(new Event("pause"));
    player.calibrate(5000, 80.25, 100.75);
    player.activate(send);
    video.currentTime = 20;
    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("pause"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ timeline: "media" as const, position: 20, paused: true, rate: 1, anchorTime: 5010 });
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
    video.paused = true; video.currentTime = 120;
    video.dispatchEvent(new Event("ended"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenLastCalledWith({ timeline: "media" as const, position: 120, paused: true, rate: 1, anchorTime: 5010 });
  } finally { player.close(); }
});

test.each([false, true])("a paused creator retries a rejected update (forced retry: %s)", async force => {
  const video = new Video(); video.readyState = 2; video.currentTime = 25; video.playbackRate = 1.5;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  const send = vi.fn(async () => {}).mockRejectedValueOnce(new Error("offline"));
  try {
    player.calibrate(5000, 0, 0);
    player.activate(send);
    video.dispatchEvent(new Event("pause"));
    await player.serialize(async () => {});
    expect(player.error).toBe("watch_update_failed");
    await Promise.all([player.publish(force), player.publish()]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true, position: 25, rate: 1.5 }));
    expect(player.error).toBeNull();
  } finally { player.close(); }
});

test("creator acknowledgements never seek; retiring suppresses queued sends", async () => {
  vi.useFakeTimers();
  const video = new Video(); video.readyState = 2; video.currentTime = 25;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  player.calibrate(5000, 0, 0);
  player.update({ timeline: "media" as const, position: 2, anchorTime: 5000, paused: true, rate: 1 });
  expect(video.currentTime).toBe(25);
  const send = vi.fn(async () => {});
  const pending = player.serialize(send);
  player.close(); await pending;
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("candidate cancellation releases its load listeners and deadline", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  const cancel = new AbortController();
  const pending = player.ready(cancel.signal);
  cancel.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  player.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("creator playing reanchors initial start and buffer recovery even at the same media position", async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const video = new Video(); video.readyState = 2; video.currentTime = 20; video.paused = false;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  const send = vi.fn(async (_playback: unknown) => {});
  try {
    player.calibrate(5000, 100, 100);
    player.activate(send);
    video.dispatchEvent(new Event("play"));
    await player.serialize(async () => {});
    clock.mockReturnValue(1100);
    video.dispatchEvent(new Event("playing"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenLastCalledWith({ timeline: "media" as const, position: 20, paused: false, rate: 1, anchorTime: 6000 });
    video.dispatchEvent(new Event("waiting"));
    video.dispatchEvent(new Event("waiting"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ position: 20, paused: true }));
    expect(video.paused).toBe(false);
    clock.mockReturnValue(3100);
    video.dispatchEvent(new Event("playing"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith({ timeline: "media" as const, position: 20, paused: false, rate: 1, anchorTime: 8000 });
    video.dispatchEvent(new Event("waiting"));
    await player.serialize(async () => {});
    video.pause();
    video.dispatchEvent(new Event("pause"));
    video.dispatchEvent(new Event("playing"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));
  } finally { player.close(); }
});

test('App player samples asynchronous reads in the local monotonic domain and retires a pending open', async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let complete!: (value: { position: number; paused: boolean; rate: number; duration: number; readyState: number; ended: boolean; buffered: [number, number][] }) => void;
  const port: AppPagePort = { read: () => new Promise(resolve => { complete = resolve; }), patch: vi.fn(async () => {}),
    listen: () => () => {}, focus: vi.fn(async () => {}), close: vi.fn() };
  const media = new AppPageMedia(port);
  const player = new WatchPlayer('room', true, media, vi.fn());
  try {
    player.calibrate(5000, 100, 100);
    await media.opening;
    const sampling = player.sample();
    await Promise.resolve();
    now = 300;
    complete({ position: 12, paused: false, rate: 1, duration: 60, readyState: 4, ended: false, buffered: [[0, 60]] as [number, number][] });
    await expect(sampling).resolves.toMatchObject({ position: 12, anchorTime: 5100 });
  } finally { player.close(); }
  expect(port.close).toHaveBeenCalledTimes(1);
  let opened!: (value: AppPagePort) => void;
  const pendingMedia = new AppPageMedia(() => new Promise(resolve => { opened = resolve; }));
  const pendingPlayer = new WatchPlayer('room', false, pendingMedia, vi.fn());
  await Promise.resolve();
  pendingPlayer.close();
  opened(port);
  await expect(pendingMedia.opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(port.close).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('native owner progress reuses the observation tick without publishing playback', async () => {
  vi.useFakeTimers();
  let position = 12, paused = true, bufferEnd = 60;
  const port: AppPagePort = { read: async () => ({ position, paused, rate: 1, duration: 60, readyState: 4, ended: false, buffered: [[0, bufferEnd]] as [number, number][] }),
    patch: vi.fn(async () => {}), listen: () => () => {}, focus: vi.fn(async () => {}), close: vi.fn() };
  const changed = vi.fn();
  const player = new WatchPlayer('room', true, new AppPageMedia(port), changed);
  const mediaChanged = vi.fn();
  const unsubscribe = player.subscribeMedia(mediaChanged);
  const send = vi.fn(async () => {});
  try {
    await player.ready(); player.calibrate(5000, 100, 100); player.activate(send);
    await player.serialize(async () => {});
    expect(player.mediaState?.position).toBe(12);
    changed.mockClear();
    mediaChanged.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).not.toHaveBeenCalled();
    position = 13; paused = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.mediaState?.position).toBe(13);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(mediaChanged).toHaveBeenCalledTimes(1);
    changed.mockClear();
    bufferEnd = 70;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mediaChanged).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
    position = 14;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mediaChanged).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally { player.close(); }
});

test.each([1, 2])("buffering at readyState %s suspends periodic seeks while explicit controls and recovery still work", async readyState => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const video = new Video(); video.readyState = 2;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", false, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  try {
    player.calibrate(5100, 100, 100);
    player.update({ timeline: "media" as const, position: 10, paused: false, rate: 1, anchorTime: 5100 });
    await player.ready();
    expect(video.currentTime).toBe(10);
    video.readyState = readyState;
    for (let tick = 0; tick < 3; tick++) {
      now += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(video.currentTime).toBe(10);
    }
    player.update({ timeline: "media" as const, position: 30, paused: true, rate: 0.5, anchorTime: now + 5000 });
    await player.serialize(async () => {});
    expect(video.currentTime).toBe(30);
    expect(video.paused).toBe(true);
    expect(video.playbackRate).toBe(0.5);
    video.currentTime = 29; video.paused = false; video.playbackRate = 1;
    now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.currentTime).toBe(29);
    expect(video.paused).toBe(true);
    expect(video.playbackRate).toBe(0.5);
    video.readyState = 3;
    now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.currentTime).toBe(30);
  } finally { player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("periodic correction waits for its target to be buffered; explicit host seeking can leave that range", async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const video = new Video(); video.readyState = 4; video.ranges = [[0, 11]];
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", false, new HTMLVideoMedia("https://media.test/video.mp4", "file"), vi.fn());
  try {
    player.calibrate(5100, 100, 100);
    player.update({ timeline: "media" as const, position: 10, paused: false, rate: 1, anchorTime: 5100 });
    await player.ready();
    for (let tick = 0; tick < 3; tick++) {
      now += 1000; await vi.advanceTimersByTimeAsync(1000);
      expect(video.currentTime).toBe(10);
    }
    expect(player.mediaState?.buffered).toEqual([[0, 11]]);
    video.ranges = [[0, 11], [13, 15]];
    now += 1000; await vi.advanceTimersByTimeAsync(1000);
    expect(video.currentTime).toBe(14);
    player.update({ timeline: "media" as const, position: 90, paused: true, rate: 0.5, anchorTime: now + 5000 });
    await player.serialize(async () => {});
    expect(video.currentTime).toBe(90);
    expect(video.paused).toBe(true);
    expect(video.playbackRate).toBe(0.5);
  } finally { player.close(); }
});

test("media parse errors survive readiness and late error events, while retirement ignores late failures", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia(() => Promise.reject(new Error("watch_mp4_parse_failed")), "file");
  const player = new WatchPlayer("room", false, media, vi.fn());
  await expect(player.ready()).rejects.toThrow("watch_mp4_parse_failed");
  expect(player.error).toBe("watch_mp4_parse_failed");
  const changed = vi.fn();
  let emit!: (event: WatchMediaEvent) => void;
  const state = { position: 0, paused: true, rate: 1, duration: 20, readyState: 4, ended: false, buffered: [[0, 20]] as [number, number][] };
  const port = {
    read: vi.fn(async () => state), patch: vi.fn(async () => {}), focus: vi.fn(async () => {}),
    listen: (listener: (event: WatchMediaEvent) => void) => { emit = listener; return () => {}; }, close: vi.fn(),
  };
  const latePlayer = new WatchPlayer("room", false, new AppPageMedia(port), changed);
  await latePlayer.ready();
  emit("error");
  await vi.advanceTimersByTimeAsync(0);
  expect(latePlayer.error).toBe("watch_media_failed");
  port.read.mockRejectedValueOnce(new Error("watch_mp4_parse_failed"));
  emit("error");
  await vi.advanceTimersByTimeAsync(0);
  expect(latePlayer.error).toBe("watch_mp4_parse_failed");
  let rejectRead!: (error: Error) => void;
  port.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
  emit("error");
  await vi.advanceTimersByTimeAsync(0);
  latePlayer.close();
  changed.mockClear();
  rejectRead(new Error("watch_source_failed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).not.toHaveBeenCalled();
  expect(latePlayer.error).toBe("watch_mp4_parse_failed");
  player.close();
});

test("a supported viewer rate restores alignment while a player failure survives the next anchor", async () => {
  vi.useFakeTimers();
  const state = { position: 2, paused: false, rate: 1, duration: 20, readyState: 4, ended: false, buffered: [] };
  const read = vi.fn(async () => ({ ...state })), patch = vi.fn(async value => { Object.assign(state, value); });
  let emit!: (event: WatchMediaEvent) => void;
  const player = new WatchPlayer("room", false, { read, patch, playbackRates: () => [1],
    ready: vi.fn(), listen: listener => { emit = listener; return () => {}; }, close: vi.fn() }, vi.fn());
  const anchor = async (rate: number, position = 0) => {
    player.update({ timeline: "media", position, paused: true, rate, anchorTime: 0 });
    await player.serialize(async () => {});
  };
  try {
    player.calibrate(0, 0, 0);
    await anchor(1.5, 20);
    expect(player.error).toBe("watch_media_unsupported");
    expect(patch).toHaveBeenCalledExactlyOnceWith({ position: 20, paused: true });
    await anchor(1, 4);
    expect(player.error).toBeNull();
    expect(patch).toHaveBeenCalledWith({ position: 4 });
    await anchor(1.5);
    read.mockRejectedValueOnce(new Error("watch_media_unsupported"));
    emit("error");
    await vi.advanceTimersByTimeAsync(0);
    await anchor(1);
    expect(player.error).toBe("watch_media_unsupported");
  } finally { player.close(); }
});

test("a paused aligned viewer observes three idle ticks without writes or UI notifications", async () => {
  vi.useFakeTimers();
  const state = { position: 12, rate: 1, paused: true, duration: 60, ended: false, readyState: 4, buffered: [] };
  const patch = vi.fn(), changed = vi.fn(), read = vi.fn(async () => state);
  const player = new WatchPlayer("room", false, { read, patch, ready: vi.fn(), listen: () => () => {}, close: vi.fn() }, changed);
  try {
    player.calibrate(0, 0, 0);
    player.update({ timeline: "media", position: 12, rate: 1, paused: true, anchorTime: 0 });
    await vi.advanceTimersByTimeAsync(0);
    patch.mockClear(); changed.mockClear(); read.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect([read.mock.calls.length, patch.mock.calls.length, changed.mock.calls.length]).toEqual([3, 0, 0]);
  } finally { player.close(); }
});
