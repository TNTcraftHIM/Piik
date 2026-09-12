import { gameMarkup, poses } from "./game.js";
import { mascotMarkup } from "./brand.js";

// One set of original game scenes and poses for the film and standalone hero.
// Renderers supply a time; no vignette owns a clock or incremental state.
const INK = "#203037",
  PAPER = "#faf5e7",
  GOLD = "#f3cc68",
  CORAL = "#f47843";
const clamp = (n) => Math.min(1, Math.max(0, n));
const ease = (n) => {
  const p = clamp(n);
  return p * p * (3 - 2 * p);
};
const mix = (a, b, p) => a + (b - a) * p;
export const GAME_KINDS = ["rpg", "fps", "platform", "rts", "moba", "fighting"];
// Actions are authored over one bar; each surface chooses its playback speed.
export const GAME_CUT = 240 / 101;
const round = n => Math.round(n * 100) / 100;
const hero = (id, size = 3) =>
  `<g id="${id}" style="color:${INK}"><g transform="scale(${size}) translate(-16 -16)">${mascotMarkup(id + "-tv", PAPER)}</g></g>`;
const burst = (id, x, y, colour = GOLD) =>
  `<g transform="translate(${x} ${y})"><g id="${id}" fill="none" stroke="${colour}" stroke-width="8" stroke-linecap="round"><circle r="35"/>${[0, 60, 120, 180, 240, 300].map((a) => `<path d="M49 0h25" transform="rotate(${a})"/>`).join("")}</g></g>`;
const unit = (id, colour) =>
  `<g id="${id}"><ellipse cy="19" rx="27" ry="11" fill="${INK}" opacity=".2"/><path d="M-23 11q0-33 23-33t23 33Z" fill="${colour}" stroke="${INK}" stroke-width="3"/><path d="M-8-6H8" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/></g>`;
const fighter = (id, colour, direction) => `<g id="${id}"><g transform="scale(${direction} 1)">
  <path d="M-34 95-51 184h-35m119-89 32 89h35" fill="none" stroke="${INK}" stroke-width="23" stroke-linecap="round"/>
  <path d="M-58 55h116v58H-58Z" fill="${colour}"/><path d="M-58 70h116" stroke="${INK}" stroke-width="10"/>
  ${hero(id+'-head',5)}
  <circle cx="-103" cy="61" r="29" fill="${colour}" stroke="${INK}" stroke-width="6"/>
  <path id="${id}-arm" d="M0 0h100" stroke="${colour}" stroke-width="24" stroke-linecap="round"/>
  <g id="${id}-glove"><circle cx="106" cy="4" r="30" fill="${colour}" stroke="${INK}" stroke-width="6"/><path d="M93-8h21" stroke="${PAPER}" stroke-width="7" stroke-linecap="round"/></g>
</g></g>`;

