import Hls, { LoaderContextType } from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelSession } from "../src/client/channel/session";
import type { Stage } from "../src/client/channel/stage";
import { HTMLVideoMedia, createResourceWatchMedia } from "../src/client/channel/watch-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function element() {
  return Object.assign(new EventTarget(), { currentTime: 0, duration: 6, paused: true, playbackRate: 1, readyState: 0,
    error: null as { code: number; message: string } | null, src: "", videoWidth: 0, videoHeight: 0,
    buffered: { length: 0, start: () => 0, end: () => 0 }, playsInline: true, preload: "auto",
    play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), remove: vi.fn(), removeAttribute: vi.fn() });
}

function nextHlsAttachment(): Promise<Hls> {
  vi.spyOn(Hls, "isSupported").mockReturnValue(true);
  vi.spyOn(Hls.prototype, "loadSource").mockImplementation(() => {});
  return new Promise(resolve => {
    vi.spyOn(Hls.prototype, "attachMedia").mockImplementation(function (this: Hls) {
      resolve(this);
    });
  });
}

test.each([
  { code: "watch_path_unavailable", copy: "channel.error.roomCommunicationFailed", connectionHelp: true },
  { code: "watch_source_unavailable", copy: "watch.forward.sourceUnavailable", connectionHelp: false },
  { code: "watch_media_timeout", copy: "watch.forward.readTimeout", connectionHelp: false },
  { code: "watch_resource_limit", copy: "watch.forward.unsupported", connectionHelp: false },
])("a known peer $code stays actionable after the media element reports unsupported source", async value => {
  const attached = nextHlsAttachment();
  const video = element(); vi.stubGlobal("document", { createElement: () => video });
  const media = createResourceWatchMedia({ resourceId: crypto.randomUUID(), format: "hls" },
    async () => { throw Error("unused_read"); }, { hlsDeadlineOwner: "reader" });
  const player = new WatchPlayer("owned", false, media, () => {});
  try {
    const hls = await attached;
    hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR,
      details: Hls.ErrorDetails.FRAG_LOAD_ERROR, response: { code: 0, text: value.code } } as never);
    await expect.poll(() => player.error).toBe(value.code);
    // A platform MediaError is less precise than this already-confirmed reader failure.
    video.error = { code: 4, message: "https://owned.test/not-a-real-private-url" };
    video.dispatchEvent(new Event("error"));
    await expect.poll(() => player.error).toBe(value.code);
    await expect(media.read()).rejects.toThrow(value.code);
    expect(channelErrorPresentation(player.error, key => key)).toEqual({ message: value.copy, connectionHelp: value.connectionHelp });
    expect(player.error).not.toContain("https:");
  } finally { player.close(); }
});

test.each([
  { status: 401, details: Hls.ErrorDetails.FRAG_LOAD_ERROR, type: Hls.ErrorTypes.NETWORK_ERROR, expected: "watch_media_access_denied" },
  { status: 403, details: Hls.ErrorDetails.FRAG_LOAD_ERROR, type: Hls.ErrorTypes.NETWORK_ERROR, expected: "watch_media_access_denied" },
  { status: 0, details: Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR, type: Hls.ErrorTypes.MEDIA_ERROR, expected: "watch_media_unsupported" },
])("typed HLS $status/$details wins over generic platform source rejection", async value => {
  const attached = nextHlsAttachment();
  const video = element(); vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://owned.test/manifest.m3u8", "hls"),player = new WatchPlayer("owned", false, media, () => {});
  try {
    const hls = await attached;
    video.error = { code: 4, message: "platform source rejection" };
    hls.trigger(Hls.Events.ERROR, { fatal: true, type: value.type, details: value.details, response: { code: value.status, text: "" } } as never);
    await expect.poll(() => player.error).toBe(value.expected);
    expect(channelErrorPresentation(player.error, key => key).connectionHelp).toBe(false);
  } finally { player.close(); }
});

test.each([false, true])("initial HLS readiness uses the current failure with an older read in flight (cancelled: %s)", async cancelled => {
  const attached = nextHlsAttachment();
  const video = element();
  vi.stubGlobal("document", { createElement: () => video });
  const media = createResourceWatchMedia({ resourceId: crypto.randomUUID(), format: "hls" },
    async () => { throw Error("unused_read"); }, { hlsDeadlineOwner: "reader" });
  const player = new WatchPlayer("owned", false, media, () => {});
  const controller = new AbortController();
  const read = media.read.bind(media);
  let releaseRead!: () => void;
  const olderRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let markSnapshotTaken!: () => void;
  const snapshotTaken = new Promise<void>(resolve => { markSnapshotTaken = resolve; });
  try {
    const hls = await attached;
    video.readyState = 2;
    vi.spyOn(media, "read").mockImplementationOnce(async () => {
      const snapshot = await read();
      markSnapshotTaken();
      await olderRead;
      return snapshot;
    });
    const result = player.ready(controller.signal).catch(error => error);
    await snapshotTaken;
    hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR,
      details: Hls.ErrorDetails.FRAG_LOAD_ERROR, response: { code: 0, text: "watch_source_unavailable" } } as never);
    if (cancelled) controller.abort();
    await expect.poll(() => player.error).toBe("watch_source_unavailable");
    releaseRead();
    await expect(result).resolves.toMatchObject(cancelled ? { name: "AbortError" } : { message: player.error });
  } finally { releaseRead(); player.close(); }
});

