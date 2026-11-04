import { expect, it } from "vitest";
import { DEFAULT_QUALITY_SETTINGS, qualitySettingsSchema } from "../src/shared/protocol.js";

const qualitySettings = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "maintain-resolution",
} as const;

const qualitySettingsWithAudio = {
  ...qualitySettings,
  maxAudioBitrate: 128000,
} as const;

const legacyCodecQualitySettings = {
  ...qualitySettings,
  videoCodec: "vp8",
} as const;

it("separates numeric requests from capture implementation limits", () => {
  expect(DEFAULT_QUALITY_SETTINGS).not.toHaveProperty("videoCodec");
  expect(
    qualitySettingsSchema.safeParse(qualitySettings).success,
  ).toBe(true);
  expect(
    qualitySettingsSchema.safeParse(qualitySettingsWithAudio).success,
  ).toBe(true);
  expect(
    qualitySettingsSchema.safeParse({ ...qualitySettings, resolution: { width: 854, height: 480 } }).success,
  ).toBe(true);
  for (const maxAudioBitrate of [
    6_000, 96_000, 256_000, 320_000, 510_000,
  ] as const) {
    expect(
      qualitySettingsSchema.safeParse({ ...qualitySettings, maxAudioBitrate }).success,
    ).toBe(true);
  }
  for (const next of [
    { ...qualitySettings, resolution: { width: 16384, height: 8192 } },
    { ...qualitySettings, resolution: { width: 1921, height: 1081 } },
    { ...qualitySettings, maxFramerate: 14 },
    { ...qualitySettings, maxFramerate: 61 },
    { ...qualitySettings, maxFramerate: 30.5 },
    { ...qualitySettings, maxBitrate: 1_999_999 },
    { ...qualitySettings, maxBitrate: 12_000_001 },
  ]) expect(qualitySettingsSchema.safeParse(next).success).toBe(true);
  for (const invalid of [
    { ...qualitySettings, resolution: "2160p" },
    { ...qualitySettings, resolution: { width: 0x1_0000_0000, height: 1080 } },
    { ...qualitySettings, maxFramerate: 0 },
    { ...qualitySettings, maxFramerate: Infinity },
    { ...qualitySettings, maxFramerate: Number.MAX_SAFE_INTEGER + 1 },
    { ...qualitySettings, maxBitrate: 0 },
    { ...qualitySettings, maxBitrate: 0x1_0000_0000 },
    { ...qualitySettings, maxBitrate: 5_000_000.5 },
    { ...qualitySettings, degradationPreference: "automatic" },
    legacyCodecQualitySettings,
    { ...qualitySettings, maxAudioBitrate: "lossless" },
    { ...qualitySettings, maxAudioBitrate: "music" },
    { ...qualitySettings, maxAudioBitrate: 0 },
    { ...qualitySettings, maxAudioBitrate: 5_999 },
    { ...qualitySettings, maxAudioBitrate: 510_001 },
    { ...qualitySettings, maxAudioBitrate: 128_000.5 },
    { ...qualitySettings, maxAudioBitrate: null },
    { ...qualitySettings, maxAudioBitrate: 960_000 },
    { ...qualitySettings, codec: "video/VP9" },
  ]) {
    expect(
      qualitySettingsSchema.safeParse(invalid).success,
    ).toBe(false);
  }
  const { maxFramerate: _missing, ...missingField } = qualitySettings;
  expect(
    qualitySettingsSchema.safeParse(missingField).success,
  ).toBe(false);
});
