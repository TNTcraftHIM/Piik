import { expect, test, vi } from "vitest";
vi.mock("../src/shared/media-resource", () => ({
  mediaFragmentBytes: () => 60000000,
  mediaManifestBytes: () => 1048576,
}));
import { attachWatchDashReader } from "../src/client/channel/watch-dash-loader";
const resource = "10000000-0000-4000-8000-000000000001";
function sdk() {
  const schemes = new Map<string, any>(),
    filters = new Set<any>();
  return {
    schemes,
    filters,
    library: {
      net: {
        NetworkingEngine: {
          RequestType: { MANIFEST: 0, SEGMENT: 1 },
          PluginPriority: { APPLICATION: 3 },
          registerScheme: (s: string, p: any) => schemes.set(s, p),
          unregisterScheme: (s: string) => schemes.delete(s),
        },
      },
      util: {
        AbortableOperation: class {
          constructor(
            public promise: Promise<any>,
            public abort: () => Promise<void>,
          ) {}
        },
      },
    },
    player: {
      getNetworkingEngine: () => ({
        registerRequestFilter: (f: any) => filters.add(f),
        unregisterRequestFilter: (f: any) => filters.delete(f),
      }),
    },
  };
}
const request = (url: string, headers = {}) => ({
  uris: [url],
  method: "GET",
  body: null,
  allowCrossSiteCredentials: false,
  headers,
});
test("DASH uses exact range windows and admits only its own opaque media graph", async () => {
  const s = sdk(),
    calls: any[] = [];
  const data = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
  const life = new AbortController();
  const bridge = attachWatchDashReader(
    s.library as any,
    s.player as any,
    async (id, offset, length) => {
      calls.push({ id, offset, length });
      return {
        mimeType: "video/mp4",
        totalSize: data.length,
        bytes: data.slice(offset, offset + length),
        eof: offset + length >= data.length,
      };
    },
    life.signal,
  );
  const url = bridge.url(resource),
    plugin = [...s.schemes.values()][0],
    req = request(url, { Range: "bytes=7-70006" });
  const out = await plugin(url, req, 1, () => {}).promise;
  expect(new Uint8Array(out.data)).toEqual(data.slice(7, 70007));
  expect(calls.every((c) => c.length <= 65536)).toBe(true);
  const filter = [...s.filters][0];
  expect(() => filter(1, request("https://example.invalid/seg"))).toThrow(
    "watch_source_unavailable",
  );
  expect(() => filter(2, request(url))).toThrow("watch_source_unavailable");
  expect(() => filter(1, request(url + "?override=1"))).toThrow(
    "watch_source_unavailable",
  );
  life.abort();
  expect(s.schemes.size).toBe(0);
  expect(s.filters.size).toBe(0);
});
test("retiring DASH aborts an in-flight existing Reader without returning late bytes", async () => {
  const s = sdk(),
    life = new AbortController();
  let cancelled = 0;
  let start!: () => void;
  const began = new Promise<void>((r) => (start = r));
  const bridge = attachWatchDashReader(
    s.library as any,
    s.player as any,
    async (_id, _offset, _length, signal) => {
      start();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled++;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
    life.signal,
  );
  const url = bridge.url(resource),
    plugin = [...s.schemes.values()][0],
    reading = plugin(url, request(url), 1, () => {}).promise;
  const rejected = expect(reading).rejects.toMatchObject({
    name: "AbortError",
  });
  await began;
  life.abort();
  await rejected;
  expect(cancelled).toBe(1);
  expect(s.schemes.size).toBe(0);
});
test("SegmentBase ranges remain readable from a large selected file without downloading it whole", async () => {
  const s = sdk(),
    life = new AbortController(),
    calls: {
      offset: number;
      length: number;
    }[] = [];
  const size = 128 * 1024 * 1024;
  const bridge = attachWatchDashReader(
    s.library as any,
    s.player as any,
    async (_id, offset, length) => {
      calls.push({ offset, length });
      return {
        mimeType: "video/webm",
        totalSize: size,
        bytes: Uint8Array.from({ length }, (_, i) => (offset + i) % 251),
        eof: offset + length === size,
      };
    },
    life.signal,
  );
  const url = bridge.url(resource),
    plugin = [...s.schemes.values()][0],
    range = request(url, { Range: "bytes=310-552" });
  const result = await plugin(url, range, 1, () => {}).promise;
  expect(new Uint8Array(result.data)).toEqual(
    Uint8Array.from({ length: 243 }, (_, i) => (310 + i) % 251),
  );
  expect(calls).toEqual([
    { offset: 0, length: 1 },
    { offset: 310, length: 243 },
  ]);
  life.abort();
});

test("DASH rejects an oversized requested allocation before reading its body", async () => {
  const s = sdk(),
    life = new AbortController(),
    calls: number[] = [];
  const bridge = attachWatchDashReader(
    s.library as any,
    s.player as any,
    async (_id, _offset, length) => {
      calls.push(length);
      return {
        mimeType: "video/webm",
        totalSize: 128 * 1024 * 1024,
        bytes: new Uint8Array(length),
        eof: false,
      };
    },
    life.signal,
  );
  const url = bridge.url(resource),
    plugin = [...s.schemes.values()][0];
  for (const [type, headers] of [
    [1, {}],
    [1, { Range: "bytes=0-60000000" }],
    [0, { Range: "bytes=0-1048576" }],
  ] as const) {
    await expect(
      plugin(url, request(url, headers), type, () => {}).promise,
    ).rejects.toThrow("watch_resource_limit");
  }
  expect(calls).toEqual([1, 1, 1]);
  life.abort();
});