test("actual Session explicit peer command retains the admitted root and reader binding after direct failure", async () => {
  const root = { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" as const };
  const activity = { id: "owned-published", roomId: "owned-room", source: { kind: "website", url: "https://owned.test/official", mediaUrl: "https://owned.test/direct.mp4" }, byteSource: root, playback: { timeline: "media", paused: true, position: 2, rate: 1, anchorTime: 1000 } };
  const old = new WatchPlayer(activity.roomId, false, { ready: async () => {}, read: async () => ({ readyState: 0, position: 0, paused: true, rate: 1, duration: 6, ended: false, buffered: [] }), patch: async () => {}, listen: () => () => {}, close: vi.fn() }, () => {});
  old.error = "watch_media_unavailable";
  const commands: unknown[] = [];
  const read = vi.fn(async () => { throw Error("watch_source_unavailable"); });
  // Public joinWatch is an instance field; construct the actual Session without starting
  // a socket, then replace only its owned authority/I/O boundaries with controlled state.
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("location", { origin: "https://owned.test", hash: "" });
  vi.stubGlobal("history", { state: null });
  vi.stubGlobal("document", { createElement: () => element() });
  const attached = nextHlsAttachment();
  const session = new ChannelSession();
  const view = session.getSnapshot();
  const request = vi.fn(async (command: unknown, reply?: (value: unknown) => void) => {
    commands.push(command);reply?.({ type: "room_reply", result: { type: "watch_ready", serverTime: 1000 } });
  });
  const stage = (session as unknown as { stage(roomId: string): Stage }).stage(activity.roomId);
  stage.useWatch(activity.id, old);
  Object.assign(session, { view: { ...view, state: { watchActivities: [activity], publications: [], channel: { rooms: [] } } }, watchBytes: { read }, request });
  try {
    await session.joinWatch(activity.id, "peer");
    expect(commands).toEqual([{ type: "join_watch", roomId: activity.roomId, id: activity.id, mode: "peer" }]);
    const player = session.getSnapshot().watchPlayers.get(activity.id)!;
    expect(player.mode).toBe("peer");expect(player).not.toBe(old);
    const hls = await attached;
    const Loader = hls.config.loader,loader = new Loader(hls.config),failed=vi.fn();
    loader.load({ url: `https://watch-media.invalid/${root.resourceId}`, responseType: "arraybuffer", type: LoaderContextType.MANIFEST }, { loadPolicy: { maxTimeToFirstByteMs: 1000, maxLoadTimeMs: 1000 } } as never,
      { onError: failed, onSuccess: vi.fn(), onTimeout: vi.fn() } as never);
    await expect.poll(() => read.mock.calls.length).toBe(1);
    expect(read.mock.calls[0]).toEqual([activity.roomId, activity.id, root, root.resourceId, 0, 65536, expect.any(AbortSignal)]);
    await expect.poll(() => failed.mock.calls.length).toBe(1);
    expect(failed.mock.calls[0][0]).toEqual({ code: 0, text: "watch_source_unavailable" });
    hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR,
      details: Hls.ErrorDetails.FRAG_LOAD_ERROR, response: failed.mock.calls[0][0] } as never);
    await expect.poll(() => player.error).toBe("watch_source_unavailable");
    loader.destroy();
    expect(activity.byteSource).toBe(root);
    expect(old.error).toBe("watch_media_unavailable");
  } finally { stage.close(); }
});

test("a generic append failure still uses a proven platform decode error", async () => {
  const attached = nextHlsAttachment();
  const video=element();video.error={code:3,message:"platform decode error"};vi.stubGlobal("document",{createElement:()=>video});
  const media=new HTMLVideoMedia("https://owned.test/manifest.m3u8","hls"),player=new WatchPlayer("owned",false,media,()=>{});
  try{
    const hls = await attached;
    hls.trigger(Hls.Events.ERROR,{fatal:true,type:Hls.ErrorTypes.MEDIA_ERROR,details:Hls.ErrorDetails.BUFFER_APPEND_ERROR}as never);
    await expect.poll(()=>player.error).toBe("watch_media_decode_failed");
  }finally{player.close()}
});
