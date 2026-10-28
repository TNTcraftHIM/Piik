# Browser room adapter

The shared Rust `RoomHost` owns room commands, authorized views and history operations. IndexedDB supplies
transactional storage; shared Rust prepares confirmations and history pages.
The caller supplies authenticated domain member facts, without a credential database,
and delivers its returned projection/reply after commit. The channel prototype loads this adapter
through its Vite entry; regular 2.x builds do not require generated WASM.
The same module exposes incremental attachment hashing and the shared file-range
engine. Browser adapters supply readable Files, temporary OPFS sinks and existing
peer DataChannels; they do not implement another route or transfer controller.

The current room binding also owns writes to the room store. Claiming it reloads
policy in the same IndexedDB transaction; old pages cannot overwrite a successor.
Concurrent takeover rejects the conflicting instance. Reconnect opens the saved
room again rather than letting that instance reclaim it. This uses IndexedDB's
[transaction scheduling](https://w3c.github.io/IndexedDB/#transaction-scheduling),
without holding a page-wide lock or adding a separate lease service.

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
reopen, original nonce confirmation, abort after insert success and pagination.
Browser-hosted rooms deliver files through their base paths; no file bytes go to
the domain. This adapter does not provide a second room UI or file service.
