// Room data is transient and bounded. It never describes a media route.
export const MAX_CHAT_CODE_POINTS = 280;
export const INTERACTION_INTERVAL_MS = 800;
export const REACTION_DURATION_MS = 2400;
export const REACTION_IDS = ["wave", "heart", "clap", "laugh", "wow", "party", "fire", "eyes", "star", "sleep", "tomato", "poop"] as const;
export type ReactionId = typeof REACTION_IDS[number];
export const isThrow = (reaction: ReactionId) => reaction === "tomato" || reaction === "poop";
export const REACTION_GLYPHS: Record<ReactionId, string> = {
  wave: "👋", heart: "❤️", clap: "👏", laugh: "😂", wow: "🤯", party: "🎉",
  fire: "🔥", eyes: "👀", star: "⭐", sleep: "😴", tomato: "🍅", poop: "💩",
};

const forbiddenText = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\uD800-\uDFFF]/u;
export function normalizeChatText(value: string): string | null {
  if (forbiddenText.test(value)) return null;
  const text = value.normalize("NFC").trim();
  return text && Array.from(text).length <= MAX_CHAT_CODE_POINTS ? text : null;
}
