import { identityHash } from "../../lib/identity-hash";

// Identity alone owns the colour across the couch, chat and topology. Cool hues
// avoid the upholstery/crown; perceptual lightness keeps both themes readable.
export function participantColor(identity: string): string {
  // Avalanche the decorative hash so similar IDs do not cluster in one hue.
  let seed = identityHash(identity);
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b);
  seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35);
  seed = (seed ^ (seed >>> 16)) >>> 0;
  const hue = 145 + seed / 0xffffffff * 195;
  const lightness = 0.62 + (seed & 255) / 255 * 0.06;
  return `oklch(${lightness.toFixed(4)} 0.14 ${hue.toFixed(4)})`;
}
