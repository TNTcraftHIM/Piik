# Third-Party Licenses

Piik-owned code uses the root [MIT license](../LICENSE). Dependencies retain
their own copyright, license and notice requirements.

## Current Packages

The shared Web builder collects installed, lockfile-matched JavaScript notices
and the Browser Rust/WASM adapter's notices into `third-party-licenses.txt`.
Rust App, Server and Android notices use the existing
[cargo-about configuration](./rust-about.toml) and each owning Cargo manifest/lock.
Missing license text or changed pinned contents stops packaging.
The [Native dependency owner](../prototype/channel-native/README.md#rtc-dependency)
records retained Rust repairs and their removal criteria.

App and Android notices also retain the WebRTC FrameDropper's
[LICENSE and PATENTS provenance](../native/third_party/webrtc-frame-dropper/README.md).
Android includes its Kotlin/platform-verifier notices. Linux App notices describe
its unbundled GStreamer, Portal, PipeWire and encoder services through
[system dependency attribution](./linux-system-dependencies.txt).

## Independent Tunnel And Source Attribution

The [pinned source index](./upstream.json) records exact commits and SHA-256
values for Cloudflared, the retained WebRTC SDK and npm packages missing license
files. Retained texts normalize line endings and incidental whitespace only.
Cloudflared's text includes its root and dependency LICENSE, COPYING and NOTICE
files, including platform variants; regenerate its inventory with `go mod vendor`
at the pinned upstream revision. The protobuf text retains Google's BSD varint
attribution. The [Android Cloudflared owner](../mobile/cloudflared/README.md)
describes its independent Go module/toolchain and local overlays.

Published 2.x Native helpers and encoder-probe attribution remain with their
[immutable sources](https://github.com/TNTcraftHIM/Piik/tree/72ca6f2bc97df88e216a392721250309aa53bc39/native)
and matching release artifacts. Retained SDK license texts identify upstream
source provenance; the package owners above generate current distribution notices.

Published 2.x Go dependency repairs and attribution are recorded in the
[immutable public provenance](https://github.com/TNTcraftHIM/Piik/blob/eef70ffda0ffddce6aec109521ab70871e5b7c2f/internal/thirdparty/README.md)
and matching release artifacts.

Dependency changes require explicit rebuilds and review of reachable advisories.
Copied or modified upstream files retain attribution and mark their changes;
public API composition is preferred to maintained source forks. Update the
corresponding pinned text/index when a retained runtime or fixture SDK changes.
