import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { initializeRuntime, createSessionSigner } from "../prototype/channel-browser/src/room-host";

test("concurrent callers share each WASM download and can retry a failed download", async () => {
  const error = new TypeError("download interrupted");
  const bytes = await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error)
    .mockResolvedValueOnce(new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/wasm" } }));
  try {
    const first = initializeRuntime();
    expect(initializeRuntime()).toBe(first);
    await expect(first).rejects.toBe(error);
    const retry = initializeRuntime();
    expect(initializeRuntime()).toBe(retry);
    await retry;
    await expect(first).rejects.toBe(error);
    expect(initializeRuntime()).toBe(retry);
    const signer = await createSessionSigner(new Uint8Array(32));
    try { expect(signer.signing_key()).toHaveLength(32); } finally { signer.free(); }
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { fetch.mockRestore(); }
});
