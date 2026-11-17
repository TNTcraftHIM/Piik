# Native MPD resources

This crate resolves explicitly selected tracks from an immutable, clear static
MPD. The approved page owns the input and opaque choice IDs. Public
`mpd-parser` APIs own MPD inheritance, logical playlists and segment expansion;
Piik maps the selected resources to IDs and serializes the selected manifest.

Each operation runs the fixed resolver bundle in a short-lived `rquickjs`
context. The only host function resolves URLs through Rust's `url` crate.
There are no JavaScript network, filesystem, process or module-loader APIs.
The caller's source cancellation feeds QuickJS's interrupt handler. Runtime
and context handles are dropped when the operation exits; cancelling the async
caller does not synchronously join an already-running blocking worker.

`Limits` separates caller-owned manifest/resource admission from engine heap
and stack budgets. The App currently supplies a 64 MiB heap and 1 MiB stack
engineering budget; these are not DASH requirements. Encoded fragment limits
and 64 KiB read windows belong to the shared media-resource owner.

From the repository root:

```sh
npm run build:mpd
node scripts/build-mpd-resolver.mjs --check
cargo +1.91.0 test --locked --manifest-path prototype/channel-mpd/Cargo.toml
```

The generator rebuilds `src/resolver.js` and `THIRD-PARTY-NOTICES.txt`.
`--check` compares both outputs without writing them and runs through the
normal `check:rust` entry. Keep the generated bundle with its source and pinned
npm lock. Native `rquickjs`/QuickJS-NG licenses and the bundled JavaScript
notices are included by the existing package license collector. Android uses
the binding's `bindgen` feature with the existing NDK toolchain.

The clear fixtures `bbb.mpd` and `envivio.mpd` are public DASH sample metadata
from `dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` and
`dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd`. `angel-one.mpd` is Shaka's
public sample at `storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd`.
The multi-period structural fixture derives from Video.js `mpd-parser` 1.4.1
`test/manifests/multiperiod.mpd` (Apache-2.0): protection declarations were removed
only to exercise clear metadata structure; no media or decryption is involved.
Tests make no requests to these public origins. They cover selection, ranges,
serialization and retirement; normal WebView discovery and account-backed
website playback require separate application acceptance.
