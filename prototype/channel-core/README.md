# Shared channel core

`piik-channel-core` owns the prototype's domain authority, room rules, wire types,
conversation signatures, routes and file delivery. Browser/WASM, Native and Server
depend on this library; it does not depend on those adapters. Rust 1.86 is supported.
The default build has no I/O dependencies. The optional `sqlite` feature supplies
the existing storage and `StoredRoomHost` adapter.

From the repository root:

```powershell
cargo +1.86.0 test --manifest-path prototype/channel-core/Cargo.toml
cargo +1.86.0 test --manifest-path prototype/channel-core/Cargo.toml --features sqlite
```

The [Server](../channel-server/README.md), [Native participant](../channel-native/README.md)
and [Browser adapter](../channel-browser/README.md) own their startup and I/O checks.
