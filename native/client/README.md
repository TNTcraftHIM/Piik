# Screener Client

Screener Client is the self-contained and native-capability runtime for the same
Browser application used by Hosted Screener. It does not implement another UI,
room store, signaling protocol, or route controller.

## Modes

- With no mode argument, the Client opens a small launcher in the system
  Browser. It selects Local, a temporary public HTTPS invitation, or a saved
  Site, then enters the normal Host page.
- The launcher remembers the Site address but keeps the per-run mode choice
  separate. Local and one-link modes retain the self-contained authority; a
  configured Site owns rooms, persistence, routing, and SFU.
- `--site`, `--local`, and `--link` remain deterministic automation inputs for
  CI and development. They are not required for normal use.
- The default launcher checks the official GitHub Releases metadata after it
  opens and shows a notice when a newer full-SHA release exists. The check is
  best-effort and never installs or replaces the Client.

Local mode uses memory-only rooms, Browser P2P relay, no LiveKit, and no NAT
prediction. Ordinary Local works on a reachable LAN. The **Public invite** mode
runs the packaged Cloudflare Tunnel sidecar for the existing HTTP/WebSocket
control surface and
uses Cloudflare's public STUN for ordinary Browser media edges. Media does not
travel through the HTTP tunnel, and a difficult media path still has no SFU or
TURN fallback. The Client chooses a sole private LAN IPv4 automatically. Use
`--lan-address <address>` only when multiple real LAN interfaces are active.

The system Browser remains the Host UI. A Client-launched Host offers the
Browser's standard capture picker and a list of exact platform capture targets;
the user selects one explicitly. The Client selects one available hardware
H.264 path. The current Windows sidecar uses Graphics Capture and, on supported
builds, captures that process's audio with WASAPI. Video and audio share the
same room route and PeerConnection. Native media in Site or one-link mode also
attempts one bounded PCP, UPnP, or NAT-PMP
mapping for its sole Pion UDP socket; pure LAN Local mode does not. Routers
without a mapping service continue with ordinary ICE/STUN. The mapping does not
create a relay or carry media through the Client control link. A configured Site
may route the native source through its existing Browser LiveKit publisher;
Local and one-link modes remain P2P-only. An ordinary Web Host keeps the
Browser capture path without probing the Client.

Native P2P edges negotiate transport-wide feedback. Once Pion GCC has real
feedback and the source has produced frames, the Client reports whether that
edge's target payload bitrate can carry the measured shared H.264 plus Opus
payload. The existing route controller owns persistence and any replacement;
the Client does not pace, score, or globally lower the shared encoder.

The first Local launch creates one random access password in the user
configuration directory. The Client passes it to its own Host page in a URL
fragment; the page uses the existing SiteAccess endpoint and removes the
fragment before continuing. Viewer invitations keep using the existing
room-scoped grant.

Press Enter in the Client console to end Local rooms and stop the bundled
server and any temporary public link. A Site-loaded Browser tab does not own the
Client process.

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
On Windows and macOS it also compiles the matching isolated capture process and
validates its bounded capability response; macOS additionally encodes one
in-memory hardware H.264 IDR. Real capture, GPU attribution, Browser decode, and
public-network paths remain explicit physical gates rather than environment-
dependent unit tests.

The loopback service binds IPv4 loopback on the first available port from
`39721` through `39730`. `/health` discovers the current process; `/control`
accepts one strict v5 session. After `hello`, an available Client may list local
capture choices and own one generation-fenced share's SDP/ICE edges, including
one reserved local Browser bridge. Its public `instanceToken` distinguishes the
discovered process but is not authentication; room authority and remote
signaling remain in the Browser.

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
capture, and tunnel inputs must already match that target. Windows and macOS
accept their matching native-capture input; Linux currently retains Browser
capture.

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
Browser-mediated SFU path have dedicated gates. macOS capture still requires a
native runner gate; Linux native capture remains unaccepted.
