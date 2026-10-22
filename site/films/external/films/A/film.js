// Film A — 预告状 THE CALLING CARD (graphic collage × industrial microtype). 128 BPM, 34 bars, 64 s, zh / en.
// Module contract: see engine/ENGINE.md. Used by films/A/index.html, tools/render.py and <piik-promo film="A">.
import { Film, clock, h, T, show } from '../../engine/core.js';
import { grainLayer } from '../../engine/tex.js';
import { STRINGS } from './strings.js';
import * as act1 from './s1.js';
import * as act2 from './s2.js';
import * as act3 from './s3.js';
import * as act4 from './s4.js';
import * as act5 from './s5.js';

const u = p => new URL(p, import.meta.url).href;
const F = (family, file, weight) => ({ family, file, ...(weight ? { weight } : {}) });

export const meta = {
  id: 'A',
  title: { zh: '预告状', en: 'The Calling Card' },
  size: [1920, 1080], duration: 64, fps: 60, poster: 10.6, langs: ['zh', 'en'],
  holdEnd: true,
  css: [u('../../engine/film.css'), u('../../engine/brand-mark.css'), u('./style.css')],
  fonts: [
    F('Noto Sans SC', 'NotoSansSC-Variable.ttf', '100 900'),
    F('Noto Serif SC', 'NotoSerifSC[wght].ttf', '200 900'),
    F('ZCOOL QingKe', 'ZCOOLQingKeHuangYou-Regular.ttf'),
    F('Smiley Sans', 'SmileySans-Oblique.ttf'),
    F('ZCOOL KuaiLe', 'ZCOOLKuaiLe-Regular.ttf'),
    F('Anton', 'Anton.ttf'),
    F('Archivo Black', 'ArchivoBlack-Regular.ttf'),
    F('Abril Fatface', 'AbrilFatface-Regular.ttf'),
    F('Bodoni Moda', 'BodoniModa[opsz,wght].ttf', '400 900'),
    F('Rubik Mono One', 'RubikMonoOne-Regular.ttf'),
    F('Bebas Neue', 'BebasNeue-Regular.ttf'),
    F('Barlow Condensed', 'BarlowCondensed-SemiBold.ttf', '600'),
    F('Barlow Condensed', 'BarlowCondensed-ExtraBold.ttf', '800'),
    F('JetBrains Mono', 'JetBrainsMono[wght].ttf', '100 800'),
    F('Arimo', 'Arimo[wght].ttf', '400 700'),
  ],
  audio: { webm: u('../../out/A/audio/web.webm'), m4a: u('../../out/A/audio/web.m4a') },
};

export async function build(stage, { lang = 'zh', signal } = {}) {
  const cues = await (await fetch(u('./cues.json'), { signal })).json();
  const K = clock(cues.bpm, cues.beatsPerBar);
  const film = new Film({ stage, width: 1920, height: 1080, duration: meta.duration, fps: meta.fps, background: '#0d141b', lang });
  film.clock = K;
  film.S = STRINGS[lang] || STRINGS.zh;
  const S = film.S;
  for (const act of [act1, act2, act3, act4, act5]) act.build(film, K);

  // step tracker during the three-step flow (bars 7–12): 01 share → 02 invite → 03 watch
  film.layer('steps', root => {
    const el = h('div', { class: 'abs' }, root);
    Object.assign(el.style, { left: '110px', top: '1012px', display: 'flex', gap: '10px' });
    const items = S.tracker.map((label, i) => {
      const d = h('div', { class: 'nowrap' }, el);
      Object.assign(d.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 16px', border: '3px solid', font: lang === 'en' ? '400 26px/1 Anton' : '900 24px/1 "Noto Sans SC"', letterSpacing: lang === 'en' ? '.06em' : '0', transform: 'skewX(-10deg)' });
      d.innerHTML = `<span style="font:400 26px/1 Anton">0${i + 1}</span><span>${label}</span>`;
      return d;
    });
    const t0 = K.at(7, 1), t1 = K.at(13, 1), starts = [K.at(7, 1), K.at(9, 1), K.at(11, 1)];
    return t => {
      const on = t >= t0 && t < t1;
      show(el, on);
      if (!on) return;
      const light = t >= K.at(11, 1); // step 3 sits on yellow
      const ink = light ? '#121b24' : '#f6f2e8';
      T(el, { x: (1 - Math.min(1, (t - t0) / 0.3)) * -500 });
      items.forEach((d, i) => {
        const cur = t >= starts[i] && (i === 2 || t < starts[i + 1]);
        const done = i < 2 && t >= starts[i + 1];
        d.style.borderColor = ink;
        d.style.background = cur ? '#ffd05a' : done ? ink : 'transparent';
        d.style.color = cur ? '#121b24' : done ? (light ? '#ffd05a' : '#121b24') : ink;
        d.style.opacity = cur || done ? 1 : 0.55;
      });
    };
  }, 900);

  // Finishing texture remains on the held closing card.
  film.layer('finish', root => {
    const vig = h('div', { class: 'fill' }, root);
    vig.style.background = 'radial-gradient(120% 95% at 50% 50%, transparent 62%, rgba(0,0,0,.2) 100%)';
    const grain = grainLayer(root, { W: 1920, H: 1080, opacity: 0.13 });
    return t => grain(t);
  }, 1000);
  return film;
}
