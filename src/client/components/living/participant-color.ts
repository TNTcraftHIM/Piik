import { identityHash } from "../../lib/identity-hash";

// Identity alone owns the colour across the couch, chat and topology. Leave the
// upholstery/crown's amber range out; vary lightness and chroma independently.
export function participantColor(identity: string): string {
  // Avalanche the decorative hash so similar IDs do not cluster in one hue.
  let seed = identityHash(identity);
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b);
  seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35);
  seed = (seed ^ (seed >>> 16)) >>> 0;
  const hue = (140 + (seed & 0xffff) / 0xffff * 250) % 360;
  const lightness = 0.59 + ((seed >>> 16) & 255) / 255 * 0.18;
  const chroma = 0.11 + (seed >>> 24) / 255 * 0.08;
  return `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${hue.toFixed(4)})`;
}
