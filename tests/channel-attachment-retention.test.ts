import { afterEach, expect, test, vi } from "vitest";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { t } from "../src/client/ui/copy";
import { FileStore } from "../src/client/channel/file-store";
import * as hosting from "../src/client/channel/hosting";
import * as downloads from "../src/client/lib/download";
import type { ChannelAttachment, ChannelCommand, ChannelMessage, ChannelRoom } from "../src/client/channel/protocol";

afterEach(() => vi.restoreAllMocks());

const attachment: ChannelAttachment = { id: "image", name: "image.gif", size: 6, mediaType: "image/gif", sha256: "a".repeat(64) };
const key = { roomId: "room", messageSeq: 1, attachmentId: attachment.id };
const inlineImage = { data: btoa("GIF89a"), mediaType: "image/gif" as const, original: true, width: 1, height: 1 };
const message: ChannelMessage = { id: "message", seq: 1, userId: "self", time: 1, text: "", attachments: [attachment] };

function setup(command = async (_command: ChannelCommand) => {}) {
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 1024, maxAttachmentsPerMessage: 8, maxRetainedBytes: 1024, maxRetainedFiles: 8, maxInlineImageBytes: 65536 }),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const files = new ChannelAttachments(command, async () => {});
  files.update("endpoint", { domainId: "domain", userId: "self" }, [],
    [{ id: key.roomId, authorized: true, available: true }] as ChannelRoom[], []);
  return files;
}

test("a confirmed attachment uses its committed readable copy after the selected disk file disappears", async () => {
  const files = setup();
  const selected = new File(["GIF89a"], attachment.name), retained = new File(["GIF89a"], attachment.name);
  const retain = vi.spyOn(FileStore.prototype, "retain").mockResolvedValue({ file: retained, evicted: [] });
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: selected }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    await new Promise(resolve => setImmediate(resolve));
    vi.spyOn(selected, "arrayBuffer").mockRejectedValue(new DOMException("The source file was moved", "NotReadableError"));
    const readable = await files.content(key, attachment, new AbortController().signal);
    expect(new TextDecoder().decode(await readable.arrayBuffer())).toBe("GIF89a");
  } finally { files.reset(); }
});

test("a confirmed inline GIF remains readable without a live session, cache or transfer", async () => {
  const command = vi.fn(), send = vi.fn(), load = vi.spyOn(hosting, "loadRoomHosting");
  const files = new ChannelAttachments(command, send);
  const content = await files.content(key, attachment, new AbortController().signal, inlineImage);
  expect(content.name).toBe(attachment.name);
  expect(content.type).toBe("image/gif");
  expect(await content.text()).toBe("GIF89a");
  expect(command).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});

test("backup inventory includes confirmed and restored live files when optional retention fails", async () => {
  const files = setup(), file = new File(["GIF89a"], attachment.name);
  const entry = { key, attachment, file };
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("quota"));
  try {
    expect(await files.retained(key.roomId)).toEqual([]);
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file }]);
    expect(await files.content(key, attachment, new AbortController().signal)).toBe(file);
    expect(await files.retained(key.roomId)).toEqual([entry]);
    const restoredAttachment = { ...attachment, id: "restored" }, restoredKey = { ...key, attachmentId: "restored" };
    const restored = { key: restoredKey, attachment: restoredAttachment, file };
    expect(await files.restoreRetained(key.roomId, [restored])).toBe(false);
    expect(await files.retained(key.roomId)).toEqual([entry, restored]);
    vi.mocked(FileStore.prototype.list).mockResolvedValue([entry]);
    expect(await files.retained(key.roomId)).toEqual([entry, restored]);
    expect(await files.retained("other-room")).toEqual([]);
  } finally { files.reset(); }
});

