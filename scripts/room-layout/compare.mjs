// Compares the recorded edges of a rendered implementation with the accepted design, state by state.
//   node scripts/room-layout/compare.mjs <folder>/edges.json [reference.json]
// A state passes when every recorded element is within TOLERANCE pixels of the reference, the same type sizes
// are in use, and the pictures take the same share of the screen.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOLERANCE = 1.5;
const candidate = JSON.parse(readFileSync(process.argv[2], "utf8"));
const reference = JSON.parse(readFileSync(process.argv[3] ?? fileURLToPath(new URL("./reference-edges.json", import.meta.url)), "utf8"));
const rects = ["shell", "siteCell", "sidebar", "heading", "stage", "chat", "roomIcon", "roomName", "date", "avatar", "messageText",
  "composer", "composeField", "couch", "bar", "identity", "lastTool", "itemIcon", "itemName", "myName"];
const differs = (a, b) => ["l", "r", "t", "b"].filter(side => Math.abs((a?.[side] ?? NaN) - (b?.[side] ?? NaN)) > TOLERANCE);

let failed = 0, compared = 0;
for (const [name, wanted] of Object.entries(reference)) {
  const got = candidate[name];
  if (!got) continue;
  compared++;
  const notes = [];
  for (const key of rects) {
    if (!wanted[key] !== !got[key]) notes.push(`${key} ${wanted[key] ? "missing" : "unexpected"}`);
    else if (wanted[key]) {
      const sides = differs(wanted[key], got[key]);
      if (sides.length) notes.push(`${key} ${sides.map(side => `${side} ${got[key][side]} for ${wanted[key][side]}`).join(", ")}`);
    }
  }
  if (wanted.tiles.length !== got.tiles.length) notes.push(`${got.tiles.length} pictures for ${wanted.tiles.length}`);
  else wanted.tiles.forEach((tile, index) => { const sides = differs(tile, got.tiles[index]); if (sides.length) notes.push(`picture ${index + 1} ${sides.map(side => `${side} ${got.tiles[index][side]} for ${tile[side]}`).join(", ")}`); });
  if (Math.abs(wanted.pictureShare - got.pictureShare) > 0.5) notes.push(`pictures ${got.pictureShare}% of the screen for ${wanted.pictureShare}%`);
  if (JSON.stringify(wanted.fonts) !== JSON.stringify(got.fonts)) notes.push(`type sizes ${JSON.stringify(got.fonts)} for ${JSON.stringify(wanted.fonts)}`);
  if (notes.length) failed++;
  console.log(`${notes.length ? "FAIL" : "ok  "} ${name}${notes.length ? ": " + notes.slice(0, 6).join("; ") + (notes.length > 6 ? `; and ${notes.length - 6} more` : "") : ""}`);
}
console.log(failed ? `${failed} of ${compared} states differ from the accepted design` : `all ${compared} states match the accepted design`);
process.exitCode = failed ? 1 : 0;
