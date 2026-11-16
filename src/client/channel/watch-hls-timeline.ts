import type Hls from "hls.js";
import type { WatchTimeline } from "./protocol";
import type { WatchLiveWindow } from "./watch-media";

/** HLS owns segment time and sliding. These public facts map into one activity coordinate. */
export class WatchHlsTimeline {
  private coordinate: WatchTimeline | undefined;
  constructor(private hls: Hls, expected?: WatchTimeline) { this.coordinate = expected; }

  read(video: HTMLVideoElement): { position: number; buffered: [number, number][]; live: WatchLiveWindow } | null {
    const details = this.hls.latestLevelDetails;
    if (!details) return null;
    this.coordinate ??= details.live ? "program" : "media";
    if (this.coordinate === "media") {
      if (details.live) throw new Error("watch_live_timeline_unsupported");
      return null;
    }
    const fragments = details.fragments;
    if (!fragments.length || fragments.some(fragment => !Number.isFinite(fragment.programDateTime)
      || !Number.isFinite(fragment.endProgramDateTime) || fragment.endProgramDateTime! <= fragment.programDateTime!))
      throw new Error("watch_live_timeline_unsupported");
    for (let i = 1; i < fragments.length; i++)
      if (fragments[i].programDateTime! < fragments[i - 1].endProgramDateTime! - 1) throw new Error("watch_live_timeline_unsupported");
    const date = this.hls.playingDate?.getTime();
    const position = this.programPosition(video.currentTime) ?? (date !== undefined && Number.isFinite(date) ? date / 1000 : null);
    if (position === null) throw new Error("watch_live_timeline_unavailable");
    const buffered: [number, number][] = [];
    for (let i = 0; i < video.buffered.length; i++) for (const fragment of fragments) {
      const start = Math.max(video.buffered.start(i), fragment.start), end = Math.min(video.buffered.end(i), fragment.end);
      if (end > start) buffered.push([fragment.programDateTime! / 1000 + start - fragment.start,
        fragment.programDateTime! / 1000 + end - fragment.start]);
    }
    return { position, buffered, live: { active: details.live,
      seekable: fragments.map(fragment => [fragment.programDateTime! / 1000, fragment.endProgramDateTime! / 1000]),
      syncPosition: details.live && this.hls.liveSyncPosition !== null ? this.programPosition(this.hls.liveSyncPosition) : null } };
  }

  private programPosition(position: number): number | null {
    const fragment = this.hls.latestLevelDetails?.fragments.find(fragment => fragment.start <= position && position <= fragment.end);
    return fragment && Number.isFinite(fragment.programDateTime) ? fragment.programDateTime! / 1000 + position - fragment.start : null;
  }

  localPosition(position: number): number {
    if (this.coordinate !== "program") return position;
    const fragment = this.hls.latestLevelDetails?.fragments.find(fragment => fragment.programDateTime !== null
      && fragment.endProgramDateTime !== null && fragment.programDateTime / 1000 <= position && position <= fragment.endProgramDateTime / 1000);
    if (!fragment) throw new Error("watch_live_position_unavailable");
    return fragment.start + position - fragment.programDateTime! / 1000;
  }
}
