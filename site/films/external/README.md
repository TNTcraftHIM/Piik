# Selected public film A

The owner supplied **The Calling Card / 预告状** in
`Silip-basic-assets-20261021 (2).zip` on 2026-10-21. Its 1920 × 1080 artwork,
64-second timing, bilingual strings and compressed soundtrack come from
`Silip-PV/web/silip-promo/`, with local playback and resource-lifecycle repairs.
The supplied project describes its picture, music, effects and wordless voices
as generated from authored code; this records supplied provenance rather than
independent authorship verification.

Archive SHA-256:
`4cedbc1e240534f5e38c86c76c0214a05c00c174fb721d32852f8f8636477647`.
The original archive remains outside the repository. Other candidate films,
audio authoring sources and the former public film remain in Git history.

The website builder copies A's runtime, per-language subset fonts, Opus/AAC
tracks and notices into one content-hashed directory. It generates the player's
button, toolbar and icon styles from current product owners without shipping
React in the player. The separate README fixture bundles real product components;
[the public-film guide](../../film/README.md) owns that boundary.

Import the built `engine/player.js` and mount `<silip-promo film="A" lang="en">`.
Languages are `zh` and `en`. Each element owns its native audio clock and
`play()`, `pause()`, `seek(seconds)`, `currentTime`, `duration` and `muted`.
Audio loads on play. Leaving the viewport, hiding the page or detaching pauses
playback; resuming is explicit. Detaching retires pending loads and audio.
The closing card stays visible at the end.

Silip code retains [MIT](./licenses/Piik-MIT.txt). Font subsets retain their
supplied SIL OFL notices under `assets/fonts/`. Retrieve full production fonts
from the preserved archive when deliberately updating subsets. This integration
has not independently reproduced the supplied soundtrack.
