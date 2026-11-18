import type Hls from "hls.js";
import { expect, test } from "vitest";
import { WatchHlsTimeline } from "../src/client/channel/watch-hls-timeline";

const epoch = 1794744000;
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
