// Renders named states of the room preview in a Chrome that listens for remote debugging, saves a capture of
// each and records the edges of its main elements, so a layout can be accepted by measurement.
//
//   1. npx vite --host 127.0.0.1 --port 8788 --strictPort
//   2. chrome --headless=new --remote-debugging-port=9364 --user-data-dir=<a profile of its own> about:blank
//   3. OUT_DIR=<folder> node scripts/room-layout/drive.mjs [name ...]     (no names: every state)
//   4. OUT_DIR=<folder> node scripts/room-layout/align.mjs                (the grid, state by state)
//      node scripts/room-layout/compare.mjs <folder>/edges.json           (against the accepted design)
//
// ORIGIN and CDP_PORT override the server and the browser. CLIP=x,y,w,h [SCALE] [OUT] writes a magnified crop,
// and EVAL=file.js prints a script's value in each state. reference-edges.json holds the accepted design.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
// OUT_DIR=path: write captures and edges there, to render another implementation beside this one.
const here = process.env.OUT_DIR ?? `${source}/../../build/room-layout`;
mkdirSync(here, { recursive: true });
const port = process.env.CDP_PORT ?? "9364";
const origin = process.env.ORIGIN ?? "http://127.0.0.1:8788";
const base = `${origin}/__tooltip-preview?channel-room`;
const edges = readFileSync(`${source}/edges.js`, "utf8");
const clickJs = readFileSync(`${source}/click.js`, "utf8");

