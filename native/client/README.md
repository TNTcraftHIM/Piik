# Screener Client

Screener Client is the self-contained and native-capability runtime for the same
Browser application used by Hosted Screener. It does not implement another UI,
room store, signaling protocol, or route controller.

## Modes

- With no mode argument, the Client opens a small launcher in the system
  Browser. It selects Local, a temporary public HTTPS invitation, or a saved
  Site, then enters the normal Host page.
- The launcher remembers the Site address but keeps the per-run room source
  separate. The Client RPC starts before this choice and accepts the saved Site
  alongside the Local Host origin, so Local or Public invite does not disable
  Site enhancement. A Client-opened Site remembers the opt-in in that Browser
  origin; later manually opened Host pages may reuse the running Client.
- `--site`, `--local`, and `--link` remain deterministic automation inputs for
  CI and development. They are not required for normal use.
- The default launcher checks the official GitHub Releases metadata after it
  opens and shows a notice when a newer full-SHA release exists. The check is
  best-effort and never installs or replaces the Client.

Local mode uses memory-only rooms, Browser P2P relay, no LiveKit, and no public
discovery. Ordinary Local works on a reachable LAN. The **Public invite** mode
runs the packaged Cloudflare Tunnel sidecar for the existing HTTP/WebSocket
control surface and
uses one ordinary public STUN destination plus two bounded public survey
destinations. Browser and Native edges share the same prediction rule; Native
STUN, ICE checks, and media use one Pion UDP mux. Media does not
travel through the HTTP tunnel, and a difficult media path still has no SFU or
TURN fallback. The Client chooses a sole private LAN IPv4 automatically. Use
`--lan-address <address>` only when multiple real LAN interfaces are active.

The system Browser remains the Host UI. A Client-launched Host offers the
Browser's standard capture picker and a list of exact platform capture targets;
the user selects one explicitly. Windows offers the same VP8/Auto/H264 selector:
VP8 uses libvpx, H264 uses hardware Media Foundation, and Auto measures target-
profile encoding work before choosing one codec for the share. Windows uses
Graphics Capture and WASAPI; macOS
uses ScreenCaptureKit, VideoToolbox, and AudioToolbox; Linux delegates selection
to the ScreenCast Portal and uses the system PipeWire/GStreamer hardware path.
Video and audio share the same room route and PeerConnection. Native capture
starts with the Host's
current resolution, frame-rate, video/audio bitrate, and quality preference;
live changes replace only the capture/encoder generation behind those stable
connections. A Native edge with public STUN also attempts one bounded PCP,
UPnP, or NAT-PMP mapping for its Pion UDP socket; pure LAN does not. Routers
without a mapping service continue with ordinary ICE/STUN. The mapping does not
create a relay or carry media through the Client control link. A configured Site
may route the native source through its existing Browser LiveKit publisher;
Local and one-link modes remain P2P-only. An ordinary Web Host keeps the
Browser capture path without probing the Client.

Native P2P edges normally reuse that one encoded source and negotiate transport-
wide feedback. Once Pion GCC has real feedback and the source has produced
frames, the Client reports whether that
edge's target payload bitrate can carry the measured shared video plus Opus
payload. The existing route controller owns persistence and any replacement;
the Client does not pace, score, or globally lower the shared encoder. If one
Native sender edge remains persistently degraded, the existing quality operation
may test a stock Browser WebRTC sender for that edge through the local bridge.
Existing Viewer evidence commits or rolls back the candidate; healthy Native
edges continue sharing the selected encode. Native Viewers can receive and
forward either H.264 or VP8 without encoding it again.

The Client configuration keeps an optional Local site-access password. Leave it
blank for an open Local site, or set a visible-ASCII password (8 to 128 bytes)
in the launcher before starting. When present, the Client passes it to its own
Host page in a URL fragment; the page uses the existing SiteAccess endpoint and
removes the fragment before continuing. Viewer invitations keep using the
existing room-scoped grant.

The terminal starts in visual mode and shows the current mode, working entry
links and startup state. Its language follows the launcher and Client-enabled
pages; a block television uses the terminal foreground with golden sparkles,
falling back to ASCII without color support or in very narrow windows.
Visual mode depicts the selected mode and startup state with small scenes;
the television rests with one eye closed and occasionally winks while idle.
Press `o` to reopen the Browser, or `q` / Ctrl+C to end Local
rooms and stop the bundled server and temporary public link. Plain-text output
uses Ctrl+C. A Site-loaded Browser tab does not own the Client process.

For one-link Internet sharing, open the Client launcher, choose **Public invite**,
create a room in the opened Browser, and send its normal invitation link. The
random `trycloudflare.com` origin lasts only for that Client run. Cloudflare Quick
Tunnels provide no uptime guarantee; use a configured Site when persistent
control availability or SFU fallback matters.

## Development

```sh
cd native/client
go test ./...
go vet ./...
go run ./cmd/screener-client \
  --node /path/to/node \
  --app /path/to/Screener
```

The repository-level entry used locally and by CI is:

```sh
npm run check:client
```

On Windows, its generated Client, capture, and media-test executables are
written to the ignored repository `build/client-check` directory and reused on
the next run. This keeps the executable identity stable for the system firewall;
the files are local build output and are never packaged or committed.

It runs Go formatting, unit tests, vet, and the three supported cross-builds.
Each target compiles its isolated capture process and validates its bounded
capability response. macOS additionally encodes one in-memory hardware H.264
IDR; Linux probes the Portal/PipeWire/GStreamer adapter. Real capture, GPU
attribution, Browser decode, and public-network paths remain explicit physical
gates rather than environment-dependent unit tests.

