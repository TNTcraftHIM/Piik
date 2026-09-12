// The actual homepage, driven by the film's existing time and inert sandbox.
import "../../main.js";
import { BEAT } from "../score.js";
import { point } from "./cursor";

const language = document.getElementById("language")!;
const theme = document.getElementById("theme") as HTMLSelectElement;
theme.value = "light";
theme.dispatchEvent(new Event("change"));
document.documentElement.style.scrollBehavior = "auto";
document.documentElement.style.overflow = "hidden";
document.body.style.pointerEvents = "none";
const holdHero = () => { (document.querySelector(".living-room") as HTMLImageElement).src = "./assets/living-room.svg#still"; };
holdHero();
// The real homepage follows OS changes; this staged copy always holds its art.
matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", holdHero);
const cursor = document.getElementById("cursor")!;
cursor.style.cssText = "position:fixed;left:0;top:0;z-index:100;pointer-events:none;transform-origin:0 0";
let settling = 0;

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== parent || data?.type !== "piik-film-ui" ||
      data.scene !== "website" || !["en", "zh-CN"].includes(data.lang) ||
      !Number.isFinite(data.local) || !Number.isFinite(data.time)) return;
  paint(data);
  cancelAnimationFrame(settling);
  settling = requestAnimationFrame(() => paint(data));
});
function paint(data: {lang: string; local: number; time: number}) {
  if (document.documentElement.lang !== data.lang) language.click();
  const download = document.getElementById("download")!;
  const button = download.querySelector<HTMLAnchorElement>(".download-button")!;
  const progress = Math.min(1, Math.max(0, (data.local - 1.25 * BEAT) / (2 * BEAT)));
  const scroll = download.offsetTop - 36;
  window.scrollTo(0, scroll * (progress * progress * (3 - 2 * progress)));
  document.getAnimations().forEach((animation) => {
    animation.pause();
    animation.currentTime = data.time * 1000;
  });
  const box = button.getBoundingClientRect();
  const click = Math.sin(Math.min(1, Math.max(0, (data.local - 4.5 * BEAT) / (BEAT / 2))) * Math.PI);
  button.style.transform = `scale(${1 - .04 * click})`;
  point(cursor, data.local, {x:995,y:615}, {x:box.x+box.width/2,y:box.y+box.height/2},
    3.25*BEAT, BEAT, 4.5*BEAT, 6*BEAT);
}
parent.postMessage({type: "piik-film-ui-ready"}, "*");
