# Piik film

The homepage links to this optional, 57-second introduction. Serve `site/` with
any static HTTP server and open `/film/`. It also works below a project prefix,
such as `/Piik/film/`; GitHub Pages needs no additional service or build step.

`art.js` owns the original SVG artwork and seekable musical score. `player.js`
owns playback, sound and controls. Audible playback follows the audio element's
clock, including buffering. Muted playback uses a monotonic clock and does not
request the soundtrack. All artwork follows the same position; there are no
independent CSS animation loops or scene timers.

The film follows the actual App flow: unpack/open, choose **Public invite**,
select a source, then copy the invite for friends to watch in a browser.
“No server of your own” refers to App public-invite mode, which still uses a
temporary control tunnel and needs Internet access. The encoding-reuse claim
applies to compatible connections; it is not a universal CPU-usage benchmark.

`assets/ui/` contains lossless WebP captures at 2× resolution from the accepted
UI at `0109030d`: the actual launcher, Host page, source picker and production
Viewer components. Window names, room information and participants are samples;
the sequence is staged. Update these captures when the product UI changes, and
check the video rectangles and cursor targets in `art.js` after recapturing.

[`../assets/game.js`](../assets/game.js) owns the original **DOT DASH** scene.
The film composites it into the captured video surfaces using the film clock.
The homepage's standalone SVG embeds CSS sampled from that same score, so it
also works as a README image without scripts or external asset references.
After changing the game, run `node scripts/update-website-game.mjs` from the
repository root; `--check` detects an out-of-date hero. Its `#still` fragment
and the system reduced-motion preference disable the loop.

The poster waits for an explicit play action. System reduced-motion preferences
keep a still preview, with manual playback available. System colour preference
styles the surrounding page; the film retains its authored colours. The homepage
and film carry explicit language/theme choices through their links. No cookies,
external fonts, analytics or new runtime dependencies are used.

## Recording

1. Open the film in the desired language, start playback and select the
   fullscreen button. This removes all site navigation and player controls.
2. Capture browser video and audio at **1920 × 1080, 60 fps**. Press **R** to
   restart from the first frame; **Space** pauses and **M** toggles sound.
   Switching away from the page pauses playback.
3. Press **Escape** to leave the clean view. Retain the music attribution in the
   end card and in the published recording's description.

## Music

“[Funkorama](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100474)”
by Kevin MacLeod (incompetech.com), under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The excerpt uses the opening 57.029703 seconds, fading out from 54.653465 seconds.
[The asset notice](./assets/NOTICE.txt) retains source, attribution and modification
details. The music keeps its own license, separate from Piik's MIT license.

To reproduce the audio edit from the linked original:

```sh
ffmpeg -i Funkorama.mp3 -vn -t 57.029703 \
  -af afade=t=out:st=54.653465:d=2.376238 \
  -c:a libmp3lame -b:a 160k -map_metadata -1 funkorama.mp3
```

## Focused check

Open a fresh local film page in a named `agent-browser` session, then evaluate
[`scripts/check-website-film.js`](../../scripts/check-website-film.js) using
`agent-browser --session <session> eval --stdin`. The browser check covers lazy
audio, playback/seek/replay, language links, obsolete play promises, native media
pause and audio failure/ending. Visual acceptance still requires watching the
complete film, checking both languages, narrow layouts and the clean recording view.