test("an already cancelled inline read preserves cancellation without opening a transfer", async () => {
  const command = vi.fn(), send = vi.fn(), files = new ChannelAttachments(command, send);
  const request = new AbortController(); request.abort();
  await expect(files.content(key, attachment, request.signal, inlineImage)).rejects.toMatchObject({ name: "AbortError" });
  expect(command).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test.each(["resolve", "reject"])("cancelling runtime preparation permits an immediate retry and ignores the old %s", async outcome => {
  const files = setup();
  let finish!: () => void, fail!: (error: Error) => void;
  const initialization = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const initializeRuntime = vi.fn(() => initialization), start = vi.fn(() => "[]"), free = vi.fn();
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime,
    FileDelivery: class { update() { return "[]"; } next_deadline() { return undefined; } start = start; free = free; },
  } as never);
  const save = vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => options?.outcome?.("dispatched"));
  const first = files.download(key, attachment);
  void first.catch(() => {});
  try {
    await vi.waitFor(() => expect(initializeRuntime).toHaveBeenCalledOnce());
    expect(files.status(key)).toMatchObject({ busy: true });
    files.cancelDownload(key);
    const retry = files.download(key, attachment, inlineImage);
    expect(retry).not.toBe(first);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await retry;
    expect(files.status(key)).toEqual({ busy: false, error: null, outcome: "dispatched", saveProgress: undefined });
    expect(save).toHaveBeenCalledOnce();
    if (outcome === "resolve") finish(); else fail(new Error("runtime_load_failed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(files.status(key)).toMatchObject({ busy: false, error: null, outcome: "dispatched" });
    expect(free).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(files.progress(key)).toBeNull();
  } finally { finish(); files.reset(); }
});

test("a file offer failure keeps its warning until a personal download supplies progress or a result", async () => {
  const files = setup(async command => { if (command.type === "file_offer") throw new Error("disconnected"); });
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("optional_cache_unavailable"));
  let report!: NonNullable<Parameters<typeof downloads.downloadBlob>[2]>;
  vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => { report = options!; report.outcome?.("requested"); });
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: new File(["GIF89a"], attachment.name) }]);
    await vi.waitFor(() => expect(files.status(key).error).toBe("file_offer_failed"));
    await files.download(key, attachment);
    expect(files.status(key)).toMatchObject({ outcome: "requested", error: null });
    report.outcome?.("started"); report.progress?.({ received: 3, total: attachment.size });
    expect(files.status(key)).toMatchObject({ outcome: "started", error: null, saveProgress: { received: 3, total: attachment.size } });
    report.outcome?.("saved");
    expect(files.status(key)).toMatchObject({ outcome: "saved", error: null, saveProgress: undefined });
    await files.download(key, attachment);
    report.outcome?.("failed");
    expect(files.status(key)).toMatchObject({ outcome: "failed", error: "download_failed" });
  } finally { files.reset(); }
});

test("a generated preview cannot replace the original in the download content path", async () => {
  const files = setup(), original = new File(["GIF89a"], attachment.name, { type: attachment.mediaType });
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("optional_cache_unavailable"));
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: original }]);
    const preview = { data: btoa("preview"), mediaType: "image/webp" as const, original: false, width: 2048, height: 1024 };
    expect(await files.content(key, attachment, new AbortController().signal, preview)).toBe(original);
  } finally { files.reset(); }
});

test("a late retained copy cannot replace a successor source for the same attachment", async () => {
  const files = setup();
  const old = new File(["GIF89a"], attachment.name), next = new File(["GIF89a"], attachment.name);
  let complete!: (result: { file: File; evicted: [] }) => void;
  const retain = vi.spyOn(FileStore.prototype, "retain")
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockRejectedValue(new Error("optional_cache_unavailable"));
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: old }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: next }]);
    complete({ file: new File(["GIF89a"], attachment.name), evicted: [] });
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(2));
    expect(await files.content(key, attachment, new AbortController().signal)).toBe(next);
  } finally { files.reset(); }
});