export function montageMarkup() {
  return `<g id="montage-rpg">${gameMarkup("full-game")}</g>
    <g id="montage-fps">
      <rect width="1600" height="900" fill="#91afba"/>
      <path d="M0 116h300V56h266v96h522V77h295v78h217v481H0Z" fill="#536e7b"/>
      <path d="M344 138h770v356H344Z" fill="#405965"/><path d="M728 243h249v251H728Z" fill="${INK}"/>
      <path d="M378 189h221v41H378Zm657 0h46v220h-46Z" fill="#adc6c9"/>
      <path d="M0 489h1600v411H0Z" fill="#768c94"/><path d="M650 489 170 900m316-250h775m-221-161 477 411" fill="none" stroke="#a6b4b3" stroke-width="5"/>
      <path d="M0 251 257 348v552H0Zm1600-74-229 93v630h229Z" fill="#344d5c"/>
      <path d="m0 251 257 97v43L0 299Zm1600-74-229 93v44l229-96Z" fill="#b5c7c5"/>
      ${[
        [610, 477],
        [863, 358],
        [1120, 484],
      ]
        .map(
          ([x, y], i) =>
            `<g transform="translate(${x} ${y})"><g id="fps-target-${i}"><g transform="scale(2.4)">${unit('fps-opponent-'+i,CORAL)}</g></g></g>${burst("fps-hit-" + i, x, y)}`,
        )
        .join("")}
      <g fill="#486472" stroke="#8ba5ad" stroke-width="5"><path d="M469 535h274v225H469Z"/><path d="M746 419h249v155H746Z"/><path d="M1023 552h305v213h-305Z"/></g>
      <path d="M489 557h233M508 557v178M605 557v178M766 443h209M790 443v106M882 443v106M1043 574h265M1068 574v166M1185 574v166" fill="none" stroke="#718b95" stroke-width="8"/>
      <path id="fps-tracer" d="M0 0h100" fill="none" stroke="${GOLD}" stroke-width="8" stroke-linecap="round"/>
      <g id="fps-tool">
        <path d="M-257 250-130 23-56 40-67 250Z" fill="${CORAL}"/><path d="m-134 18 49-51 47 40-24 77-49-6Z" fill="${INK}"/>
        <path d="M253 250 67 43-6 73 62 250Z" fill="#d5b68a"/><path d="m57 35-51-14-24 57 45 53 44-45Z" fill="${INK}"/>
        <path d="M-71 213-68 42h132l56 171Z" fill="${INK}"/>
        <path d="M-45-148h90V50L22 99h-67Z" fill="#81989f" stroke="${INK}" stroke-width="9"/>
        <path d="M-17-145v-172h34v172" fill="#b8c8c9" stroke="${INK}" stroke-width="10"/>
        <rect x="-28" y="-340" width="56" height="40" rx="7" fill="${INK}"/>
        <path d="M-31-145v-53q0-12 12-12h38q12 0 12 12v53Z" fill="${INK}" stroke="${PAPER}" stroke-width="6"/><circle cy="-177" r="5" fill="${CORAL}"/>
        <path d="m15 47 49-10 29 103-47 12Z" fill="${INK}"/><path d="M-46-111h24m-24 24h24m-24 24h24" stroke="${INK}" stroke-width="7"/>
        <g id="fps-muzzle"><path d="m0-338-15-28-21 4 7-25-17-18 31-3 15-35 14 35 31 3-17 18 7 25-21-4Z" fill="${GOLD}"/><path d="m0-344-13-33 13-35 13 35Z" fill="${PAPER}"/></g>
      </g>
      <g id="fps-crosshair" fill="none" stroke="${PAPER}" stroke-width="4"><path d="M-27-11v-16h16m22 0h16v16m0 22v16H11m-22 0h-16V11"/><circle r="3" fill="${PAPER}"/></g>
    </g>
    <g id="montage-platform">
      <rect width="1600" height="900" fill="#b9dbdc"/>
      <circle cx="1190" cy="181" r="110" fill="#faf1ca"/>
      <g fill="#edf1dc"><path d="M85 290q-19-43 28-52 19-59 68-18 59-12 66 42 40 1 39 28Z"/><path d="M753 179q-14-34 24-42 24-51 63-11 61-6 65 53Z"/></g>
      <path d="M-100 785 250 365 666 833 1035 393 1490 783 1730 456v500H-100Z" fill="#8bb8ad"/>
      <path d="M-100 873 250 535 500 801 741 605l420 329Z" fill="#6a9c91"/>
      <g fill="#bf9066"><path d="M0 690h450v210H0Z"/><path d="M940 540h660v360H870Z"/></g>
      <g fill="#477a69"><path d="M0 690h450v26H0Z"/><path d="M932 540h668v27H928Z"/></g>
      <g fill="#dcb181"><path d="M0 743h395v36H0Zm988-151h612v33H980Zm-18 105h570v34H962Z"/></g>
      <path d="M65 861h207m856-69h227" stroke="#a97856" stroke-width="8" stroke-linecap="round"/>
      ${[
        [625, 351],
        [764, 307],
        [889, 371],
      ]
        .map(
          ([x, y], i) =>
            `<g transform="translate(${x} ${y})"><g id="platform-coin-${i}"><circle r="25" fill="${GOLD}" stroke="#b7803d" stroke-width="5"/><path d="M0-11v22" stroke="#fff3bd" stroke-width="6"/></g></g>${burst("platform-hit-" + i, x, y)}`,
        )
        .join("")}
      <ellipse id="platform-shadow" rx="41" ry="10" fill="${INK}" opacity=".2"/>
      ${hero("platform-player")}
      <g transform="translate(1325 540)"><path d="M0 0v-223" stroke="${INK}" stroke-width="8" stroke-linecap="round"/><circle cy="-225" r="9" fill="${GOLD}"/><g id="platform-flag"><path d="M5-214h110l-25 37 25 37H5Z" fill="${CORAL}"/><path d="m24-176 15 14 30-30" fill="none" stroke="${PAPER}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></g></g>
    </g>
    <g id="montage-rts">
      <rect width="1600" height="900" fill="#cbd0ae"/>
      <path d="M-100 500 375 196 1650 515v200L369 389-100 703Z" fill="#91b6b6"/>
      <path d="m-100 499 475-303 1275 319m-1750 188L369 389l1281 326" fill="none" stroke="#eae1b6" stroke-width="15"/>
      <ellipse cx="1115" cy="500" rx="244" ry="203" fill="#eae1b6"/><ellipse cx="1115" cy="500" rx="233" ry="189" fill="#cbd0ae"/>
      <path d="m433 182-74 210 173 50 77-216Z" fill="#bcaa7e" stroke="#897e65" stroke-width="6"/>
      ${[
        [1270, 744],
        [261, 681],
        [782, 563],
      ]
        .map(
          ([x, y]) =>
            `<g transform="translate(${x} ${y})"><ellipse rx="91" ry="36" fill="#9faf88"/><path d="M-60-10-15-69 33-56 78-7 35 19-37 20Z" fill="#6d8c7b"/><path d="M-15-69 33-56 16-15-60-10Z" fill="#91aa8c"/></g>`,
        )
        .join("")}
      <path id="rts-route" d="M453 645Q570 47 1100 328" fill="none" stroke="${INK}" stroke-width="5" stroke-dasharray="15 13" opacity=".5"/>
      <path d="m1065 332 35-4-18-30" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
      <g transform="translate(1115 510)"><ellipse rx="137" ry="81" fill="#b3bb96"/><path d="m-72 26 8-88 64-35 68 35 8 88-76 40Z" fill="#69857a"/><path d="m-64-62 64-35 68 35L0-22Z" fill="#9bac98"/><path d="M0-22v88" stroke="#496d62" stroke-width="5"/><path d="M0-22v-110" stroke="${INK}" stroke-width="7"/><path id="rts-banner" d="M4-132h76l-21 25 21 25H4Z" fill="${CORAL}"/></g>
      ${Array.from({ length: 6 }, (_, i) => `<g id="rts-ally-${i}"><ellipse rx="37" ry="23" cy="15" fill="none" stroke="#f5f2cc" stroke-width="4"/>${unit("rts-ally-body-" + i, "#528f86")}</g>${unit("rts-enemy-" + i, CORAL)}${burst("rts-hit-" + i, 1040 + (i % 3) * 72, 431 + Math.floor(i / 3) * 139)}`).join("")}
      <g fill="none" stroke="${PAPER}" stroke-width="8" stroke-linecap="round">${Array.from({ length: 6 }, (_, i) => `<path id="rts-shot-${i}" d="M0 0h100"/>`).join("")}</g>
      <g id="rts-command" transform="translate(849 186)" fill="none" stroke="${PAPER}" stroke-width="6"><ellipse rx="48" ry="24"/><path d="M0-45v16m0 58v16m-70-45h20m100 0h20"/></g>
    </g>
    <g id="montage-moba">
      <rect width="1600" height="900" fill="#5c8577"/>
      <path d="M104 900 1140-70h445L541 900Z" fill="#a7b5a0"/>
      <path d="M-15 863 1112-112m-515 1061L1660-65" fill="none" stroke="#d2cdb0" stroke-width="19"/>
      <g stroke="#8d9f90" stroke-width="4">${Array.from({ length: 8 }, (_, i) => `<path d="m${390 + i * 125} ${900 - i * 125} 180-170"/>`).join("")}</g>
      ${[
        [189, 350],
        [290, 174],
        [1417, 690],
        [1315, 824],
      ]
        .map(
          ([x, y]) =>
            `<g transform="translate(${x} ${y})"><ellipse cy="50" rx="92" ry="29" fill="#355e56"/><path d="M-70 36-59-40 5-90 66-46 83 35 0 66Z" fill="#3f7060"/><path d="M-59-40 5-90 66-46 7-9Z" fill="#71977a"/></g>`,
        )
        .join("")}
      <g transform="translate(1370 198)"><ellipse cy="50" rx="95" ry="45" fill="#718e7f"/><path d="M-60 20-45-42 0-76 46-42 59 20 0 54Z" fill="#b0bda5"/><path d="m0-76 46 34-46 26-45-26Z" fill="#dfdec3"/><path d="m0-47 20 32-20 35-20-35Z" fill="${CORAL}"/></g>
      <path id="moba-warning" d="M1197 315 1173 354 588 651 612 612Z" fill="${CORAL}" opacity=".35"/>
      <path id="moba-enemy-shot" d="M0 0h100" stroke="${CORAL}" stroke-width="20" stroke-linecap="round"/>
      <path id="moba-dash" d="M600 630 760 416" stroke="#bde7db" stroke-width="66" stroke-linecap="round" opacity=".4"/>
      ${[
        [1110, 355],
        [1220, 475],
        [1090, 600],
      ]
        .map(
          ([x, y], i) =>
            `<g transform="translate(${x} ${y})"><g id="moba-enemy-${i}"><ellipse cy="31" rx="47" ry="18" fill="${INK}" opacity=".2"/><path d="M-35 23q-6-61 35-65t35 65Z" fill="${CORAL}" stroke="${INK}" stroke-width="4"/><path d="M-12-11h24" stroke="${PAPER}" stroke-width="6" stroke-linecap="round"/><rect x="-43" y="-74" width="86" height="9" rx="4.5" fill="${INK}"/><rect id="moba-health-${i}" x="-41" y="-72" width="82" height="5" rx="2.5" fill="${GOLD}"/></g></g>${burst("moba-hit-" + i, x, y, PAPER)}`,
        )
        .join("")}
      <g transform="translate(1140 470)"><circle id="moba-impact" r="175" fill="#e8efd0" fill-opacity=".2" stroke="${PAPER}" stroke-width="10"/></g>
      <ellipse id="moba-shadow" rx="48" ry="15" fill="${INK}" opacity=".2"/>
      ${hero("moba-player", 3.2)}
      <path id="moba-shot" d="M0 0h100" stroke="${PAPER}" stroke-width="27" stroke-linecap="round"/>
      <g id="moba-result" transform="translate(1402 772)"><circle r="56" fill="${INK}"/><text y="20" text-anchor="middle" font-size="58" font-weight="900" fill="${GOLD}">×3</text></g>
    </g>
    <g id="montage-fighting">
      <rect width="1600" height="900" fill="#c6b7c7"/><circle cx="800" cy="298" r="213" fill="#f4d79e"/>
      <path d="M0 486 205 337 428 486l232-144 292 144 205-115 443 115v183H0Z" fill="#879aa1"/>
      <path d="M197 194h72v445h-72Zm1134 0h72v445h-72Z" fill="#526773"/><path d="M163 193h141v31H163Zm1131 0h141v31h-141Z" fill="#758996"/>
      <path d="M0 647h1600v253H0Z" fill="#344c5a"/><path d="M0 647h1600M0 775h1600M431 647 240 900m937-253 190 253" fill="none" stroke="#728993" stroke-width="6"/>
      <ellipse cx="611" cy="647" rx="137" ry="27" fill="${INK}" opacity=".25"/><ellipse cx="1080" cy="647" rx="166" ry="27" fill="${INK}" opacity=".25"/>
      <rect x="146" y="75" width="542" height="37" rx="12" fill="${INK}"/><rect x="157" y="84" width="520" height="19" rx="8" fill="#83c4a5"/>
      <rect x="912" y="75" width="542" height="37" rx="12" fill="${INK}"/><rect id="fighting-health" x="923" y="84" width="520" height="19" rx="8" fill="${CORAL}"/>
      <path d="m777 61 46 0-23 39h24l-47 51 17-42h-20Z" fill="${INK}"/>
      ${fighter('fighting-opponent',CORAL,-1)}${fighter('fighting-player','#83c4a5',1)}
      <g id="fighting-guard"><path d="M0-55q35 51 0 105" fill="none" stroke="${PAPER}" stroke-width="13" stroke-linecap="round"/><path d="M18-38 39-48M22 0h29m-33 34 23 15" stroke="${GOLD}" stroke-width="8" stroke-linecap="round"/></g>
      ${burst('fighting-hit',976,488)}
    </g>`;
}

