# Scoped Go Dependency Repairs

The root `go.mod` replaces only these two modules with local source. They retain
their original module paths and Apache-2.0 licenses. The checked-in source,
upstream tests and focused regressions are built and tested by
`npm run check:go`.

| Module | Source baseline | Local changes |
| --- | --- | --- |
| `go-nat` | [netbirdio/go-nat at 6b2c8c5c74e8](https://github.com/netbirdio/go-nat/tree/6b2c8c5c74e8331ed41811cfd2fdc4c3dd8c3ff0) | `natpmp.go` uses request contexts, remembers the assigned external port and sends lifetime-zero deletion; regression tests cover the real client and PCPv6 combination |
| `go-nat-pmp` | [jackpal/go-nat-pmp v1.0.2](https://github.com/jackpal/go-nat-pmp/tree/v1.0.2) | Context-aware request methods, deadline/cancellation through UDP I/O, adapted recorder/test caller, and a module manifest |

Upstream source and tests are retained, excluding examples and CI configuration.
Modified upstream files carry a notice; formatting follows the project Go
toolchain. The package notice collector reads the replacement modules' license
files directly, so App archives retain their attribution.

These repairs preserve the existing gateway selector and PCPv6 composition.
The [NAT research owner](../../docs/research/nat-traversal.md#gateway-and-survey-limits)
describes the runtime limits. Do not add a second gateway client in Piik.

When maintained upstream revisions cover these fixes and the same regressions
pass, replace both local module directives with version pins, remove their source
directories and the extra dependency test patterns in `scripts/check-go.mjs`.
Until then, review updates against the named baselines; do not edit Go's shared
module cache or apply build-time patches.
