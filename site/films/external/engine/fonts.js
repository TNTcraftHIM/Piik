// Per-film, per-language subset fonts for the candidate player.
const loaded = new Map();
const stem = f => f.replace(/\.(ttf|otf|woff2?)$/i, '');

export function fontURL(meta, font, lang) {
  return new URL('../assets/fonts/subset/' + meta.id + '-' + lang + '/' + stem(font.file) + '.woff2', import.meta.url).href;
}

/** Register and load every font a film declares for `lang`. Resolves when all are ready. */
export async function loadFonts(meta, lang) {
  const jobs = [];
  for (const f of meta.fonts || []) {
    if (f.langs && !f.langs.includes(lang)) continue;
    const url = fontURL(meta, f, lang);
    const key = `${f.family}|${f.weight || ''}|${url}`;
    if (!loaded.has(key)) {
      const face = new FontFace(f.family, `url("${url}")`, { weight: f.weight || 'normal', style: f.style || 'normal', display: 'block' });
      loaded.set(key, face.load().then(ff => { document.fonts.add(ff); }).catch(error => { loaded.delete(key); throw error; }));
    }
    jobs.push(loaded.get(key));
  }
  await Promise.all(jobs);
}
