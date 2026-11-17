/** Shared playback and source pickers use the same display name for a language tag. */
export function mediaLanguageLabel(language: string | undefined, locale: string): string {
  if (!language || language === "und") return "";
  try { return new Intl.DisplayNames([locale], { type: "language" }).of(language) ?? language; }
  catch { return language; }
}
