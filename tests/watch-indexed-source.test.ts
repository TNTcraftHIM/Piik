import { readFileSync } from "node:fs";
import initializeCore from "../prototype/channel-browser/pkg/piik_channel_browser";
import { mediaFragmentBytes } from "../src/shared/media-resource";
import { BoxParser, createFile, DataStream, MP4BoxBuffer, type Box, type ISOFile } from "mp4box";
import { beforeAll, expect, test, vi } from "vitest";
import { inspectIndexedTrack, indexedMediaSelection, type IndexedMetadataRead } from "../src/client/channel/watch-indexed-source";
import { nativePageIndexedTrackRecipeSchema } from "../src/client/native/wire";

beforeAll(async()=>{await initializeCore({module_or_path:readFileSync("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm")});});

// Six seconds of owned synthetic picture/sine, encoded AV1 or copied AAC into fMP4.
// Fixtures contain no website bytes. GPAC writes structural variants without a second parser.
function parse(bytes: Uint8Array, keep = false): ISOFile {
  const parser = createFile(keep);
  parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(Uint8Array.from(bytes).buffer, 0));
  return parser;
}
function fixture(kind: "av1" | "aac", change?: (parser: ISOFile) => void): Uint8Array {
  const parser = parse(readFileSync(new URL(`./fixtures/indexed-${kind}.mp4`, import.meta.url)), true);
  change?.(parser);
  const stream = new DataStream(); parser.write(stream);
  return new Uint8Array(stream.buffer);
}
function selected(bytes: Uint8Array) {
  const candidate = { id: crypto.randomUUID(), name: "Owned track", hostname: "media.test", mimeType: "video/mp4", totalSize: bytes.length };
  const read = vi.fn<IndexedMetadataRead>(async (_id, offset, length) => ({
    mimeType: candidate.mimeType, totalSize: bytes.length, bytes: bytes.slice(offset, offset + length),
  }));
  return { candidate, read, inspect: () => inspectIndexedTrack(candidate, read, new AbortController().signal) };
}
function edits(parser: ISOFile, delay: number): void {
  const track = parser.moov.traks[0], edts = track.edts ?? track.addBox(new BoxParser.box.edts());
  const elst = edts.elst ?? edts.addBox(new BoxParser.box.elst());
  elst.version = 0; elst.flags = 0;
  elst.entries = [
    { segment_duration: delay, media_time: -1, media_rate_integer: 1, media_rate_fraction: 0 },
    { segment_duration: 0, media_time: 0, media_rate_integer: 1, media_rate_fraction: 0 },
  ];
}
function sampleDescription(parser: ISOFile): Uint8Array {
  const stream = new DataStream(), box: Box = parser.moov.traks[0].mdia.minf.stbl.stsd;
  box.write(stream);
  return new Uint8Array(stream.buffer);
}
function trex(parser: ISOFile) {
  return parser.moov.mvex!.trexs.map(value => [value.track_id, value.default_sample_description_index,
    value.default_sample_duration, value.default_sample_size, value.default_sample_flags]);
}

test.each([
  { kind: "av1" as const, delay: 22, firstPTS: 336, timescale: 16000 },
  { kind: "aac" as const, delay: 20, firstPTS: 960, timescale: 48000 },
])("indexed $kind retains edit timing and sample defaults while normalizing an iso5-only init", async value => {
  const bytes = fixture(value.kind, parser => {
    parser.ftyp.major_brand = "iso5"; parser.ftyp.compatible_brands = ["iso5"];
    parser.moov.mvhd.duration = 8409652; parser.moov.traks[0].tkhd.duration = 8409652;
    edits(parser, value.delay); parser.sidx.earliest_presentation_time = value.firstPTS;
  });
  const source = parse(bytes), input = selected(bytes), inspection = await input.inspect();
  const init = parse(Uint8Array.from(atob(inspection.recipe.initBase64), value => value.charCodeAt(0)));
  expect(init.ftyp.major_brand).toBe("iso5");
  expect(init.ftyp.compatible_brands).toEqual(["iso5", "iso6"]);
  expect(init.moov.mvhd.duration).toBe(0); expect(init.moov.traks[0].tkhd.duration).toBe(0);
  expect(init.moov.traks[0].edts!.elst!.entries).toEqual(source.moov.traks[0].edts!.elst!.entries);
  expect(trex(init)).toEqual(trex(source)); expect(sampleDescription(init)).toEqual(sampleDescription(source));
  expect(inspection.metadata).toMatchObject({ kind: value.kind === "av1" ? "video" : "audio", firstPTS: value.firstPTS, timescale: value.timescale });
  expect(inspection.recipe.mediaOffset).toBe(source.sidx.start! + source.sidx.size + source.sidx.first_offset);
  expect(inspection.recipe.segments).toEqual(source.sidx.references.map(reference => [reference.referenced_size, reference.subsegment_duration]));
  expect(source.moofs[0].trafs[0].tfdt.baseMediaDecodeTime).toBe(0);
  expect(input.read).toHaveBeenCalledOnce();
});

test("separate files with track ID 1 remain explicit independent video and audio selections", async () => {
  const video = await selected(fixture("av1")).inspect(), audio = await selected(fixture("aac")).inspect();
  const init = (value: typeof video) => parse(Uint8Array.from(atob(value.recipe.initBase64), byte => byte.charCodeAt(0)));
  expect(init(video).moov.traks[0].tkhd.track_id).toBe(1); expect(init(audio).moov.traks[0].tkhd.track_id).toBe(1);
  expect(indexedMediaSelection(video, audio)).toEqual({ video: video.recipe, audio: audio.recipe });
  expect(indexedMediaSelection(video)).toEqual({ video: video.recipe });
  expect(() => indexedMediaSelection(audio, video)).toThrow("watch_indexed_unsupported");
});

