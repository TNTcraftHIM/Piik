import { M3U8Parser, PlaylistLevelType } from "hls.js";
import type Hls from "hls.js";
import { expect, test } from "vitest";
import { WatchHlsTimeline } from "../src/client/channel/watch-hls-timeline";
import { watchSeekPosition } from "../src/client/channel/watch-media";

const epoch = 1794744000;

test("pointer and directional keyboard seeks around a program gap map to playable media", () => {
  const { hls, video, details } = fixture(0, epoch);
  details.fragments = [
    { start: 0, end: 8, programDateTime: epoch * 1000, endProgramDateTime: (epoch + 8) * 1000 },
    { start: 8, end: 12, programDateTime: (epoch + 12) * 1000, endProgramDateTime: (epoch + 16) * 1000 },
  ];
  const timeline = new WatchHlsTimeline(hls, "program");
  const ranges = timeline.read(video)!.live.seekable;
  for (const [requested, expected] of [[7.99, 7.99], [8, 7.999], [9, 7.999], [10, 8], [11, 8], [12, 8], [16, 12]]) {
    expect(timeline.localPosition(watchSeekPosition(epoch + requested, ranges))).toBeCloseTo(expected, 5);
  }
  expect(timeline.localPosition(watchSeekPosition(epoch + 8.1, ranges, 1))).toBe(8);
  expect(timeline.localPosition(watchSeekPosition(epoch + 11.9, ranges, -1))).toBeCloseTo(7.999, 5);
});
function fixture(start: number, programStart: number, live = true, liveSyncPosition = start + 3) {
  const video = { currentTime: start + 2, buffered: { length: 1, start: () => start, end: () => start + 6 } } as unknown as HTMLVideoElement;
  const details = { live, fragments: [{ start, end: start + 6, programDateTime: programStart * 1000, endProgramDateTime: (programStart + 6) * 1000 }] };
  const hls = { latestLevelDetails: details, liveSyncPosition,
    get playingDate() { return new Date((programStart + video.currentTime - start) * 1000); } } as unknown as Hls;
  return { video, details, hls };
}

test("two initial playlist windows map the same program point independently of local seconds", () => {
  const host = fixture(6, epoch + 6), viewer = fixture(0, epoch + 6);
  const hostTime = new WatchHlsTimeline(host.hls), viewerTime = new WatchHlsTimeline(viewer.hls, "program");
  expect(hostTime.read(host.video)?.position).toBe(epoch + 8);
  expect(viewerTime.read(viewer.video)?.position).toBe(epoch + 8);
  expect(viewerTime.localPosition(epoch + 9)).toBe(3);
  expect(hostTime.read(host.video)?.live).toEqual({ active: true, seekable: [[epoch + 6, epoch + 12]], syncPosition: epoch + 9 });
  expect(viewerTime.read(viewer.video)?.buffered).toEqual([[epoch + 6, epoch + 12]]);
});

test("ENDLIST keeps program coordinates for existing and newly joined players", () => {
  const input = fixture(0, epoch + 20), timeline = new WatchHlsTimeline(input.hls);
  expect(timeline.read(input.video)?.position).toBe(epoch + 22);
  input.details.live = false;
  expect(timeline.read(input.video)?.live).toEqual({ active: false, seekable: [[epoch + 20, epoch + 26]], syncPosition: null });
  expect(timeline.localPosition(epoch + 26)).toBe(6);
  expect(new WatchHlsTimeline(input.hls, "program").read(input.video)?.position).toBe(epoch + 22);
  expect(new WatchHlsTimeline(input.hls, "media").read(input.video)).toBeNull();
});

test("expired positions and missing source dates do not invent a new time origin", () => {
  const input = fixture(0, epoch + 20), timeline = new WatchHlsTimeline(input.hls, "program");
  expect(() => timeline.localPosition(epoch + 19)).toThrow("watch_live_position_unavailable");
  input.details.fragments[0].programDateTime = NaN;
  expect(() => timeline.read(input.video)).toThrow("watch_live_timeline_unsupported");
});

test("a seek uses the target fragment mapping while the prior playing-date observation catches up", () => {
  const input = fixture(0, epoch + 20), timeline = new WatchHlsTimeline(input.hls, "program");
  Object.defineProperty(input.hls, "playingDate", { value: new Date((epoch + 2) * 1000) });
  expect(timeline.read(input.video)?.position).toBe(epoch + 22);
});

test("a shared media boundary uses the next fragment's program date", () => {
  const { hls, video, details } = fixture(0, epoch, true, 6);
  details.fragments.push({ start: 6, end: 12, programDateTime: (epoch + 10) * 1000, endProgramDateTime: (epoch + 16) * 1000 });
  const timeline = new WatchHlsTimeline(hls, "program");

  video.currentTime = timeline.localPosition(epoch + 10);
  expect(video.currentTime).toBe(6);
  expect(timeline.read(video)?.position).toBe(epoch + 10);
  expect(timeline.read(video)?.live.syncPosition).toBe(epoch + 10);
  expect(() => timeline.localPosition(epoch + 6)).toThrow("watch_live_position_unavailable");
  expect(() => timeline.localPosition(epoch + 8)).toThrow("watch_live_position_unavailable");
  video.currentTime = timeline.localPosition(epoch + 16);
  expect(timeline.read(video)?.position).toBe(epoch + 16);
});

test("EXT-X-GAP keeps program time but excludes missing media at either edge and inside the window", () => {
  const playlist = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-PROGRAM-DATE-TIME:" + new Date(epoch * 1000).toISOString(),
    ...[true, false, true, false, true].flatMap((gap, i) => [...(gap ? ["#EXT-X-GAP"] : []), "#EXTINF:2,", i + ".ts"])].join("\n");
  const details = M3U8Parser.parseLevelPlaylist(playlist, "https://example.test/live.m3u8", 0, PlaylistLevelType.MAIN, 0, null);
  const { hls, video } = fixture(0, epoch, true, 5);
  Object.defineProperty(hls, "latestLevelDetails", { value: details });
  const timeline = new WatchHlsTimeline(hls, "program");
  const { live, buffered } = timeline.read(video)!;
  expect(live.seekable).toEqual([[epoch + 2, epoch + 3.999], [epoch + 6, epoch + 7.999]]);
  expect(buffered).toEqual([[epoch + 2, epoch + 4]]);
  expect(live.syncPosition).toBeNull();
  for (const offset of [0, 4, 5, 8, 10])
    expect(() => timeline.localPosition(epoch + offset)).toThrow("watch_live_position_unavailable");
  expect(timeline.localPosition(watchSeekPosition(epoch + 5, live.seekable, 1))).toBe(6);
  for (const offset of [3.9, 4, 6.1]) {
    video.currentTime = offset;
    expect(timeline.read(video)!.position).toBeCloseTo(epoch + offset, 5);
  }
});
