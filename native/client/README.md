# Screener Client

Screener Client is the self-contained and native-capability runtime for the same
Browser application used by Hosted Screener. It does not implement another UI,
room store, signaling protocol, or route controller.

## Modes

- With no saved Site, the Client starts the bundled TypeScript server in Local
  mode and opens `http://localhost:<port>` in the system Browser.
- `--site <origin>` saves a Site and opens it on later launches. The Site owns
  rooms, persistence, routing, and SFU; the Client remains available through its
  loopback service for native media.
- `--public` selects the built-in official Site without requiring the user to
  type an origin; it uses the same persisted Site path as `--site`.
- `--local` clears the saved Site choice and returns to the self-contained Local
  authority.

Local mode uses memory-only rooms, Browser P2P relay, no LiveKit, and no NAT
prediction. It works on a reachable LAN; a difficult Internet path has no SFU
fallback. The Client chooses a sole private LAN IPv4 automatically. Use
`--lan-address <address>` only when multiple real LAN interfaces are active.

For a native Host, add `--native`. The system Browser remains the Host UI; the
Client selects one Windows Graphics Capture target and one hardware H.264
encoder, and on supported Windows builds captures that process's audio with
WASAPI. Video and audio share the same room route and PeerConnection. Native
media is currently P2P-only; omitting `--native` keeps the ordinary Browser
capture path. `--public --native` uses the built-in Site for public signaling;
`--local --native` is the self-contained LAN form.

The first Local launch creates one random access password in the user
configuration directory. The Client passes it to its own Host page in a URL
fragment; the page uses the existing SiteAccess endpoint and removes the
fragment before continuing. Viewer invitations keep using the existing
room-scoped grant.

Press Enter in the Client console to end Local rooms and stop the bundled
server. A Site-loaded Browser tab does not own the Client process.

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
On Windows it also compiles the isolated capture process and validates its
bounded capability response. Real capture, GPU attribution, Browser decode, and
public-network paths remain explicit physical gates rather than environment-
dependent unit tests.

The loopback service binds IPv4 loopback on the first available port from
`39721` through `39730`. `/health` discovers the current process; `/control`
accepts one strict v2 session. After `hello`, an available Windows Client may
list local capture choices and own one generation-fenced share's SDP/ICE edges.
Its public `instanceToken` distinguishes the discovered process but is not
authentication; room authority and remote signaling remain in the Browser.

## Packaging

Build one application release, then assemble a platform Client from that exact
descriptor and a matching platform Node executable. A Windows package may add
the independently built capture process as the final argument:

```sh
node scripts/package-app-release.mjs /outside/repository/app-release
SCREENER_GO=/path/to/go \
  node scripts/assemble-client.mjs \
  /outside/repository/app-release/screener-<sha>.release.json \
  /path/to/node \
  /outside/repository/Screener-Client \
  /outside/repository/screener-client-capture.exe
```

The result contains:

```text
screener-client[.exe]
REVISION
runtime/node/node[.exe]
runtime/native/screener-client-capture.exe # Windows native-media package only
app/REVISION
app/dist
app/node_modules
```

The Client executable and application must contain the same full Git revision.
No compatibility reader accepts a mismatched private build.

For a native Host smoke run, start the Client with `--native` and optionally
`--native-window-title <text>`. The Client opens the normal Host page with a
one-share native capture request; the page still creates the room and sends
the current SDP/ICE through the configured Site. A configured Site is required
for cross-network viewers. Without a Site, the bundled Local authority is
reachable only where its invitation address is reachable (normally the LAN).

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
```

The loopback health response reports window-video, process-audio, and hardware
H.264 availability separately. The Windows media gate proves one hardware-H.264
capture generation, shared Pion source, Browser decode, PLI recovery, and STUN
candidate gathering. The native Host gate proves room creation and native video
delivery through the current route; native audio is included when the capability
probe and target OS support it. The cross-NAT variant uses a temporary reverse
SSH path for signaling only and requires a selected `srflx` or `prflx` media pair;
media never travels through SSH. Native SFU, native quality evidence, and
macOS/Linux capture remain gated.
