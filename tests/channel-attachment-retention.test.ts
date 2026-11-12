import { afterEach, expect, test, vi } from "vitest";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { FileStore } from "../src/client/channel/file-store";
import * as hosting from "../src/client/channel/hosting";
import type { ChannelAttachment, ChannelMessage, ChannelRoom } from "../src/client/channel/protocol";

afterEach(() => vi.restoreAllMocks());

const attachment: ChannelAttachment = { id: "image", name: "image.gif", size: 6, mediaType: "image/gif", sha256: "a".repeat(64) };
const key = { roomId: "room", messageSeq: 1, attachmentId: attachment.id };
const inlineImage = { data: btoa("GIF89a"), mediaType: "image/gif" as const, original: true, width: 1, height: 1 };
const message: ChannelMessage = { id: "message", seq: 1, userId: "self", time: 1, text: "", attachments: [attachment] };

function setup() {
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 1024, maxAttachmentsPerMessage: 8, maxRetainedBytes: 1024, maxRetainedFiles: 8, maxInlineImageBytes: 65536 }),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const files = new ChannelAttachments(async () => {}, async () => {});
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