export function gameFrame(kind, t, rpgTime) {
  const frame = {};
  const style = (id, property, value) => { (frame[id] ??= {})[property] = String(value); };
  const transform = (id, value) => style(id, 'transform', value);
  const show = (id, yes) => style(id, 'opacity', yes ? 1 : 0);
  const opacity = (id, n) => style(id, 'opacity', round(clamp(n)));
  const position = (id, x, y, scale = 1) =>
    transform(id, `translate(${round(x)}px,${round(y)}px) scale(${round(scale)})`);
  const pulse = (id, t) => {
    const p = clamp(t / 0.45);
    transform(id, `scale(${round(0.5 + p * 1.4)})`);
    opacity(id, t >= 0 ? 1 - p : 0);
  };
  const line = (id, a, b) => transform(id,
    `translate(${round(a[0])}px,${round(a[1])}px) rotate(${round(Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI)}deg) scaleX(${round(Math.hypot(b[0]-a[0],b[1]-a[1])/100)})`);

  function fps(t) {
    const targets = [
        [610, 477],
        [863, 358],
        [1120, 484],
      ],
      shots = [0.55, 1.1, 1.65];
    const count = shots.filter((s) => t >= s).length;
    const next = Math.min(count, 2),
      from = next ? targets[next - 1] : [405, 565];
    const aim = ease((t - (next ? shots[next - 1] + 0.09 : 0)) / 0.34);
    const aimPoint = from.map((n,i)=>mix(n,targets[next][i],aim));
    position("fps-crosshair", ...aimPoint);
    const last = count ? t - shots[count - 1] : -1;
    const kick = last >= 0 ? Math.sin(clamp(last/.18)*Math.PI) : 0;
    const origin = [1180,810+18*kick], weaponScale=.85;
    const angle = Math.atan2(aimPoint[1]-origin[1],aimPoint[0]-origin[0])+Math.PI/2;
    transform('fps-tool',`translate(${origin[0]}px,${round(origin[1])}px) rotate(${round(angle*180/Math.PI-3*kick)}deg) scale(${weaponScale})`);
    const muzzleAngle=angle-3*kick*Math.PI/180;
    const muzzle=[origin[0]+340*weaponScale*Math.sin(muzzleAngle),origin[1]-340*weaponScale*Math.cos(muzzleAngle)];
    line("fps-tracer", muzzle, targets[Math.max(0, count - 1)]);
    opacity("fps-tracer", last >= 0 ? 1 - last / 0.1 : 0);
    opacity('fps-muzzle',last>=0?1-last/.09:0);
    targets.forEach((_, i) => {
      const fall=ease((t-shots[i])/.18);
      transform("fps-target-" + i, `translate(0px,${round(75*fall)}px) rotate(${round(-24*fall)}deg)`);
      opacity('fps-target-'+i,1-fall);
      pulse("fps-hit-" + i, t - shots[i]);
    });
  }

  function platform(t) {
    const leap = clamp((t - 0.32) / 1.22),
      run = ease((t - 1.54) / 0.6);
    const x =
      t < 0.32
        ? mix(295, 422, ease(t / 0.32))
        : mix(422, 1080, leap) + 245 * run;
    const ground = mix(645, 495, leap),
      y = ground - 278 * Math.sin(leap * Math.PI);
    transform(
      "platform-player",
      `translate(${round(x)}px,${round(y)}px) rotate(${round(leap > 0 && leap < 1 ? -9 : 3 * Math.sin(t * 19))}deg)`,
    );
    position(
      "platform-shadow",
      x,
      ground + 43,
      1 - 0.5 * Math.sin(leap * Math.PI),
    );
    [0.7, 0.955, 1.185].forEach((hit, i) => {
      transform("platform-coin-" + i, `scale(${round(1 - ease((t - hit) / 0.12))})`);
      pulse("platform-hit-" + i, t - hit);
    });
    position("platform-flag", 0, 126 * (1 - ease((t - 2) / 0.2)));
  }

  function rts(t) {
    const p = ease((t - 0.12) / 1.18),
      u = 1 - p;
    // A curved flank around the rocks, followed by the capture flag.
    const x = u * u * 453 + 2 * u * p * 570 + p * p * 1100,
      y = u * u * 645 + 2 * u * p * 47 + p * p * 328;
    for (let i = 0; i < 6; i++) {
      position(
        "rts-ally-" + i,
        x + (i % 3) * 64 - 64,
        y + Math.floor(i / 3) * 65 - 30,
      );
      position(
        "rts-enemy-" + i,
        1040 + (i % 3) * 72,
        431 + Math.floor(i / 3) * 139,
        1 - ease((t - 1.52 - i * 0.025) / 0.17),
      );
      pulse("rts-hit-" + i, t - 1.52 - i * 0.025);
      const shot = clamp((t - 1.28 - i * 0.025) / 0.24),
        start = [1036 + (i % 3) * 64, 298 + Math.floor(i / 3) * 65],
        end = [1040 + (i % 3) * 72, 431 + Math.floor(i / 3) * 139];
      line(
        "rts-shot-" + i,
        start.map((n, j) => mix(n, end[j], shot)),
        start.map((n, j) => mix(n, end[j], Math.max(0, shot - 0.25))),
      );
      opacity(
        "rts-shot-" + i,
        t >= 1.28 + i * 0.025 && t < 1.52 + i * 0.025 ? 1 : 0,
      );
    }
    style("rts-banner", "fill", t >= 1.74 ? "#528f86" : CORAL);
    opacity("rts-command", 1 - ease((t - 0.55) / 0.3));
    opacity("rts-route", 0.5 * (1 - ease((t - 1.4) / 0.3)));
  }

  function moba(t) {
    const dash = ease((t - 0.57) / 0.26),
      x = mix(600, 760, dash),
      y = mix(630, 416, dash);
    position("moba-player", x, y);
    position("moba-shadow", x, y + 49);
    opacity("moba-warning", 0.35 * (1 - ease((t - 0.6) / 0.15)));
    opacity("moba-dash", t >= 0.57 ? 0.45 * (1 - ease((t - 0.83) / 0.3)) : 0);
    const enemy = clamp((t - 0.61) / 0.45);
    line(
      "moba-enemy-shot",
      [mix(1185, 570, enemy), mix(335, 645, enemy)],
      [mix(1185, 670, enemy), mix(335, 595, enemy)],
    );
    opacity("moba-enemy-shot", t >= 0.61 && t < 1.08 ? 1 : 0);
    const shot = clamp((t - 1.06) / 0.34);
    line(
      "moba-shot",
      [mix(760, 1140, shot), mix(416, 470, shot)],
      [mix(760, 1045, shot), mix(416, 456, shot)],
    );
    opacity("moba-shot", t >= 1.06 && t < 1.4 ? 1 : 0);
    transform("moba-impact", `scale(${round(ease((t - 1.4) / 0.16))})`);
    opacity("moba-impact", 1 - ease((t - 1.57) / 0.35));
    for (let i = 0; i < 3; i++) {
      transform("moba-enemy-" + i, `scale(${round(1 - ease((t - 1.44) / 0.15))})`);
      transform("moba-health-" + i, `translate(-41px,0px) scaleX(${round(1 - ease((t - 1.4) / 0.09))}) translate(41px,0px)`);
      pulse("moba-hit-" + i, t - 1.44);
    }
    show("moba-result", t >= 1.6);
  }

  function fighting(t) {
    const p=clamp(t/GAME_CUT), approach=ease(p/.18);
    const jab=ease((p-.21)/.1)*(1-ease((p-.34)/.12));
    const guard=ease((p-.27)/.035)*(1-ease((p-.39)/.08));
    const counter=ease((p-.44)/.11)*(1-ease((p-.59)/.15));
    const recoil=ease((p-.55)/.13);
    const playerX=mix(460,610,approach)+55*counter, opponentX=mix(1140,965,approach)+185*recoil;
    transform('fighting-player',`translate(${round(playerX)}px,452px) rotate(${round(-4*guard+6*counter)}deg)`);
    transform('fighting-opponent',`translate(${round(opponentX)}px,452px) rotate(${round(22*recoil-4*jab)}deg)`);
    position('fighting-player-glove',205*counter,-12*guard);
    position('fighting-opponent-glove',145*jab,0);
    line('fighting-player-arm',[57,71],[106+205*counter,4-12*guard]);
    line('fighting-opponent-arm',[57,71],[106+145*jab,4]);
    position('fighting-guard',716,448);
    opacity('fighting-guard',guard);
    pulse('fighting-hit',(p-.55)*GAME_CUT);
    transform('fighting-health',`translate(1443px,0px) scaleX(${round(1-ease((p-.55)/.08))}) translate(-1443px,0px)`);
    show('fighting-player-head-tv-open',p<.76);
    show('fighting-player-head-tv-wink',p>=.76);
  }

  if(kind === 'rpg') for(const [key,value] of Object.entries(poses(rpgTime))) transform('full-game-'+key,value);
  else ({fps,platform,rts,moba,fighting})[kind](t);
  return frame;
}

export function createMontage(svg, bar) {
  const nodes = new Map(Array.from(svg.querySelectorAll('#scene-game [id]'),el=>[el.id,el]));
  return (time,filmTime) => {
    const cut = Math.min(GAME_KINDS.length-1,Math.floor(Math.max(0,time)/bar));
    GAME_KINDS.forEach((kind,i)=>{nodes.get('montage-'+kind).style.display=i===cut?'':'none';});
    const kind = GAME_KINDS[cut], local = (time-cut*bar)/bar*GAME_CUT;
    for(const [id,style] of Object.entries(gameFrame(kind,local,filmTime))) Object.assign(nodes.get(id).style,style);
    // The full film adds a friend's reaction; the standalone hero is just play.
    const cheerAt=GAME_CUT*.74;
    const cheer = kind==='fighting' && local>=cheerAt;
    nodes.get('montage-cheer').style.opacity = cheer?'1':'0';
    nodes.get('montage-cheer').style.transform = `translate(${round(-980*(1-ease((local-cheerAt)/(GAME_CUT/8))))}px,0px) translate(435px,670px) rotate(-8deg) translate(-435px,-670px)`;
  };
}
