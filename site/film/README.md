# Piik film

The homepage links to this optional, 38-second introduction. Serve `site/` with
any static HTTP server and open `/film/`. It also works below a project prefix,
such as `/Piik/film/`; GitHub Pages needs no additional service or build step.

`art.js` owns the original SVG artwork and seekable musical score. `player.js`
owns playback, sound and controls. Audible playback follows the audio element's
clock, including buffering. Muted playback uses a monotonic clock and does not
request the soundtrack. All artwork follows the same position; there are no
independent CSS animation loops or scene timers.

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
The excerpt uses the opening 38.019802 seconds, fading out from 35.64 seconds.
[The asset notice](./assets/NOTICE.txt) retains source, attribution and modification
details. The music keeps its own license, separate from Piik's MIT license.

To reproduce the audio edit from the linked original:

```sh
ffmpeg -i Funkorama.mp3 -vn -t 38.019802 \
  -af afade=t=out:st=35.64:d=2.379802 \
  -c:a libmp3lame -b:a 160k -map_metadata -1 funkorama.mp3
```

## Focused check

Open a fresh local film page in a named `agent-browser` session, then evaluate
[`scripts/check-website-film.js`](../../scripts/check-website-film.js) using
`agent-browser --session <session> eval --stdin`. The browser check covers lazy
audio, playback/seek/replay, language links, obsolete play promises and audio
failure/ending. Visual acceptance still requires watching the complete film,
checking both languages, narrow layouts and the clean recording view.
