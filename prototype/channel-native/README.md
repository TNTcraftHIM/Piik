# Native channel participant

This isolated Rust participant operates rooms through the same [shared `RoomHost` core](../channel-core/README.md)
as the Browser adapter. SQLite stores each room's policy and confirmed history;
the domain supplies admission, directory views and transport leases. Its actual
WebRTC endpoint carries room DataChannels, encoded media and requested file
ranges without retaining file contents in SQLite. The media adapter forwards
Opus, VP8 and H264 Constrained Baseline with packetization mode 1, without
capture, playback or transcoding.

The [network design](../../docs/research/channel-network-design.md) owns the model.
This executable is an explicitly started development host. Chat, history, room voice and files
use the base paths, and screen startup reuses those paths through the same participant.
The default Server embeds one participant for its three rooms and owns its
service lifetime. The App entry below owns its Native hosting endpoint, separately
from the Browser's personal activities. The App reuses the product's site approval
and saved-site interface. Native capture, input and local/public-domain startup
remain subsequent stages.

Each incoming audio/video track keeps its RTP clock and source Sender Report
mapping. Outputs in one flow share a stream while owning separate SSRCs and
bounded writers; WebRTC handles each hop's retransmission and congestion control.
The pinned SDK does not provide RTCP round-trip-time statistics.
Readers, outputs and their completion reports belong to the exact directed flow
lease. Removing that lease retires its work even if the same publication is
subscribed again on the shared connection; the replacement has a new flow ID.
Each outgoing lease references its admitted incoming flow. Incumbent and shadow
inputs can forward concurrently; selecting the shadow preserves its already
warm output, stream, SSRC, source clock and feedback owner.

## RTC Dependency

Native and Server pin `rtc` to commit
`20cce2480fc0975241e1590ea9d018f68d3fabcc` in the temporary
[fork](https://github.com/TNTcraftHIM/rtc/tree/20cce2480fc0975241e1590ea9d018f68d3fabcc).
It contains only [upstream PR #296](https://github.com/webrtc-rs/rtc/pull/296)
on the published 0.21.1 baseline: retire stale RTP extension mappings and preserve
the active section's negotiated IDs. Without this fix, changing voice and screen
tracks on an existing connection can produce an SDP offer the Browser rejects.

Cargo's patch belongs to each workspace root, so both executable manifests carry
the same pin. The fork retains upstream MIT/Apache-2.0 licensing; no build-time
source patch or registry-cache edit is used. When an upstream release includes
the fix, update both pins, run the existing App and Native Browser checks, and
remove both patch entries.

## Run

Start the [domain and shared Web interface](../channel-server/README.md#run),
then run this participant with Rust 1.91. The shared core and Browser/WASM adapter
retain their Rust 1.86 requirement; the newer toolchain belongs to this Native
media dependency.

```powershell
$env:CHANNEL_WS_URL = "ws://127.0.0.1:8791/prototype/channel"
$env:CHANNEL_UI_ORIGIN = "http://127.0.0.1:8790"
$env:PIIK_CHANNEL_NATIVE_KEY = "<the configured domain owner key>"
New-Item -ItemType Directory -Force build/channel-native-data | Out-Null
cargo +1.91.0 run --manifest-path prototype/channel-native/Cargo.toml -- --room build/channel-native-data/lounge.sqlite lounge "Lounge"
```

Use your configured key, never the placeholder. An existing user credential can
instead be supplied through `PIIK_CHANNEL_NATIVE_CREDENTIAL`; the optional
`PIIK_CHANNEL_NATIVE_NAME` selects the user's display name. Credentials are not
printed or saved by this launcher. Reopening saved room data requires the same
authenticated user. Reuse the domain owner's stable key for the example above.

Repeat `--room <database> <id> <name>` to operate several rooms. Each room has a
separate database and an OS file lock held by its runtime. A second process
cannot open that room while the first holds it. Existing files restore their
saved policy; command-line names do not overwrite it. Live calls, captures and
routes are never restored from disk.

Open the normal Web interface in separate Browser profiles, enter the room and
join voice. The Native endpoint is the base root; it does not borrow the domain
administrator page's peer connection. Ctrl+C ends hosting and confirms departure
through the existing domain protocol. An abrupt process loss uses the normal
20-second recovery window.

## Local App Link

The `piik-channel-app` entry uses the same App button, local approval page and
saved-site controls as the shared Web interface. Build the frontend and start it:

```powershell
node node_modules/vite/bin/vite.js build --config prototype/channel-browser/web.vite.config.ts
cargo +1.91.0 run --manifest-path prototype/channel-native/Cargo.toml --bin piik-channel-app
```

The App opens its local page in the system Browser, or the saved starred site.
On a running domain, click **App** and approve the site on that local page.
New rooms then use the App's SQLite storage. The create-room form names the
current hosting runtime. Existing Browser rooms remain in their pages and are
not migrated; a remembered App preference cannot prevent Browser hosting when
the App is absent.

Approval belongs to an exact site origin. Discovery exposes only the local
approval address; the authorized health response supplies the process token.
The token never appears in launch or room invitation URLs. Native verifies the
Browser account through actual domain admission before opening its room data.
Each approved origin owns a separate local namespace; replacing a tunnel origin
does not silently grant access to an earlier site's data.

Closing the page ends its personal calls and shares, while App hosting continues.
Revoking a site's approval stops that site's hosting and control connections,
preserves its saved rooms and leaves other sites running. Reapproving the same
site reuses its data; returning with the same domain account restores its rooms
without restarting personal activities.

The App uses the platform's local application-data directory under `Piik/channel-app`.
`PIIK_CHANNEL_APP_DATA_DIR` selects isolated development data. One process owns
that directory. `PIIK_CHANNEL_APP_PORT` may select a loopback port instead of the
normal discovery range; a launch URL can supply the non-secret `piik-client-port`
query parameter. `PIIK_CHANNEL_APP_WEB_DIR` selects the built frontend and
`PIIK_CHANNEL_APP_NO_BROWSER=1` suppresses browser opening for automated checks.

## Checks

```powershell
cargo +1.91.0 test --manifest-path prototype/channel-native/Cargo.toml
cargo +1.91.0 build --manifest-path prototype/channel-native/Cargo.toml
node prototype/channel-server/run-browser-check.mjs --native
node prototype/channel-server/run-browser-check.mjs --app
```

The Browser check also needs a built domain executable and the existing
`agent-browser` environment. `CHANNEL_NATIVE_EXECUTABLE` and `CHANNEL_EXECUTABLE`
can select separate Native and domain builds; `CHANNEL_APP_EXECUTABLE` selects
the App entry for `--app`. The runner owns its processes,
temporary databases and Browser sessions, and stops them on completion.

The peer check uses real WebRTC endpoints for source replacement, signaling
recovery, encoded audio/video forwarding and feedback under backpressure. The Browser
check covers concurrent Native-rooted picture, voice and file forwarding,
room-owned history, independent picture playback and process restart. Generated evidence stays under
ignored `build/`.
