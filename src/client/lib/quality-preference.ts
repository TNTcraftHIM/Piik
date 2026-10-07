import {
  DEFAULT_QUALITY_SETTINGS,
  qualitySettingsSchema,
  type QualitySettings,
} from "../../shared/protocol";

const STORAGE_KEY = "piik:quality-preference:v1";

export function readPreferredQuality(): QualitySettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const result = qualitySettingsSchema.safeParse(stored ? JSON.parse(stored) : null);
    if (result.success) return result.data;
  } catch {
    // Storage may be unavailable; sharing still works with session settings.
  }
  return { ...DEFAULT_QUALITY_SETTINGS };
}

export function savePreferredQuality(settings: QualitySettings): void {
  const result = qualitySettingsSchema.safeParse(settings);
  if (!result.success) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.data));
  } catch {
    // Saving a preference must not turn an applied capture change into a failure.
  }
}
