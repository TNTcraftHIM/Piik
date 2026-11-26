// Checks the grid on every rendered scenario of the living layout: one left edge per column, one axis for the room.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const all = JSON.parse(readFileSync(`${process.env.OUT_DIR ?? fileURLToPath(new URL("../../build/room-layout", import.meta.url))}/edges.json`, "utf8"));
let failures = 0;
for (const [name, e] of Object.entries(all)) {
  if (name.includes("workspace") || name.includes("quick")) continue;
  const notes = [];
  const near = (label, a, b, tolerance = 1) => { if (a != null && b != null && Math.abs(a - b) > tolerance) notes.push(`${label}: ${a} vs ${b}`); };
  const phone = e.viewport[0] < 600;
  // A card opened from the dock is an overlay with its own type; its audit is separate.
  const overlay = /^(more|app)-/.test(name);
  // The room's centre is one axis: pictures, couch, my controls.
  const room = e.tiles.length ? { cx: (Math.min(...e.tiles.map(t => t.l)) + Math.max(...e.tiles.map(t => t.r))) / 2 } : e.chat;
  if (e.couch && room && !name.includes("rooms")) near("couch on the room's axis", e.couch.cx, room.cx, 1.5);
  const dock = e.controls === "dock";
  if (e.cluster && e.couch && !phone && !dock && !name.includes("rooms")) near("my controls on the couch's axis", e.cluster.cx, e.couch.cx, 1.5);
  // The dock is the foot of the rooms column: its controls stay inside the column.
  if (dock && e.cluster && e.sidebar && !overlay) { if (e.cluster.l < e.sidebar.l || e.cluster.r > e.sidebar.r) notes.push(`dock controls outside the rooms column: ${e.cluster.l}..${e.cluster.r} vs ${e.sidebar.l}..${e.sidebar.r}`); }
  // The top row: the site's cell is the head of the rooms column; one size of tool; the last glyph ends on the content edge.
  if (!phone && e.siteCell && e.sidebar && e.controls && e.head !== "path") near("site cell and rooms column, right", e.siteCell.r, e.sidebar.r);
  if (!phone && e.heading && e.stage && e.pane !== "rooms" && e.head !== "path") near("room header and room, left", e.heading.l, e.stage.l);
  if (!phone && e.toolSizes?.length > 1) notes.push(`tool heights ${JSON.stringify(e.toolSizes)}`);
  if (!phone && e.lastTool && e.date && e.chat && e.chat.r > e.lastTool.r) near("last tool glyph and content edge, right", e.lastTool.r, e.date.r);
  // The rooms column: the mark's picture, a room's icon and my name line up with their neighbours.
  if (e.rooms === "list" && e.homeMark && e.itemIcon) near("site mark picture and room icon, left", e.homeMark.l + 4, e.itemIcon.l, 1);
  if (e.rooms === "list" && e.myName && e.itemName && !dock) near("my name and room names, left", e.myName.l, e.itemName.l, 1);
  if (e.rooms === "list" && e.navLabel && e.group) near("rooms heading and group label, left", e.navLabel.l, e.group.l + 4, 1);
  // Messages, their rules and the composer share one left and one right edge.
  if (e.date && e.avatar) near("date rule and avatar, left", e.date.l, e.avatar.l);
  // As the room, the composer is a box on the messages’ edges; beside pictures its field is.
  const box = e.tiles.length ? e.composeField : e.composer;
  if (e.date && box) { near("date rule and composer, left", e.date.l, box.l); near("date rule and composer, right", e.date.r, box.r); }
  // Without pictures the room's name starts on the conversation's edge (list open).
  if (!e.tiles.length && e.roomIcon && e.date && !phone && e.viewport[0] >= 1100 && !name.includes("offline")) near("room mark and messages, left", e.roomIcon.l, e.date.l);
  // Beside pictures the composer's top is my row's top.
  if (e.tiles.length && e.composer && e.bar && !phone && !dock) near("composer and my row, top", e.composer.t, e.bar.t);
  // The couch is drawn as a whole at its own scale; its names are never rendered under 12 px.
  if (e.couchText < 11.9) notes.push(`couch names rendered at ${e.couchText}px`);
  if (e.scrolls) notes.push("page scrolls");
  if (e.fonts.some(size => ![12, 14, 16, 20].includes(size)) && !name.includes("hover") && !overlay) notes.push(`font sizes ${JSON.stringify(e.fonts)}`);
  failures += notes.length;
  console.log(`${notes.length ? "FAIL" : "ok  "} ${name}${notes.length ? ": " + notes.join("; ") : ""}`);
}
console.log(failures ? `${failures} misalignments` : "every scenario is on the grid");
