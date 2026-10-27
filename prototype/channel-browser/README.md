# Browser room adapter

The shared Rust `RoomRuntime` owns authorized room views and history operations. IndexedDB supplies
transactional storage; shared Rust prepares confirmations and history pages.
The caller supplies authenticated domain member facts, without a credential database,
and delivers returned results after commit. Domain rendezvous is not yet connected.

Requires the repository's Rust/Node environment, `wasm32-unknown-unknown`,
`wasm-bindgen` CLI **0.2.129**, and installed `agent-browser` Chromium.
Set `WASM_BINDGEN` to the CLI path if it is outside `PATH`. From the repository root:

```powershell
node prototype/channel-browser/build.mjs
npx tsc -p prototype/channel-browser/tsconfig.json
node prototype/channel-browser/check.mjs
```

`pkg/` and Cargo `target/` are generated and ignored. The finite check owns its
loopback server and browser profile, then removes both. Evidence stays under
`build/channel-browser-check/`. It tests real WASM and IndexedDB, including
reopen, original nonce confirmation, abort after insert success, attachment
rollback and pagination; it does not provide a second room UI or file service.
