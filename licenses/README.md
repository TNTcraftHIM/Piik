# Third-Party Licenses

Screener-owned code uses the root [MIT license](../LICENSE). Dependencies retain
their own licenses; MIT does not replace their copyright notices or terms.

The [pinned source index](./upstream.json) records exact upstream commits and
SHA-256 values for Node, Cloudflared, and npm packages that omit license files.
The retained text normalizes line endings and incidental whitespace only.
The Cloudflared text includes its source distribution's root and all vendored
LICENSE, COPYING, and NOTICE files, including platform variants. The protobuf
text also preserves Google's BSD-licensed varint attribution.
The Windows capture adapter statically links libvpx; its copyright, patent grant
and author list are included in the Client's native notices.

`npm run dev` and `npm run build:client` generate `/third-party-licenses.txt`
offline from installed, lockfile-matched Web/Server runtime dependencies.
Client assembly adds licenses for the Go toolchain and actually compiled module
packages, Node's full same-version license, and the pinned Cloudflared notices.
Missing license texts or changed pinned contents stop packaging.

Update the corresponding source text and index when a pinned runtime changes.
No dependency source tree, plugin, or license-scanning dependency is bundled.
