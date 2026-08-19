import { describe, expect, it } from "vitest";

import {
  applyViewerVolume,
  DEFAULT_VIEWER_VOLUME_STATE,
  setViewerVolume,
  toggleViewerMuted,
} from "../src/client/media/viewer-volume.ts";

describe("viewer page-local volume", () => {
  it("starts audible at full volume for each page load", () => {
    expect(DEFAULT_VIEWER_VOLUME_STATE).toEqual({
      volumePercent: 100,
      muted: false,
      lastNonZeroVolumePercent: 100,
    });
  });

  it("keeps the selected volume while mute is toggled", () => {
    const selected = setViewerVolume(DEFAULT_VIEWER_VOLUME_STATE, 64);
    const muted = toggleViewerMuted(selected);

    expect(muted).toEqual({
      volumePercent: 64,
      muted: true,
      lastNonZeroVolumePercent: 64,
    });
    expect(toggleViewerMuted(muted)).toEqual(selected);
  });

  it("mutes at zero and restores the last non-zero volume", () => {
    const selected = setViewerVolume(DEFAULT_VIEWER_VOLUME_STATE, 37);
    const zero = setViewerVolume(selected, 0);

    expect(zero).toEqual({
      volumePercent: 0,
      muted: true,
      lastNonZeroVolumePercent: 37,
    });
    expect(toggleViewerMuted(zero)).toEqual(selected);
  });

  it("automatically unmutes and bounds a non-zero slider value", () => {
    const muted = toggleViewerMuted(DEFAULT_VIEWER_VOLUME_STATE);

    expect(setViewerVolume(muted, 42)).toEqual({
      volumePercent: 42,
      muted: false,
      lastNonZeroVolumePercent: 42,
    });
    expect(setViewerVolume(muted, 120).volumePercent).toBe(100);
    expect(setViewerVolume(muted, Number.NaN).volumePercent).toBe(0);
  });

  it("synchronously applies state to the current media element", () => {
    const target = { volume: 1, muted: false };
    const zero = setViewerVolume(DEFAULT_VIEWER_VOLUME_STATE, 0);

    applyViewerVolume(target, zero);
    expect(target).toEqual({ volume: 0, muted: true });

    applyViewerVolume(target, toggleViewerMuted(zero));
    expect(target).toEqual({ volume: 1, muted: false });
  });
});