const sizes = { fhd: [1920, 945], laptop: [1366, 650], scaled: [1536, 730], 1360: [1360, 860], 1024: [1024, 700], 390: [390, 844], 1600: [1600, 900], tall: [1440, 1080], 320: [320, 640] };
const states = {
  empty: "", s1: "&screens=1", s2: "&screens=2", s4: "&screens=4", s8: "&screens=8",
  failed: "&screens=1&picture=failed", offline: "&host-offline", long: "&screens=2&long-names", viewer: "&watch=viewer", voices: "&voice-rooms=2", voices1: "&voice-rooms=2&screens=1", avatars: "&avatars", avatars4: "&screens=4&avatars", elsewhere: "&invite-preview=studio", elsewhere1: "&invite-preview=studio&screens=1",
};
const share = [["click", "开始分享"], ["wait", 900], ["click", "分享窗口：Sketchbook"], ["wait", 1500]];
const scenarios = [];
const add = (name, layout, state, size, extra = {}) => scenarios.push({ name, url: `${base}${layout === "workspace" ? "" : `&layout=${layout}`}${states[state]}${extra.minimal ? "&minimal" : ""}`, size: sizes[size], ...extra });
for (const size of [1360, 1024, 390]) for (const state of ["empty", "s1", "s2", "s4", "failed", "offline", "long"]) add(`${state}-${size}`, "living", state, size);
for (const size of [1360, 390]) add(`own-${size}`, "living", "empty", size, { steps: share });
add("s1-1600", "living", "s1", 1600); add("empty-1600", "living", "empty", 1600);
add("s1-tall", "living", "s1", "tall");
add("s8-1360", "living", "s8", 1360);
add("s1-320", "living", "s1", 320); add("empty-320", "living", "empty", 320);
add("s1-1360-people", "living", "s1", 1360, { steps: [["click", "用户列表"], ["wait", 700]] });
add("empty-1360-people", "living", "empty", 1360, { steps: [["click", "用户列表"], ["wait", 700]] });
add("s1-1360-nochat", "living", "s1", 1360, { steps: [["click", "聊天"], ["wait", 700]] });
add("s1-1360-rooms", "living", "s1", 1360, { steps: [["click", "房间列表"], ["wait", 700]] });
add("s1-390-nochat", "living", "s1", 390, { steps: [["click", "聊天"], ["wait", 800]] });
add("s2-390-chat", "living", "s2", 390, { steps: [["click", "聊天"], ["wait", 800]] });
add("empty-390-rooms", "living", "empty", 390, { steps: [["click", "房间列表"], ["wait", 700]] });
add("s1-1024-chat", "living", "s1", 1024, { steps: [["click", "聊天"], ["wait", 800]] });
add("s1-1360-hover", "living", "s1", 1360, { hover: ".c3-message" });
const leave = [["click", "退出语音"], ["wait", 700]];
add("novoice-1360", "living", "empty", 1360, { steps: leave });
add("novoice-s1-1360", "living", "s1", 1360, { steps: leave });
add("novoice-390", "living", "empty", 390, { steps: leave });
add("elsewhere-1360", "living", "elsewhere", 1360);
add("elsewhere-s1-1360", "living", "elsewhere1", 1360);
add("overview-1360", "living", "empty", 1360, { steps: [["click", "本站房间总览"], ["wait", 700]] });
add("s4-1600", "living", "s4", 1600);
// The viewports people have: a maximised browser on a 1080p display, a 1366x768 laptop, a 125% scaled laptop.
for (const size of ["fhd", "laptop", "scaled"]) for (const state of ["empty", "s1", "s4"]) add(`${state}-${size}`, "living", state, size);
add("empty-1024-people", "living", "empty", 1024, { steps: [["click", "用户列表"], ["wait", 700]] });
for (const size of [1360, 390]) for (const state of ["empty", "s1"]) add(`${state}-${size}-light-en`, "living", state, size, { theme: "light", lang: "en" });
const list = "房间列表";
add("t-fold", "living", "empty", 1360, { steps: [["click", list], ["wait", 500]] });
add("t-fold-unfold", "living", "empty", 1360, { steps: [["click", list], ["wait", 500], ["click", list], ["wait", 500]] });
add("t-overlay", "living", "s1", 1360, { steps: [["click", list], ["wait", 500]] });
add("t-overlay-escape", "living", "s1", 1360, { steps: [["click", list], ["wait", 500], ["key", "Escape"], ["wait", 400]] });
add("t-overlay-outside", "living", "s1", 1360, { steps: [["click", list], ["wait", 500], ["tap", 700, 300], ["wait", 400]] });
add("t-overlay-again", "living", "s1", 1360, { steps: [["click", list], ["wait", 500], ["click", list], ["wait", 400]] });
add("t-focus", "living", "s1", 1360, { steps: [["key", "Tab"], ["key", "Tab"], ["key", "Tab"], ["wait", 300]] });
for (const state of ["empty", "s1", "s4"]) for (const size of [1360, "laptop"]) add(`min-${state}-${size}`, "living", state, size, { minimal: true });
add("min-s1-1360-chat", "living", "s1", 1360, { minimal: true, steps: [["click", "聊天"], ["wait", 700]] });
add("min-empty-1360-rooms", "living", "empty", 1360, { minimal: true, steps: [["click", "房间列表"], ["wait", 700]] });
add("min-novoice-1360", "living", "empty", 1360, { minimal: true, steps: [["click", "退出语音"], ["wait", 700]] });
add("voices-1360", "living", "voices", 1360);
add("voices-s1-1360", "living", "voices1", 1360);
add("voices-s1-fhd", "living", "voices1", "fhd");
add("avatars-1360", "living", "avatars4", 1360);
add("avatars-empty-1360", "living", "avatars", 1360);
add("avatars-390", "living", "avatars4", 390);
add("more-1360", "living", "empty", 1360, { steps: [["click", "更多选项"], ["wait", 700]] });
add("app-1360", "living", "empty", 1360, { steps: [["click", "App"], ["wait", 700]] });
add("more-s1-1600", "living", "s1", 1600, { steps: [["click", "更多选项"], ["wait", 700]] });
for (const size of [1360, 390]) for (const state of ["empty", "s1", "s4"]) add(`${state}-${size}-quick`, "quick", state, size);
add("own-1360-workspace", "workspace", "empty", 1360, { steps: share });
// The present workspace beside it, for the comparison page.
for (const size of [1360, 390]) for (const state of ["empty", "s1", "s2", "s4"]) add(`${state}-${size}-workspace`, "workspace", state, size);

