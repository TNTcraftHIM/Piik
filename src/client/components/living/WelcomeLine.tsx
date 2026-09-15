import { useRef } from "react";
import { locales, type WelcomeEntry } from "../../locales";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useRotatingText } from "../../ui/use-text-rotation";

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

export function WelcomeCipher({ symbols }: Pick<WelcomeEntry, "symbols">) {
  return <span className="lr-welcome-cipher" aria-hidden="true">
    <Glyph name={symbols[0]} size={18} /><PixelWord symbol={symbols[0]} />
    <i />
    <Glyph name={symbols[1]} size={18} /><PixelWord symbol={symbols[1]} />
  </span>;
}

/** Welcome decoration never describes loading or connection progress. */
export function WelcomeLine({ still = false }: { still?: boolean }) {
  const { lang, vis } = useCopy();
  const element = useRef<HTMLParagraphElement>(null);
  const line = useRotatingText<WelcomeEntry>(locales[lang].playful.welcome, lang, element, still);
  if (!line) return null;
  return <p ref={element} className={`lr-welcome${vis ? " is-cipher" : ""}`} aria-hidden={vis || undefined}>
    {vis ? <WelcomeCipher symbols={line.symbols} /> : line.text}
  </p>;
}
