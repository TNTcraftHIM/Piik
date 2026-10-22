# External film candidates

The owner supplied these six code-driven films in
`Piik-basic-assets-20261021 (2).zip` on 2026-10-21. The runtime comes from
`Piik-PV/web/piik-promo/`, with playback and resource-lifecycle repairs; the
active audio-generation sources are retained separately under `authoring/`. The
original archive remains outside the repository. The supplied project describes
its picture, music, effects and wordless voices as generated from authored code;
that statement records its provenance, rather than independent authorship verification.

Archive SHA-256:
`4cedbc1e240534f5e38c86c76c0214a05c00c174fb721d32852f8f8636477647`.

| ID | Title | Size | Duration |
| --- | --- | --- | --- |
| A | 预告状 / The Calling Card | 1920 × 1080 | 64 s |
| C | 沙发够长 / Plenty of Room | 1080 × 1920 | 20 s |
| D | 一起看，咔哒一下 / Click, and Watch Together | 1920 × 1080 | 52 s |
| E | 打倒无聊 / Defeat Boredom | 1920 × 1080 | 58 s |
| F | 出金了！ / Gold! | 1080 × 1920 | 36 s |
| G | 作战会议 / Mission Briefing | 1920 × 1080 | 46 s |

A is selected for the public website. The website builder copies only its
required runtime, font, compressed audio and license files into a content-hashed
directory. The independent film-preview builder copies all six runtimes,
excluding authoring sources and this README. The other films and current
narrative candidate remain available in the review catalogue; the former 1.0
is retained only in Git history.

Import `engine/player.js` and mount `<piik-promo film="A" lang="en">`.
Load `../player-theme.css` alongside it for Piik's shared control tokens; both
website and studio builds include this stylesheet and generate
`engine/playback-controls.js` from the product's button, toolbar and icon owners.
Use the built runtime when embedding; the player does not ship a React runtime.
Languages are `zh` and `en`; omitting `lang` uses the document language.
`play()`, `pause()`, `seek(seconds)`, `currentTime`, `duration` and `muted` belong
to that element. Playback uses one native audio element; audio loads on play.
Leaving the viewport, hiding the page or detaching pauses playback. Resuming is
explicit. Detaching also retires pending loads, nested interfaces and audio.
Optional `autoplay` requests muted playback and respects reduced motion;
browser denial keeps the explicit play controls available. `loop`, `poster` and
`controls="none"` remain available for isolated previews.

All asset paths are module-relative. D/G retain their same-origin staged UI
snapshot because their drivers measure and decorate its DOM. Their film document
must support that relationship; the existing opaque-origin study sandbox is not
compatible. The fixture's CSP blocks service connections and form submission.
It is demonstration data, not a live Piik session or performance measurement.

The frame artwork, cue timing and audio were retained. Small edits to secondary
character tags and background chat add contextual jokes; updated font subsets
include the new glyphs. Local changes replace
Web Audio bookkeeping with native media playback, make controls keyboard
accessible, fence asynchronous selection changes, and consolidate D/G's iframe
driver with bounded readiness and explicit disposal. Unused authoring playback,
full-font and WAV paths and nonessential style-reference names were removed.

`engine/cast.js` owns the localized character handles used by the authored
scenes. D/G's frozen interface snapshot has the same three English handles in
its sample cast; that data was deliberately updated without changing bundled
product logic. Keep those sample labels aligned when editing the cast.

Subset fonts and compressed Opus/AAC tracks are the runtime assets. Editable
scores, synthesis, mixing and export sources for all six films are retained under
[authoring](./authoring/README.md), outside the candidate runtime. Virtual
environments, full fonts, render outputs and retired B are omitted. Retrieve the
original production fonts from `Piik-PV/assets/fonts/` in the preserved archive
when rebuilding subsets. This import has not executed the audio build sources
or independently reproduced the supplied soundtrack.

Piik code retains [MIT](./licenses/Piik-MIT.txt). The staged UI includes React,
React DOM and scheduler under [MIT](./licenses/React-MIT.txt), alongside its
linked bundle notice. Fonts retain their supplied SIL OFL notices under
`assets/fonts/`; `FusionPixel-LICENSES/` preserves the three upstream font notices
omitted from the supplied web pack. Third-party license text is preserved; trailing whitespace is normalized.
