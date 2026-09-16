# Scoped Go Dependency Repairs

The root `go.mod` replaces the modules below with local source. They retain
their original module paths and licenses. The checked-in source,
upstream tests and focused regressions are built and tested by
`npm run check:go`.

| Module | Source baseline | Local changes |
| --- | --- | --- |
| `go-nat` | [netbirdio/go-nat at 6b2c8c5c74e8](https://github.com/netbirdio/go-nat/tree/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0) | `natpmp.go` uses request contexts, remembers the assigned external port and sends lifetime-zero deletion; regression tests cover the real client and PCPv6 combination |
| `go-nat-pmp` | [jackpal/go-nat-pmp v1.0.2](https://github.com/jackpal/go-nat-pmp/tree/v1.0.2) | Context-aware request methods, deadline/cancellation through UDP I/O, adapted recorder/test caller, and a module manifest |
| `atomic` | [uber-go/atomic v1.11.0](https://github.com/uber-go/atomic/tree/v1.11.0), MIT | Zero-sized standard-library atomic fields align `Int64` and `Uint64` on 32-bit Go, including embedded float/duration wrappers; generator and regression follow that layout. Its compiler subprocess test preserves Windows environment paths. |

Upstream source and tests are retained, excluding examples and CI configuration.
Modified upstream files carry a notice; formatting follows the project Go
toolchain. The package notice collector reads the replacement modules' license
files directly, so App archives retain their attribution.

The NAT repairs preserve the existing gateway selector and PCPv6 composition.
The [NAT research owner](../../docs/research/nat-traversal.md#gateway-and-survey-limits)
describes the runtime limits. Do not add a second gateway client in Piik.

The atomic repair addresses a reproduced LiveKit `NewDownTrack` panic on
Windows/386. [Go's atomic documentation](https://pkg.go.dev/sync/atomic#pkg-note-BUG)
requires 64-bit alignment on 32-bit systems and guarantees it for its typed
atomics. The zero-length fields inherit that alignment without adding storage,
locks or changing operations. The x86 native check runs the dependency tests as
a 32-bit process; ordinary core/race checks retain the upstream suite.

When maintained upstream revisions cover a repair and the same regressions
pass, replace its local module directive with a version pin, remove its source
directories and the extra dependency test patterns in `scripts/check-go.mjs`.
Until then, review updates against the named baselines; do not edit Go's shared
module cache or apply build-time patches.
