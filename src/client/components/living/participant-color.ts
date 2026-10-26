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
  return oklchToRgb(Number(lightness.toFixed(4)), Number(chroma.toFixed(4)), Number(hue.toFixed(4)));
}

// Standard conversion, with simple constant-lightness/hue chroma reduction.
// https://www.w3.org/TR/css-color-4/#color-conversion-code
// https://www.w3.org/TR/css-color-4/#chroma-reduction
function oklchToRgb(lightness: number, chroma: number, hue: number): string {
  const angle = hue * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const linearRgb = (c: number) => {
    const a = c * cos, b = c * sin;
    const l = (lightness + .3963377773761749 * a + .2158037573099136 * b) ** 3;
    const m = (lightness - .1055613458156586 * a - .0638541728258133 * b) ** 3;
    const s = (lightness - .0894841775298119 * a - 1.2914855480194092 * b) ** 3;
    return [
      4.076741636075958 * l - 3.3077115392580616 * m + .2309699031821043 * s,
      -1.2684379732850317 * l + 2.6097573492876887 * m - .34131937600265727 * s,
      -.004196076138675564 * l - .7034186179359363 * m + 1.7076146940746117 * s,
    ];
  };
  const inGamut = (channels: number[]) => channels.every(channel => channel >= 0 && channel <= 1);
  let rgb = linearRgb(chroma);
  if (!inGamut(rgb)) {
    let low = 0, high = chroma;
    for (let step = 0; step < 12; step++) {
      const middle = (low + high) / 2;
      const candidate = linearRgb(middle);
      if (inGamut(candidate)) { low = middle; rgb = candidate; }
      else high = middle;
    }
  }
  return `rgb(${rgb.map(channel => Math.round(255 * (channel <= .0031308
    ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - .055))).join(" ")})`;
}
