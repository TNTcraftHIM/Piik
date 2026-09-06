# Third-Party Licenses

Screener-owned code uses the root [MIT license](../LICENSE). Dependencies retain
their own licenses; MIT does not replace their copyright notices or terms.

The [pinned source index](./upstream.json) records exact upstream commits and
SHA-256 values for Cloudflared, libvpx, and npm packages that omit license
files.
The retained text normalizes line endings and incidental whitespace only.
The Cloudflared text includes its source distribution's root and all vendored
LICENSE, COPYING, and NOTICE files, including platform variants. The protobuf
text also preserves Google's BSD-licensed varint attribution.
The Windows capture adapter statically links libvpx; its copyright, patent grant
and author list are included in the Client's native notices.
Linux packages also include `linux-system-dependencies.txt` in their native
notice. It identifies the system-provided libportal and GStreamer stack; those
shared libraries are not bundled, so their installed distribution notices still
apply.

`npm run dev` and `npm run build:client` generate `/third-party-licenses.txt`
offline from installed, lockfile-matched Web runtime dependencies.
The application release and Client assembly each add the Go toolchain notice
and the license files of the modules actually compiled into that binary; the
Client package also carries the pinned Cloudflared notices. Missing license
texts or changed pinned contents stop packaging.

Update the corresponding source text and index when a pinned runtime changes.
No dependency source tree, plugin, or license-scanning dependency is bundled.