The loopback service binds IPv4 loopback on the first available port from
`39721` through `39730`. `/health` discovers the current process; `/control`
accepts one strict v8 session. After `hello`, an available Client may list local
capture choices, own one generation-fenced Host share, or receive one native
Viewer source and its bounded encoded child edges. Its public `instanceToken`
distinguishes the discovered process but is not authentication; room authority
and remote signaling remain in the Browser. Viewer receive/relay remains
available even when this machine has no accepted native capture encoder.

## Packaging

Build one application release, then assemble a platform Client from that exact
descriptor and a matching platform Node executable. Native capture and the
public-link sidecar are explicit package inputs:

```sh
node scripts/package-app-release.mjs /outside/repository/app-release
SCREENER_GO=/path/to/go \
  node scripts/assemble-client.mjs \
  /outside/repository/app-release/screener-<sha>.release.json \
  /path/to/node \
  /outside/repository/Screener-Client \
  --target windows-amd64 \
  --capture /outside/repository/screener-client-capture.exe \
  --tunnel /outside/repository/cloudflared.exe
```

Supported targets are `windows-amd64`, `linux-amd64`, and `darwin-arm64`.
`--target` controls the Go cross-build and packaged executable names; the Node,
capture, and tunnel inputs must already match that target. Each target accepts
its matching native-capture input.

The result contains:

```text
screener-client[.exe]
REVISION
runtime/node/node[.exe]
runtime/native/screener-client-capture[.exe] # supported native-media packages
runtime/tunnel/cloudflared[.exe] # packages that support --link
app/REVISION
app/dist
app/node_modules
```

The Client executable and application must contain the same full Git revision.
No compatibility reader accepts a mismatched private build.

The Windows Client embeds the shared Screener mark through the
`cmd/screener-client/screener_windows_amd64.syso` resource; the platform
suffix keeps that Windows resource out of Linux and macOS builds.
Linux packages include the standard `share/applications` desktop entry and
hicolor icon. macOS packages include a thin `Screener Client.app` launcher
with an ICNS resource; the raw Go executable remains available beside it.

For a native Host smoke run, launch the Client and select a window in the Host
page. The Client never guesses among multiple targets. The page still creates
the room and sends the current SDP/ICE through the selected authority. A
configured Site supplies its normal Internet routing and SFU fallback. Without
a Site, the **Public invite** choice exposes the Local control surface while
media remains P2P-only.

## Gates

The Local gate starts the packaged process, loads a real built page in Chromium,
proves bootstrap access and LAN invitation construction, and verifies complete
process/profile cleanup. The loopback gate separately proves Site access with
and without Chromium Local Network Access permission. Environment syntax below
is POSIX; use equivalent variables on Windows.

```sh
SCREENER_CLIENT_LOCAL_GATE=true \
CHROME_PATH=/path/to/chrome \
SCREENER_CLIENT_EXE=/path/to/screener-client \
SCREENER_CLIENT_NODE=/path/to/node \
SCREENER_CLIENT_APP=/path/to/app \
SCREENER_CLIENT_GATE_LAN_ADDRESS=192.168.1.10 \
npm run gate:client-local

SCREENER_CLIENT_LOOPBACK_GATE=true \
CHROME_PATH=/path/to/chrome \
SCREENER_CLIENT_EXE=/path/to/screener-client \
npm run probe:client-loopback

SCREENER_CLIENT_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
npm run gate:client-media

SCREENER_CLIENT_NATIVE_HOST_GATE=true \
CHROME_PATH=/path/to/chrome \
SCREENER_GO=/path/to/go \
npm run gate:client-native-host

SCREENER_CLIENT_NATIVE_HOST_GATE=true \
SCREENER_CLIENT_CROSS_NAT_GATE=true \
CHROME_PATH=/path/to/chrome \
SCREENER_GO=/path/to/go \
SCREENER_REMOTE_HOST=<public-test-host> \
SCREENER_REMOTE_USER=<ssh-user> \
SCREENER_REMOTE_SSH_KEY=/path/to/key \
SCREENER_CLIENT_GATE_STUN_URLS=stun:<stun-host>:3478 \
npm run gate:client-cross-nat

SCREENER_CLIENT_NATIVE_HOST_GATE=true \
SCREENER_CLIENT_LINK_MEDIA_GATE=true \
CHROME_PATH=/path/to/chrome \
SCREENER_GO=/path/to/go \
SCREENER_CLOUDFLARED=/path/to/cloudflared \
SCREENER_REMOTE_HOST=<public-test-host> \
SCREENER_REMOTE_USER=<ssh-user> \
SCREENER_REMOTE_SSH_KEY=/path/to/key \
npm run gate:client-link-media

SCREENER_CLIENT_LINK_GATE=true \
SCREENER_GO=/path/to/go \
SCREENER_CLOUDFLARED=/path/to/cloudflared \
SCREENER_REMOTE_HOST=<public-test-host> \
SCREENER_REMOTE_USER=<ssh-user> \
SCREENER_REMOTE_SSH_KEY=/path/to/key \
npm run gate:client-link
```

The loopback health response reports video, process-audio, system-audio, and
hardware H.264 availability separately. The Windows media gate proves one hardware-H.264
capture generation, shared Pion source, Browser decode, PLI recovery, and STUN
candidate gathering. The native Host gate proves room creation and native video
delivery through the current route; native audio is included when the capability
probe and target OS support it. The cross-NAT variant uses a temporary reverse
SSH path for signaling only and requires a selected `srflx` or `prflx` media pair;
media never travels through SSH. The one-link media variant instead carries the
same signaling through the Client's temporary public origin and requires direct
media delivery to an independent Linux peer. Native P2P quality evidence and the
Browser-mediated SFU path have dedicated gates. macOS and Linux capture still
require physical desktop/media gates; CI compilation and package smoke do not
substitute for them.
