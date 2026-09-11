import { useState } from "react";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";

export const WELCOME_LINES = [
  { key: "welcome.seat", symbols: ["couch", "heart"] },
  { key: "welcome.player", symbols: ["gamepad", "users"] },
  { key: "welcome.cut", symbols: ["clock", "clapperboard"] },
  { key: "welcome.quest", symbols: ["branch", "heart"] },
  { key: "welcome.snack", symbols: ["popcorn", "play"] },
  { key: "welcome.scene", symbols: ["clapperboard", "arrowRight"] },
  { key: "welcome.save", symbols: ["save", "moon"] },
  { key: "welcome.achievement", symbols: ["trophy", "heart"] },
  { key: "welcome.popcorn", symbols: ["zap", "popcorn"] },
  { key: "welcome.credits", symbols: ["clapperboard", "gift"] },
  { key: "welcome.replay", symbols: ["refresh", "users"] },
  { key: "welcome.guide", symbols: ["arrowRight", "couch"] },
  { key: "welcome.wander", symbols: ["mountain", "branch"] },
  { key: "welcome.witness", symbols: ["tv", "eye"] },
  { key: "welcome.discovery", symbols: ["bulb", "eye"] },
  { key: "welcome.party", symbols: ["cast", "users"] },
  { key: "welcome.director", symbols: ["clapperboard", "play"] },
  { key: "welcome.next", symbols: ["flag", "users"] },
  { key: "welcome.share", symbols: ["cast", "heart"] },
  { key: "welcome.seats", symbols: ["couch", "users"] },
] as const satisfies readonly { key: CopyKey; symbols: readonly [GlyphName, GlyphName] }[];

// Original 5x5 pseudo-letters; recurring ideas keep the same pixel word.
const PIXEL_LETTERS = [
  [31, 17, 21, 17, 31], [4, 14, 21, 4, 10], [17, 31, 4, 14, 4],
  [14, 10, 31, 4, 4], [17, 17, 31, 4, 14], [31, 4, 14, 17, 31],
  [4, 31, 10, 14, 17], [21, 14, 4, 14, 21], [31, 16, 23, 17, 31],
  [14, 4, 31, 17, 14], [17, 14, 4, 31, 4], [31, 1, 15, 8, 31],
];

function PixelWord({ symbol }: { symbol: GlyphName }) {
  const seed = Array.from(symbol).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return <svg width="40" height="14" viewBox="0 0 34 12" fill="currentColor" aria-hidden="true">
    {[0, 1, 2].map(letter => PIXEL_LETTERS[(seed * 7 + letter * 5) % PIXEL_LETTERS.length]!.map((row, y) =>
      [0, 1, 2, 3, 4].map(x => row & (1 << x)
        ? <rect key={`${letter}-${x}-${y}`} x={letter * 12 + x * 2} y={y * 2 + 1} width="1.5" height="1.5" rx=".3" />
        : null)))}
  </svg>;
}

export function WelcomeCipher({ line }: { line: number }) {
  const { symbols } = WELCOME_LINES[line]!;
  return <span className="lr-welcome-cipher" aria-hidden="true">
    <Glyph name={symbols[0]} size={18} /><PixelWord symbol={symbols[0]} />
    <i />
    <Glyph name={symbols[1]} size={18} /><PixelWord symbol={symbols[1]} />
  </span>;
}

/** One original opening line per visit; never a loading or connection claim. */
export function WelcomeLine() {
  const { t, vis } = useCopy();
  const [line] = useState(() => Math.floor(Math.random() * WELCOME_LINES.length));
  return <p className={`lr-welcome${vis ? " is-cipher" : ""}`} aria-hidden={vis || undefined}>
    {vis ? <WelcomeCipher line={line} /> : t(WELCOME_LINES[line]!.key)}
  </p>;
}