// CLIP=x,y,w,h [SCALE=2] [OUT=name]: a magnified crop of each named scenario, written beside the full captures.
const clip = process.env.CLIP?.split(",").map(Number);
const wanted = process.argv.slice(2);
for (const name of wanted) {
  const [plain, head] = name.split("@");
  const source = head && scenarios.find(value => value.name === plain);
  if (source) scenarios.push({ ...source, name: `${plain}-${head}`, url: `${source.url}&${head === "dock" ? "controls" : head === "deep" || head === "warm" ? "tone" : "head"}=${head}` });
}
for (let index = 0; index < wanted.length; index++) wanted[index] = wanted[index].replace("@", "-");
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socket = new WebSocket(pages.find(value => value.type === "page").webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let next = 0; const waiting = new Map(); const logs = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") logs.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) return `! ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`;
  return result.result.value;
};
await send("Runtime.enable"); await send("Page.enable");
const all = {};
for (const s of scenarios) {
  if (wanted.length && !wanted.includes(s.name)) continue;
  const [width, height] = s.size;
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${origin}/__tooltip-preview` });
  await sleep(300);
  await evaluate(`localStorage.removeItem('piik:room-preferences:v1'); localStorage.setItem('piik:ui-theme', ${JSON.stringify(s.theme ?? "dark")}); localStorage.setItem('piik:ui-lang', ${JSON.stringify(s.lang ?? "zh")});`);
  await send("Page.navigate", { url: s.url });
  await sleep(1900);
  const steps = [];
  for (const [kind, a, b] of s.steps ?? []) {
    if (kind === "click") steps.push(await evaluate(`${clickJs}; __click(${JSON.stringify(a)}, ${b ?? 0})`));
    else if (kind === "key") { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: a, code: a, windowsVirtualKeyCode: a === "Escape" ? 27 : a === "Tab" ? 9 : 0 }); }
    else if (kind === "tap") { for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: a, y: b, button: "left", clickCount: 1 }); }
    else await sleep(a);
  }
  // Park the pointer away from any control, or over one element when the scenario asks for its hover state.
  let point = { x: 2, y: height - 2 };
  if (s.hover) {
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(s.hover)})?.getBoundingClientRect(); return r && { x: r.left + 60, y: r.top + r.height / 2 }; })()`);
    if (box && typeof box === "object") point = box;
  }
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await sleep(350);
  // EVAL=file.js: print the value of that script in each named scenario, and capture nothing.
  if (process.env.EVAL) {
    const value = await evaluate(readFileSync(process.env.EVAL, "utf8"));
    console.log(`--- ${s.name}
${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`);
    continue;
  }
  if (clip) {
    const [x, y, w, h] = clip;
    const zoomed = await send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: Number(process.env.SCALE ?? 2) } });
    writeFileSync(`${here}/zoom-${process.env.OUT ?? s.name}.png`, Buffer.from(zoomed.data, "base64"));
    console.log(`zoom-${process.env.OUT ?? s.name}.png`);
    continue;
  }
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${here}/${s.name}.png`, Buffer.from(data, "base64"));
  all[s.name] = { url: s.url, size: s.size, steps, ...(await evaluate(edges)) };
  console.log(`${s.name}: picture ${all[s.name].pictureShare}% fonts ${JSON.stringify(all[s.name].fonts)} scrolls ${all[s.name].scrolls}${steps.length ? " steps " + JSON.stringify(steps) : ""}`);
}
let previous = {};
try { previous = JSON.parse(readFileSync(`${here}/edges.json`, "utf8")); } catch {}
writeFileSync(`${here}/edges.json`, JSON.stringify({ ...previous, ...all }, null, 1));
for (const line of new Set(logs)) console.log(line);
socket.close();
