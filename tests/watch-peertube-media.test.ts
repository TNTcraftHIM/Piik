import { afterEach, expect, test, vi } from "vitest";
import { PeerTubeMedia } from "../src/client/channel/watch-peertube-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { peerTubeOrigin } from "../src/client/channel/watch-peertube-source";

const uuid = "3a82b2ed-b8b3-468a-a27f-d83ad37625ca";
const metadata = () => Response.json({ uuid, privacy: { id: 1 }, isLive: false });
function fixture(suspendWhenHidden = false) {
  vi.useFakeTimers();
  const window = Object.assign(new EventTarget(), { setTimeout });
  const frame = { contentWindow: { postMessage: vi.fn() }, setAttribute: vi.fn(), remove: vi.fn(), src: "" };
  const element = Object.assign(new EventTarget(), { isConnected: true, append: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", { createElement: (tag: string) => tag === "div" ? element : frame });
  const media = new PeerTubeMedia(uuid, suspendWhenHidden);
  const packet = (body: object, source: object = frame.contentWindow, origin = peerTubeOrigin) => {
    window.dispatchEvent(Object.assign(new Event("message"), { origin, source, data: JSON.stringify(body) }));
  };
  return { media, frame, element, packet };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each(["close", "deadline"])("%s retires a metadata fetch even when its response arrives later", async reason => {
  const { media, element } = fixture();
  let deliver!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { deliver = resolve; });
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", (_: string, options: RequestInit) => { signal = options.signal!; return response; });
  const events: string[] = [];
  media.listen(event => events.push(event));
  media.presentation.setVisible(true);
  const readiness = expect(media.ready(new AbortController().signal)).rejects.toThrow();
  if (reason === "close") media.close(); else await vi.runAllTimersAsync();
  await readiness;
  expect(signal.aborted).toBe(true);
  deliver(metadata());
  await vi.advanceTimersByTimeAsync(0);
  expect(element.append).not.toHaveBeenCalled();
  expect(media.sourceURL).toBe("");
  media.close();
  expect(events.filter(event => event === "closed")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("playing progress proves readiness with optional numeric or string duration", async () => {
  const { media, frame, packet } = fixture();
  vi.stubGlobal("fetch", async () => metadata());
  media.presentation.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  const scope = new URL(frame.src).searchParams.get("scope");
  frame.contentWindow.postMessage.mockImplementation((raw: string) => {
    const { id, method } = JSON.parse(raw);
    const results: Record<string, unknown> = { getPlaybackRates: [1], getCurrentTime: 22.3, getPlaybackRate: 1, isPlaying: true };
    packet({ id, result: results[method.split("::")[1]] });
  });
  packet({ method: scope + "::ready", params: true });
  const watch = new WatchPlayer("room", false, media, () => {});
  try {
    watch.calibrate(0, performance.now());
    await watch.sample();
    expect(watch.waitingForPicture).toBe(true);
    expect(watch.hasUsablePicture).toBe(false);
    const status = { method: scope + "::playbackStatusUpdate", params: { playbackState: "playing", position: 22.3 } };
    packet(status);
    await media.ready(new AbortController().signal);
    await watch.sample();
    expect(watch.hasUsablePicture).toBe(true);
    expect(await media.read()).toMatchObject({ readyState: 3, duration: null });
    for (const [duration, expected] of [["171.37499", 171.37499], [120, 120], ["", 120], [true, 120]] as const) {
      packet({ ...status, params: { ...status.params, duration } });
      expect(await media.read()).toMatchObject({ readyState: 3, duration: expected });
    }
  } finally { watch.close(); }
});

test("closing pending commands rejects with AbortError and retires their replies", async () => {
  const { media, frame, packet } = fixture();
  vi.stubGlobal("fetch", async () => metadata());
  const events: string[] = [];
  media.listen(event => events.push(event));
  media.presentation.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  const scope = new URL(frame.src).searchParams.get("scope");
  const ready = { method: scope + "::ready", params: true };
  packet(ready, {}); packet(ready, frame.contentWindow, "https://unrelated.example");
  packet({ ...ready, method: "another::ready" });
  expect(frame.contentWindow.postMessage).not.toHaveBeenCalled();
  packet(ready);
  const reading = expect(media.read()).rejects.toMatchObject({ name: "AbortError" });
  const sent = frame.contentWindow.postMessage.mock.calls.map(([raw, target]) => {
    expect(target).toBe(peerTubeOrigin);
    return JSON.parse(raw);
  });
  expect(sent.map(p => p.method.split("::")[1])).toEqual(["getPlaybackRates","getCurrentTime","isPlaying","getPlaybackRate"]);
  media.close();
  for (const request of sent) packet({id:request.id,result:1});
  packet({ method: scope + "::playbackStatusChange", params: "playing" });
  await reading;
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["visibility-resumed","closed"]);
  expect(vi.getTimerCount()).toBe(0);
});
test.each(["event", "reply", "silent"] as const)("PeerTube handshake uses its startup deadline with %s", async result => {
  const { media, frame, packet } = fixture();
  vi.stubGlobal("fetch", async () => metadata());
  const events: string[] = [];
  media.listen(event => events.push(event));
  media.presentation.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  const scope = new URL(frame.src).searchParams.get("scope");
  packet({ method: scope + "::__ready", params: { type: "publish-request" } });
  const query = frame.contentWindow.postMessage.mock.calls.map(([raw]) => JSON.parse(raw))
    .find(request => request.method === scope + "::isReady");
  expect(query).toBeDefined();
  frame.contentWindow.postMessage.mockImplementation((raw: string) => {
    const request = JSON.parse(raw);
    if (request.method === scope + "::getPlaybackRates") packet({ id: request.id, result: [1] });
  });
  if (result === "event") packet({ method: scope + "::ready", params: true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(frame.remove).not.toHaveBeenCalled();
  if (result === "reply") packet({ id: query.id, result: true });
  await vi.advanceTimersByTimeAsync(14000);
  if (result === "silent") {
    expect(events).toContain("error");
    expect(frame.remove).toHaveBeenCalledOnce();
  } else {
    expect(events).toContain("loadedmetadata");
    expect(events).not.toContain("error");
    expect(frame.remove).not.toHaveBeenCalled();
  }
  media.close();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["playbackStatusChange", "playbackStatusUpdate"])("a hidden receiver pauses a late %s", async method => {
  const { media, frame, packet } = fixture(true);
  vi.stubGlobal("fetch", async () => metadata());
  try {
    media.presentation.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    const scope = new URL(frame.src).searchParams.get("scope");
    frame.contentWindow.postMessage.mockImplementation((raw: string) => {
      const request = JSON.parse(raw);
      packet({ id: request.id, result: request.method === scope + "::getPlaybackRates" ? [1] : null });
    });
    packet({ method: scope + "::ready", params: true });
    media.presentation.setVisible(false);
    packet({ method: scope + "::" + method, params: method === "playbackStatusChange" ? "playing"
      : { playbackState: "playing", position: 1 } });
    expect(frame.contentWindow.postMessage.mock.calls.map(([raw]) => JSON.parse(raw).method)).toContain(scope + "::pause");
  } finally { media.close(); }
});
