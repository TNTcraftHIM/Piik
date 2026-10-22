# Piik film studio

## Retained films

Keep our latest narrative draft and the six supplied external films. A is the
selected public film. Git owns 1.0 and discarded iterations; do not keep disabled
players, alternate study tracks or old exports beside these sources.

| ID | Film | Source | Language |
| --- | --- | --- | --- |
| `story` | A² · 今晚，缺个对手 | `story/` | Chinese; English finishing remains |
| `a` | A · The Calling Card / 预告状 | `external/films/A/` | English / Chinese |
| `e` | E · Defeat Boredom / 打倒无聊 | `external/films/E/` | English / Chinese |
| `c` | C · Plenty of Room / 沙发够长 | `external/films/C/` | English / Chinese |
| `f` | F · Gold! / 出金了！ | `external/films/F/` | English / Chinese |
| `d` | D · Click, and Watch Together / 一起看，咔哒一下 | `external/films/D/` | English / Chinese |
| `g` | G · Mission Briefing / 作战会议 | `external/films/G/` | English / Chinese |

[`catalogue.js`](./catalogue.js) owns review IDs, display metadata and entry URLs.
The gallery loads one film at a time. Selecting another retires the old document,
including audio and demonstration frames. The external films keep their own
art direction; they do not change product theme tokens.

Film A's Chinese upload covers reuse its cast, game, typography and brand art.
After building, open `/external/films/A/cover.html` for the 1920 × 1080 layout,
or append `?ratio=4:3` for 1440 × 1080. Capture at that viewport after
`document.body.dataset.ready === 'true'`; the narrower cover is separately
composed, not cropped. These authoring pages stay out of the public website.

## Review and embedding

```sh
npm run build:films
npm run preview:films
```

Open `http://127.0.0.1:18896/`. Use `?lang=zh-CN#a`, `#e`, `#story` or another
inventory ID for a direct selection. Browser back/forward changes the film.
The standalone link opens the selected film without the gallery.

Open `http://127.0.0.1:18896/website/?lang=zh-CN` for the actual homepage
embedding preview. Its single film entry opens A on demand and unloads it when
closed. This is a copy of the ordinary website build, with no review-only
player or version switch. `npm run preview:website` serves that ordinary build
directly at `http://127.0.0.1:18890/`.

`build:films` builds the ordinary website, then the independent
`build/film-preview/` artifact. Later website builds do not erase this preview.
The ordinary website build selects only A's required runtime assets from
`site/films/external/`; the complete studio and other films stay out of its
output. The homepage initially downloads no film runtime, fonts or audio.
No external fetch or audio regeneration is needed to build the previews.

The external runtime supports direct embedding:

```html
<script type="module" src="./external/engine/player.js"></script>
<piik-promo film="A" lang="en"></piik-promo>
```

Keep its relative asset tree intact. `embed.html?film=A&lang=en` provides a
standalone document for an iframe; C and F retain their vertical aspect ratios.
The [external package README](./external/README.md) owns its provenance, notices
and audio-authoring boundary. D/G retain the supplied interface snapshot because
their scene geometry depends on it. Treat it as film artwork, not an alternative
product implementation; intentional updates must review that geometry too.

For A², `story/?embedded=1` shows only its player; `story/?t=19.6` opens a paused
frame with chapters and production notes. Space pauses, R restarts, M toggles
sound, F opens fullscreen and the arrow keys step through the edit. Its
`score.js` owns scene and dialogue timing, `party-score.js` owns the game
choreography, and `player.js` owns one native audio clock. `story/ui/` builds
current product components with staged data, without connecting a room.
The independent [`/film/ui/` README fixture](../film/README.md) and A² component
bundles pick up current component code on rebuild;
their staged sequence and camera framing still need review. External A/E/F and
the other authored scenes keep their supplied artwork. D/G use a frozen product
interface bundle. Those pictures do not automatically track product changes;
updating them requires an intentional artwork or snapshot change and review.
Soundtrack editing uses `node site/films/story/sound.mjs` with FFmpeg on PATH
or `FFMPEG` pointing to it. The required audio/font outputs are retained beside
the source; intermediate audio stays under ignored `build/films/story/`.

## Editorial boundary

Screen sharing is the main story: show something worth sharing, send an
invitation, and let friends see it in their browsers. Voice, reactions and
Host-approved remote control help friends participate. The film must stand
alone for somebody who has never seen Piik. Product claims and shared identity
follow [public introduction](../../docs/standards/public-introduction.md) and
[visual language](../../docs/standards/visual-language.md).

Preserve A²'s accepted invitation-to-play story and the external candidates'
distinct visual ideas. Games are editorial demonstrations, not real-session
recordings or latency measurements. Depict one approved remote controller, not
the separate multi-controller experiments. Keep performance claims qualitative.
Keep the external films' supplied wordless voices. Small character nicknames
and scene-specific jokes can add personality; keep actions and permission copy
literal so the story remains clear.
Easter eggs should reward a closer look through familiar gaming or internet
references in handles and background details. They must not need an explanation
or interrupt the story. Localize the reference for each audience rather than
transliterating a nickname or filling every scene with jokes.

The homepage uses A as its only film. The former 1.0 is retained in Git history,
not in the website build or gallery. Selecting another film in this independent
gallery does not change the public selection. Online acceptance precedes
export/publication; remaining work stays in [TODO](../../docs/todo.md).