test("a restore reports partial caching when a later file evicts an earlier file from the same batch", async () => {
  const files = setup(), file = new File(["GIF89a"], attachment.name);
  const first = { key, attachment, file };
  const nextAttachment = { ...attachment, id: "second" };
  const second = { key: { ...key, messageSeq: 2, attachmentId: nextAttachment.id }, attachment: nextAttachment, file };
  vi.spyOn(FileStore.prototype, "retain").mockResolvedValueOnce({ file, evicted: [] })
    .mockResolvedValueOnce({ file, evicted: [key] });
  try {
    expect(await files.restoreRetained(key.roomId, [first, second])).toBe(false);
    expect(await files.retained(key.roomId)).toEqual([second]);
    expect(await files.content(second.key, second.attachment, new AbortController().signal)).toBe(file);
  } finally { files.reset(); }
});


test("preview and download share source-unavailable guidance while other failures retain their own meaning", () => {
  for (const lang of ["en", "zh"] as const) {
    const copy = (key: Parameters<typeof t>[1]) => t(lang, key);
    for (const error of ["attachment_unavailable", "file_unavailable", "file_source_unavailable"]) {
      for (const fallback of ["channel.attachment.downloadFailed", "channel.attachment.originalUnavailable"] as const)
        expect(channelErrorPresentation(error, copy, fallback)).toEqual({ message: copy("channel.attachment.sourceUnavailable"), connectionHelp: false });
    }
    expect(channelErrorPresentation("image_decode_failed", copy, "channel.attachment.previewFailed").message).toBe(copy("channel.attachment.previewFailed"));
    expect(channelErrorPresentation("download_failed", copy, "channel.attachment.downloadFailed").message).toBe(copy("channel.attachment.saveFailed"));
    expect(channelErrorPresentation("file_offer_failed", copy).message).toBe(copy("channel.attachment.fileOfferFailed"));
  }
});


