# Piik film

The homepage expands this optional, 76-second introduction in an iframe loaded
only on request. Closing it unloads playback; the frame follows the homepage's
language and theme. The player document also supports local recording and
focused checks. From the repository root, run `npm run build:website` and
`npm run preview:website`, then open
`http://127.0.0.1:18890/film/`. Publish the static `build/site/` output. A project
prefix such as `/Piik/film/` also works; GitHub Pages needs no application server.

`score.js` owns the 101 BPM beat/bar grid used by cuts and staged UI actions.
`art.js` owns the original SVG artwork and seekable sequence; `../assets/games.js`
owns the six original gameplay vignettes and their action/result sequence. `player.js`
owns playback, sound and controls. Audible playback follows the audio element's
clock, including buffering. The host must support HTTP byte ranges for seeking;
the Vite preview command does. Muted playback uses a monotonic clock and does not
request the soundtrack. Artwork and the demonstration's CSS animations follow
this same position, including pause, seek and replay. After natural completion,
only the closing mascot continues its native idle loop; an explicit pause or
seek freezes it, and reduced motion keeps it still.

The film follows the App flow in five steps: scroll to the website downloads,
unpack the complete package and open the App, choose **Public invite**, select a
source, then copy and send the invite through an external chat example before
friends watch in a browser. Public invitations
need Internet access and a temporary control tunnel. The public pages use the
[copy guide's information layers](../../docs/reference/naming.md#voice-and-terminology).

`ui/main.tsx` uses the product's actual launcher form, source picker, TV, sofa and
control primitives with sample inputs. The build also supplies the current
homepage HTML and styles to `ui/website.ts`, whose scrolling follows the same
film position; the desktop is an illustration of the unpacked Windows package.
The website and App run in separate opaque, inert iframes with
script permission only; they cannot persist preferences to the App or request
capture. No room connection, API interception or media permission is simulated.
The existing build dependency bundles these components; rebuilding the website
picks up their styling and copy. Review scene selection and camera framing when
the product workflow changes. Cursor targets follow component elements, not
screenshot coordinates.

Each cursor movement starts at the preceding control and has its own travel
interval. Derive the entire pose from the requested time; do not accumulate
cursor history or start a second animation clock. The source preview and drawing
scene share `../assets/sketch.js`, including a seekable pencil trace.
Opening the App leads to its mode form and then the room. Keep the window's
position continuous through these steps. The neutral chat example retains the
copy control beneath it to anchor the next cursor movement, with its own title
and sample message clearly outside Piik's interface.

The film reuses the product's playback control and `BrandMark` CSS, plus `Glyph` icons rendered
to static markup during the website build. Its score and audio remain owned by
`player.js`; the live viewer's stream binding, audio gain, reconnect and picture
in picture remain in `PlaybackControls`. A shared appearance does not require
giving a recorded sequence live-room state.

[`../assets/game.js`](../assets/game.js) owns the original RPG
scene. The film and demonstration TV render it using the film clock.
The film's six game vignettes share pure poses in `../assets/games.js`.
`../assets/activities.js` composes the homepage's RPG, drawing, photos and movie
from shared artwork. Its standalone SVG embeds sampled CSS at five seconds per
activity, and also serves as the README image. The build tool removes repeated
samples during holds.
After changing the artwork, run `node scripts/update-website-hero.mjs` from the
repository root; `--check` detects an out-of-date hero. Its `#still` fragment
and the system reduced-motion preference disable the loop.

The poster waits for an explicit play action. System reduced-motion preferences
keep a still preview, with manual playback available. System colour preference
styles the surrounding page; the film retains its authored colours. The homepage
and film carry explicit language/theme choices through their links. No cookies,
external fonts, analytics or new runtime dependencies are used.

## Recording

1. Open the standalone film in the desired language, start playback and select
   fullscreen. Normal fullscreen keeps playback and exit controls available.
   Press **C** to hide or restore controls for recording.
2. Capture browser video and audio at **1920 × 1080, 60 fps**. Press **R** to
   restart from the first frame; **Space** pauses and **M** toggles sound.
   Switching away from the page pauses playback.
3. Press **Escape** to leave the clean view. Retain the music attribution in the
   end card and in the published recording's description.

## Music

“[Funkorama](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100474)”
by Kevin MacLeod (incompetech.com), under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The excerpt uses the opening 76.039604 seconds (32 bars), fading out over the
last two beats from 74.851485 seconds. At bar 29, the download banner enters over
the existing brand and living room. Its link uses the homepage's platform downloads;
the mascot uses the loading screen's repeating wink and gold sparkles.
[The asset notice](./assets/NOTICE.txt) retains source, attribution and modification
details. The music keeps its own license, separate from Piik's MIT license.

To reproduce the audio edit from the linked original:

```sh
ffmpeg -i Funkorama.mp3 -vn -t 76.039604 \
  -af afade=t=out:st=74.851485:d=1.188119 \
  -c:a libmp3lame -b:a 160k -map_metadata -1 funkorama.mp3
```

## Focused check

Open a fresh local film page in a named `agent-browser` session and run
`agent-browser --session <session> click '#language'` to grant the user gesture
required by native audio. Then evaluate
[`scripts/check-website-film.js`](../../scripts/check-website-film.js) using
`agent-browser --session <session> eval --stdin`. The browser check covers lazy
audio, playback/seek/replay, language links, obsolete play promises, native media
pause, audio failure/ending, bilingual headline bounds, unobscured scenario
objects, cursor continuity/reverse seeking and the standalone hero's CSS poses
against the shared game score. Visual acceptance still requires watching the
complete film, checking both languages, narrow layouts and the clean recording view.
