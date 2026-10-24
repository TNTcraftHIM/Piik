# Android cloudflared adapter

`scripts/build-android.mjs` builds the official cloudflared source pinned by
`scripts/app-package-targets.mjs` and `licenses/upstream.json`. Its archive is
SHA256 checked. Original extracted source remains unchanged in the ignored build
cache; Go overlays add the Piik MIT-licensed Android adapter and apply the small
supervisor patch. Neither module graph nor Go toolchain is patched.

`android_dns.go` sends stock Go Resolver DNS messages through Android API 29
`android_res_nsend/nresult/cancel`. It keeps Android's default network, VPN and
Private DNS handling. Go retains DNS parsing, retry and SRV ordering. The NDK
result FD has one owner: `nresult` consumes it, or cancellation closes it, never
both. A context wake pipe interrupts waiting without polling or a sampling timer.
Closing the Go connection cancels and joins its relay.

`edge-fallback.patch` makes an exhausted QUIC dial failure enter the existing
HTTP2 fallback, including quic-go's separate `HandshakeTimeoutError`. Address
retry limits and explicit protocol selection remain upstream-owned. The focused
test is overlaid into the upstream package; it does not ship in the helper.
The patch applies only to the Android source build. Desktop packages still ship
the official prebuilt cloudflared executable and do not include this correction.

Both the full Android builder and `node scripts/build-android.mjs --tunnel-only`
compile the focused fallback test to `build/android-cloudflared/fallback.test`
(`.exe` on Windows) and run it before building the helpers. They do not run the
full upstream test suite. The latter entry needs only the existing Go toolchain
and `ANDROID_NDK_HOME`, and also performs the Android PIE/16KB ELF checks.

Sources:

- <https://developer.android.com/ndk/reference/group/networking>
- <https://android.googlesource.com/platform/system/netd/+/refs/heads/android15-release/client/NetdClient.cpp>
- <https://github.com/cloudflare/cloudflared/blob/de6376c5af4a67cbc65258682e5a01781827643d/supervisor/tunnel.go>

The APK's existing third-party notice includes the pinned cloudflared source and
dependency licenses. Generated source overlays, probes and executables remain
ignored. No test command or environment switch is added to the shipped CLI.