test("file progress follows completed writes and is shared until the last consumer cancels", async () => {
  const files = setup(), key = { roomId: "room", messageSeq: 1, attachmentId: attachment.id };
  let finishWrite!: () => void;
  const written = vi.fn(() => "[]"), cancel = vi.fn(() => "[]"), remove = vi.fn(async () => {});
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    FileDelivery: class {
      start() { return "[]"; } update() { return "[]"; } next_deadline() { return undefined; }
      written = written; cancel = cancel; free() {}
      control() { return JSON.stringify([{ type: "write", key, offset: 0, bytes: [1, 2, 3] }]); }
    },
  } as never);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({
    getFileHandle: async () => ({ createWritable: async () => ({ write: () => new Promise<void>(resolve => { finishWrite = resolve; }), abort: async () => {} }) }), removeEntry: remove,
  }) }) } });
  const first = new AbortController(), second = new AbortController();
  const a = files.content(key, attachment, first.signal), b = files.content(key, attachment, second.signal);
  void a.catch(() => {}); void b.catch(() => {});
  try {
    await vi.waitFor(() => expect(files.progress(key)).toEqual({ received: 0, total: attachment.size, state: "waiting" }));
    expect(files.progress(key)).toBe(files.progress(key)); // Stable useSyncExternalStore snapshot.
    files.data("source", "control", "owned-write");
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    expect(files.progress(key)?.received).toBe(0); expect(written).not.toHaveBeenCalled();
    finishWrite();
    await vi.waitFor(() => expect(files.progress(key)).toEqual({ received: 3, total: attachment.size, state: "receiving" }));
    expect(written).toHaveBeenCalledWith(JSON.stringify(key), 0n, 3);
    first.abort(); await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(files.progress(key)?.received).toBe(3); expect(cancel).not.toHaveBeenCalled();
    second.abort(); await expect(b).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(files.progress(key)).toBeNull(); expect(cancel).toHaveBeenCalledOnce();
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test.each(["image/png", "image/webp"] as const)("an animated %s uses spare message budget in either attachment order", async mediaType => {
  const { readFile } = await import("node:fs/promises");
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  const files = setup();
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as never);
  const decode = vi.fn(async () => {}), canvas = vi.fn(() => { throw new Error("animation_must_not_reach_canvas"); });
  class Image { naturalWidth = 1; naturalHeight = 1; src = ""; decode = decode; }
  vi.stubGlobal("Image", Image); vi.stubGlobal("document", { createElement: canvas });
  const bytes = new Uint8Array(300 * 1024), view = new DataView(bytes.buffer);
  if (mediaType === "image/png") {
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 8); bytes.set(new TextEncoder().encode("acTL"), 12);
  } else {
    bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8); view.setUint32(16, 10, true); bytes[20] = 2;
  }
  const original = { id: crypto.randomUUID(), file: new File([bytes], "animation") };
  const tiny = { id: crypto.randomUUID(), file: new File(["GIF89a"], "tiny.gif") };
  try {
    const alone = await files.describe([original]);
    for (const order of [[original, tiny], [tiny, original]]) {
      const prepared = await files.describe(order);
      const image = prepared.find(entry => entry.id === original.id)!;
      expect(image.attachment).toEqual(alone[0].attachment);
      expect(image.file).toBe(original.file);
      expect(image.inlineImage).toMatchObject({ original: true, mediaType });
      expect(image.inlineImage?.data === alone[0].inlineImage?.data).toBe(true);
      expect(prepared.reduce((sum, entry) => sum + atob(entry.inlineImage?.data ?? "").length, 0)).toBe(bytes.length + tiny.file.size);
    }
    expect(canvas).not.toHaveBeenCalled();
    decode.mockClear();
    const oversized = new Uint8Array(JSON.parse(rust.attachment_limits()).maxInlineImageBytes + 1);
    oversized.set(bytes.subarray(0, 24));
    const overBudget = await files.describe([{ id: crypto.randomUUID(), file: new File([oversized], "oversized-animation") }]);
    expect(overBudget[0].inlineImage).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    decode.mockClear(); decode.mockRejectedValue(new Error("invalid_image"));
    const invalid = await files.describe([original, tiny]);
    expect(invalid.every(entry => entry.inlineImage === undefined)).toBe(true);
    expect(decode).toHaveBeenCalledTimes(2); // Tiny once; deferred original once, never retry a decode failure.
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("a GIF uses unused per-message image space without flattening or exceeding the shared limit", async () => {
  const files = setup();
  const decode = vi.fn(async () => {});
  class Image { naturalWidth = 1; naturalHeight = 1; src = ""; decode = decode; }
  vi.stubGlobal("Image", Image);
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 2048, maxAttachmentsPerMessage: 8, maxRetainedBytes: 4096, maxRetainedFiles: 8, maxInlineImageBytes: 1024 }),
    attachment_media_type: (bytes: Uint8Array) => bytes[0] === 71 ? "image/gif" : "image/png",
    AttachmentHash: class { update() {} finish() { return "a".repeat(64); } },
  } as never);
  const gif = (size: number) => new File(["GIF89a", new Uint8Array(size - 6)], "owned.gif");
  try {
    const tiny = { id: crypto.randomUUID(), file: new File(["tiny"], "tiny.png") };
    const prepared = await files.describe([{ id: crypto.randomUUID(), file: gif(700) }, tiny]);
    expect(prepared[0].inlineImage).toMatchObject({ mediaType: "image/gif", original: true });
    expect(atob(prepared[0].inlineImage!.data).length).toBe(700);
    expect(prepared.reduce((sum, entry) => sum + atob(entry.inlineImage?.data ?? "").length, 0)).toBe(704);
    const oversized = await files.describe([{ id: crypto.randomUUID(), file: gif(1025) }, tiny]);
    expect(oversized[0].inlineImage).toBeUndefined();
    expect(oversized[1].inlineImage?.original).toBe(true);
    decode.mockClear(); decode.mockRejectedValue(new Error("invalid_image"));
    const invalid = await files.describe([{ id: crypto.randomUUID(), file: gif(100) }]);
    expect(invalid[0].inlineImage).toBeUndefined();
    expect(decode).toHaveBeenCalledOnce(); // Failed decoding is not a deferred-budget candidate.
  } finally { files.reset(); vi.unstubAllGlobals(); }
});
