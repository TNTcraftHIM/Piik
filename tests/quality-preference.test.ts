import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import { readPreferredQuality, savePreferredQuality } from "../src/client/lib/quality-preference";

afterEach(() => vi.unstubAllGlobals());

describe("sharing quality preference", () => {
  it("retains explicit picture and audio settings across reads", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } });
    expect(readPreferredQuality()).toEqual(DEFAULT_QUALITY_SETTINGS);
    const chosen = { ...DEFAULT_QUALITY_SETTINGS, resolution: { width: 2560, height: 1440 } as const,
      maxFramerate: 60, maxBitrate: 10_000_000, degradationPreference: "maintain-resolution" as const,
      maxAudioBitrate: 256_000 };
    savePreferredQuality(chosen);
    expect(readPreferredQuality()).toEqual(chosen);
    savePreferredQuality({ ...chosen, maxBitrate: -1 });
    expect(readPreferredQuality()).toEqual(chosen);
  });

  it.each(["{", "null", "{}", JSON.stringify({ ...DEFAULT_QUALITY_SETTINGS, resolution: "2160p" })])(
    "uses valid defaults when saved settings are malformed or unsupported: %s", stored => {
      vi.stubGlobal("window", { localStorage: { getItem: () => stored } });
      expect(readPreferredQuality()).toEqual(DEFAULT_QUALITY_SETTINGS);
    },
  );

  it("keeps sharing usable when Browser storage is denied", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("storage denied"); } });
    expect(readPreferredQuality()).toEqual(DEFAULT_QUALITY_SETTINGS);
    expect(() => savePreferredQuality(DEFAULT_QUALITY_SETTINGS)).not.toThrow();
  });

  it("uses supported defaults without overwriting a preference from a stronger implementation", () => {
    const stored = JSON.stringify({ ...DEFAULT_QUALITY_SETTINGS, maxFramerate: 480, maxBitrate: 40_000_000 });
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => stored, setItem } });
    expect(readPreferredQuality()).toEqual(DEFAULT_QUALITY_SETTINGS);
    expect(setItem).not.toHaveBeenCalled();
  });
});