test("SIDX keeps its own time units without changing media time or byte ranges", async () => {
  const original = await selected(fixture("av1")).inspect();
  const scaled = await selected(fixture("av1", parser => {
    const index = parser.sidx, scale = 1000 / index.timescale;
    index.timescale = 1000;
    index.earliest_presentation_time *= scale;
    for (const reference of index.references) reference.subsegment_duration *= scale;
  })).inspect();
  const init = parse(Uint8Array.from(atob(scaled.recipe.initBase64), byte => byte.charCodeAt(0)));
  expect(scaled.recipe.timescale).toBe(1000);
  expect(init.getInfo().tracks[0].timescale).toBe(16000);
  expect(scaled.metadata.duration).toBe(original.metadata.duration);
  expect(scaled.recipe.mediaOffset).toBe(original.recipe.mediaOffset);
  expect(scaled.recipe.segments.map(([length, ticks]) => [length, ticks / scaled.recipe.timescale]))
    .toEqual(original.recipe.segments.map(([length, ticks]) => [length, ticks / original.recipe.timescale]));
  expect(scaled.recipe.initBase64).toBe(original.recipe.initBase64);
});

test.each([
  { name: "nested index", change: (p: ISOFile) => { p.sidx.references[0].reference_type = 1; }, error: "watch_indexed_unsupported" },
  { name: "non-random access", change: (p: ISOFile) => { p.sidx.references[0].starts_with_SAP = 0; }, error: "watch_indexed_unsupported" },
  { name: "oversized fragment", change: (p: ISOFile) => { p.sidx.references[0].referenced_size = mediaFragmentBytes() + 1; }, error: "watch_resource_limit" },
  { name: "protected sample entry", change: (p: ISOFile) => { p.moov.traks[0].mdia.minf.stbl.stsd.entries[0].addBox(new BoxParser.box.sinf()); }, error: "watch_media_encryption_unsupported" },
  { name: "multiple media edits", change: (p: ISOFile) => { edits(p, 20); p.moov.traks[0].edts!.elst!.entries[0].media_time = 0; }, error: "watch_indexed_unsupported" },
])("unsupported $name is refused by the same generic parser", async ({ change, error }) => {
  await expect(selected(fixture("av1", change)).inspect()).rejects.toThrow(error);
});

test("cancelled inspection cannot publish metadata from a late prefix response", async () => {
  const bytes = fixture("av1"), { candidate } = selected(bytes), lifetime = new AbortController();
  let complete!: (value: Awaited<ReturnType<IndexedMetadataRead>>) => void;
  const read = vi.fn<IndexedMetadataRead>(() => new Promise(resolve => { complete = resolve; }));
  const pending = inspectIndexedTrack(candidate, read, lifetime.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  lifetime.abort(); complete({ bytes, totalSize: bytes.length, mimeType: "video/mp4" });
  await cancelled; expect(read).toHaveBeenCalledOnce();
});

test("inspection cancelled during parser loading never starts a resource read", async () => {
  const bytes = fixture("av1"), { candidate } = selected(bytes), lifetime = new AbortController();
  const read = vi.fn<IndexedMetadataRead>();
  const pending = inspectIndexedTrack(candidate, read, lifetime.signal);
  lifetime.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(read).not.toHaveBeenCalled();
});

test("recipe codec syntax accepts undotted tokens without granting Browser codec support", async () => {
  const { recipe } = await selected(fixture("av1")).inspect();
  for (const codec of ["opus", "flac", "av01.0.08M.08", "unknown-codec", "x_codec"]) {
    expect(nativePageIndexedTrackRecipeSchema.parse({ ...recipe, codec }).codec).toBe(codec);
  }
  for (const codec of ["", "av01,mp4a", 'av01",AUDIO="other', "av01\n", "non ascii 字"]) {
    expect(nativePageIndexedTrackRecipeSchema.safeParse({ ...recipe, codec }).success).toBe(false);
  }
});

test.each([false, true])("indexed module load failure stays local and respects cancellation (%s)", async cancelled => {
  vi.resetModules();
  let rejectLoad!: (error: Error) => void;
  const loading = new Promise<never>((_, reject) => { rejectLoad = reject; });
  const load = vi.fn(() => loading);
  vi.doMock("mp4box", load);
  try {
    const { inspectIndexedTrack: inspect } = await import("../src/client/channel/watch-indexed-source");
    const lifetime = new AbortController(), read = vi.fn<IndexedMetadataRead>();
    const operation = inspect({ id: crypto.randomUUID(), name: "Owned track", hostname: "media.test", mimeType: "video/mp4", totalSize: 128 }, read, lifetime.signal);
    const failure = expect(operation).rejects.toMatchObject(cancelled ? { name: "AbortError" } : { message: "watch_indexed_unsupported" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (cancelled) lifetime.abort();
    rejectLoad(new Error("Failed to fetch dynamically imported module: /assets/mp4box.js"));
    await failure;
    expect(read).not.toHaveBeenCalled();
  } finally { vi.doUnmock("mp4box"); vi.resetModules(); }
});
