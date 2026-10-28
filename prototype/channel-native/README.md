# Native channel participant

This isolated Rust participant operates rooms through the same `RoomHost` core
as the Browser adapter. SQLite stores each room's policy and confirmed history;
the domain supplies admission, directory views and transport leases. Its actual
WebRTC endpoint carries room DataChannels, encoded media and requested file
ranges without retaining file contents in SQLite. The media adapter forwards
Opus, VP8 and H264 Constrained Baseline with packetization mode 1, without
capture, playback or transcoding.

The [network design](../../docs/research/channel-network-design.md) owns the model.
This executable is an explicitly started development host. It does not make a
standby Piik App take over a closed page's room. Chat, history, room voice and files
use the base paths, and screen startup reuses those paths through the same participant.
Native capture and App/Server hosting-session integration remain subsequent stages.

Each incoming audio/video track keeps its RTP clock and source Sender Report
mapping. Outputs share a publication stream while owning separate SSRCs and
bounded writers; WebRTC handles each hop's retransmission and congestion control.
The pinned SDK does not provide RTCP round-trip-time statistics.
Readers, outputs and their completion reports belong to the exact directed flow
lease. Removing that lease retires its work even if the same publication is
subscribed again on the shared connection; the replacement has a new flow ID.

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

## Checks

```powershell
cargo +1.91.0 test --manifest-path prototype/channel-native/Cargo.toml
cargo +1.91.0 build --manifest-path prototype/channel-native/Cargo.toml
node prototype/channel-server/run-browser-check.mjs --native
```

The Browser check also needs a built domain executable and the existing
`agent-browser` environment. `CHANNEL_NATIVE_EXECUTABLE` and `CHANNEL_EXECUTABLE`
can select separate Native and domain builds. The runner owns its processes,
temporary databases and Browser sessions, and stops them on completion.

The peer check uses real WebRTC endpoints for source replacement, signaling
recovery, encoded audio/video forwarding and feedback under backpressure. The Browser
check covers concurrent Native-rooted picture, voice and file forwarding,
room-owned history, independent picture playback and process restart. Generated evidence stays under
ignored `build/`.
