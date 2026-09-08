# Third-Party Licenses

Screener-owned code uses the root [MIT license](../LICENSE). Dependencies retain
their own licenses; MIT does not replace their copyright notices or terms.

The [pinned source index](./upstream.json) records exact upstream commits and
SHA-256 values for Cloudflared, the WebRTC SDK, and npm packages that omit license
files.
The retained text normalizes line endings and incidental whitespace only.
The Cloudflared text includes its source distribution's root and all vendored
LICENSE, COPYING, and NOTICE files, including platform variants. The protobuf
text also preserves Google's BSD-licensed varint attribution.
The Windows capture adapter statically links the pinned WebRTC SDK, including
its libvpx encoder. The Client's native notices retain the SDK's collected
third-party license texts; these dependencies do not become MIT-licensed merely
because Screener's adapter is MIT-licensed.
Linux packages that include the native capture binary include
`linux-system-dependencies.txt`, the full LGPL-3.0-only text for libportal, and
the full GPL-3.0 text referenced by that license. The system shared libraries
and services are not bundled; the package still carries the license texts for
the linked capture path. Packages without native capture do not include these
capture-specific notices.

`npm run dev` and `npm run build:client` generate `/third-party-licenses.txt`
offline from installed, lockfile-matched Web runtime dependencies.
The application release and Client assembly each add the Go toolchain notice
and the license files of the modules actually compiled into that binary; the
Client package also carries the pinned Cloudflared notices. Missing license
texts or changed pinned contents stop packaging.

LiveKit media-core packages are referenced as an unmodified, version-pinned Go
module under Apache-2.0. Original Screener adapters remain MIT; adapted upstream
probe orchestration retains its Apache-2.0 attribution in the source. Redistribution retains
the module's license and applicable notices through the same Go notice collector.
Any later copied or modified upstream file must retain its attribution and mark
the modification. Prefer public API composition over a maintained source fork.

Dependency updates are explicit rebuilds, not live updates in a running binary.
Review relevant upstream advisories and actual reachable dependencies at release;
an affected serious vulnerability warrants an earlier update. Mature media code
is not exempt from vulnerability checks or focused upgrade verification.

The Linux license texts come from the GNU license pages:
`https://www.gnu.org/licenses/lgpl-3.0.txt` and
`https://www.gnu.org/licenses/gpl-3.0.txt`.

Update the corresponding source text and index when a pinned runtime changes.
No dependency source tree, plugin, or license-scanning dependency is bundled.
