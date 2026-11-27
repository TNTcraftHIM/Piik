import { stubTransferStorage } from "./fixtures/transfer-storage";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelAttachments } from "../src/client/channel/attachments";
import { channelErrorPresentation } from "../src/client/components/error-presentation";
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

test("retention cancels the source when permission is withdrawn while reading", async () => {
  const { FileStore: ActualFileStore } = await vi.importActual<typeof import("../src/client/channel/file-store")>("../src/client/channel/file-store");
  const store = new ActualFileStore({ domainId: "domain", userId: "self" });
  const file = new File(["GIF89a"], attachment.name);
  const cancel = vi.fn();
  let bytesRead = 0;
  vi.spyOn(file, "stream").mockReturnValue(new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (bytesRead === file.size) { controller.close(); return; }
      controller.enqueue(Uint8Array.of(++bytesRead));
    },
    cancel,
  }, { highWaterMark: 0 }));

  const result = await store.retain({ key, attachment, file }, { maxRetainedBytes: 1024, maxRetainedFiles: 8 }, () => bytesRead === 0);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(bytesRead).toBeGreaterThan(0);
  expect(bytesRead).toBeLessThan(file.size);
  expect(result).toEqual({ file: null, evicted: [] });
});

function setup(command = async (_command: ChannelCommand) => {}, confirmedMessage?: () => ChannelMessage | undefined,
  fileDataReady?: (peer: string, roomId: string) => boolean) {
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 1024, maxAttachmentsPerMessage: 8, maxRetainedBytes: 1024, maxRetainedFiles: 8, maxInlineImageBytes: 65536, maxInlineImageEdge: 1280 }),
  } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  const files = new ChannelAttachments(command, async () => {}, undefined, undefined, () => 2, confirmedMessage, fileDataReady);
  files.update("endpoint", { domainId: "domain", userId: "self" }, [],
    [{ id: key.roomId, authorized: true, available: true }] as ChannelRoom[], []);
  return files;
}

function setupObservations() {
  const command = vi.fn(async (_command: ChannelCommand) => {});
  const files = setup(command);
  const room = { id: key.roomId, authorized: true, available: true, reading: true,
    historyLineage: crypto.randomUUID(), capabilities: { attachments: true },
    delivery: { bindingId: "binding" } } as ChannelRoom;
  const update = (changes: Partial<ChannelRoom> = {}) =>
    files.update("endpoint", { domainId: "domain", userId: "self" }, [], [{ ...room, ...changes }], []);
  const observations = () => command.mock.calls.map(([event]) => event).filter(event => event.type === "observe_files");
  update();
  return { files, room, update, command, observations };
}

test("reader observations batch by room, match current binding and fit within the host limit", async () => {
  const { files, room, update, command, observations } = setupObservations();
  const retain = vi.spyOn(FileStore.prototype, "retain");
  const second = { ...key, messageSeq: 2 }, overflow = { ...key, messageSeq: 3 };
  const availability = (fileKey = key) => files.originalAvailability(fileKey, attachment, false);
  try {
    const release = files.observe(key), releaseDuplicate = files.observe(key);
    const releaseSecond = files.observe(second), releaseOverflow = files.observe(overflow);
    await Promise.resolve();
    const [first] = observations();
    expect(observations()).toHaveLength(1);
    expect(first).toMatchObject({ roomId: key.roomId, observationId: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i), keys: [[1, attachment.id], [2, attachment.id]] });
    update({ fileAvailability: { observationId: first.observationId, available: [true] } });
    expect(availability()).toBeUndefined();
    const report = { observationId: first.observationId, available: [true, false] };
    update({ fileAvailability: report });
    expect([availability(), availability(second), availability(overflow)]).toEqual([true, false, undefined]);

    release();
    await Promise.resolve();
    expect(observations()).toEqual([first]);
    releaseDuplicate();
    await Promise.resolve();
    const migrated = observations().at(-1)!;
    expect(migrated.keys).toEqual([[2, attachment.id], [3, attachment.id]]);
    expect(availability(overflow)).toBeUndefined();
    update({ fileAvailability: { observationId: migrated.observationId, available: [false, true] } });
    expect(availability(overflow)).toBe(true);

    const delivery = { ...room.delivery!, bindingId: "new-binding" };
    const staleReport = { observationId: migrated.observationId, available: [false, true] };
    update({ delivery, fileAvailability: staleReport });
    expect(availability(overflow)).toBeUndefined();
    await Promise.resolve();
    const rebound = observations().at(-1)!;
    expect(rebound.observationId).not.toBe(migrated.observationId);
    expect(availability(overflow)).toBeUndefined();
    update({ delivery, fileAvailability: { observationId: rebound.observationId, available: [true, false] } });
    expect([availability(second), availability(overflow)]).toEqual([true, false]);
    releaseSecond();
    releaseOverflow();
    await Promise.resolve();
    expect(observations().at(-1)?.keys).toEqual([]);
    expect(command.mock.calls.map(([event]) => event)).toEqual(observations());
    expect(retain).not.toHaveBeenCalled();
  } finally { files.reset(); }
});

test("reader observations are unknown without a detailed room or online host and stop when reading ends", async () => {
  const { files, update, observations } = setupObservations();
  try {
    const release = files.observe(key);
    update({ historyLineage: undefined });
    await Promise.resolve();
    expect(observations()).toEqual([]);
    expect(files.originalAvailability(key, attachment, false)).toBeUndefined();
    update();
    await Promise.resolve();
    const [request] = observations();
    const fileAvailability = { observationId: request.observationId, available: [false] };
    update({ fileAvailability });
    expect(files.originalAvailability(key, attachment, false)).toBe(false);
    update({ available: false, fileAvailability });
    expect(files.originalAvailability(key, attachment, false)).toBeUndefined();

    update({ reading: false });
    release();
    await Promise.resolve();
    expect(observations()).toEqual([request]);
  } finally { files.reset(); }
});

test("reader observations resume with a fresh identity after reconnecting to the same scope", async () => {
  const { files, room, observations } = setupObservations();
  const release = files.observe(key);
  try {
    await Promise.resolve();
    const [first] = observations();
    files.reset();
    files.update("new-endpoint", { domainId: "domain", userId: "self" }, [], [room], []);
    await Promise.resolve();
    const [, resumed] = observations();
    expect(resumed.keys).toEqual(first.keys);
    expect(resumed.observationId).not.toBe(first.observationId);
    files.reset();
    files.update("third-endpoint", { domainId: "domain", userId: "other" }, [], [room], []);
    await Promise.resolve();
    expect(observations()).toEqual([first, resumed]);
  } finally { release(); files.reset(); }
});

test("local originals remain available when the host is offline", async () => {
  const { files, update } = setupObservations();
  const file = new File(["GIF89a"], attachment.name);
  const signal = new AbortController().signal;
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("quota"));
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file }]);
    update({ available: false });
    expect(files.originalAvailability(key, attachment, false)).toBe(true);
    expect(files.originalAvailability(key, { ...attachment, sha256: "b".repeat(64) }, false)).toBeUndefined();
    await expect(files.content(key, attachment, signal)).resolves.toBe(file);

    const inlineKey = { ...key, messageSeq: 2 };
    expect(files.originalAvailability(inlineKey, attachment, true)).toBe(true);
    const inline = await files.content(inlineKey, attachment, signal, inlineImage);
    expect(await inline.text()).toBe("GIF89a");
  } finally { files.reset(); }
});

test("gaining access to another room reads only its cached attachments and download receipts", async () => {
  vi.stubGlobal("window", { piikRevealDownload: vi.fn() });
  const receipts = vi.spyOn(FileStore.prototype, "receipts").mockResolvedValue([]);
  const files = setup();
  try {
    const room = { id: key.roomId, authorized: true, available: true } as ChannelRoom;
    const second = { ...room, id: "second" };
    const scope = { domainId: "domain", userId: "self" };
    files.update("endpoint", scope, [], [room, { ...second, authorized: false }], []);
    files.update("endpoint", scope, [], [room, second], []);
    files.update("endpoint", scope, [], [room, second], []);
    const expected = [[[room.id]], [[second.id]]];
    expect(vi.mocked(FileStore.prototype.list).mock.calls).toEqual(expected);
    await vi.waitFor(() => expect(receipts.mock.calls).toEqual(expected));
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test.each(["active", "cancelled"])("a pending peer read follows the committed copy and withdraws an unreadable source when the request is %s", async request => {
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command);
  const original = new File(["GIF89a"], attachment.name), copy = new File(["GIF89a"], attachment.name);
  let rejectRead!: (reason: Error) => void, commit!: () => void;
  const slice = new Blob();
  const readOriginal = vi.spyOn(slice, "arrayBuffer").mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
  vi.spyOn(original, "slice").mockReturnValue(slice);
  vi.spyOn(FileStore.prototype, "retain").mockImplementation(() => new Promise(resolve => {
    commit = () => resolve({ file: copy, evicted: [] });
  }));
  const readResult = vi.fn(() => []), failed = vi.fn(() => request === "active" ? [{ type: "failed", key, code: "file_source_unavailable" }] : []);
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await hosting.loadRoomHosting(), FileDelivery: class {
      update() { return []; } next_deadline() {} free() {}
      control(_peer: string, requestId: string) { return [{ type: "read", key, offset: 2, length: 3, requestId }]; }
      read_result = readResult; request_failed = failed;
    },
  } as never);
  try {
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: original }]);
    files.data("peer", "control", "pending");
    await vi.waitFor(() => expect(readOriginal).toHaveBeenCalledOnce());
    commit();
    await vi.waitFor(async () => expect(await files.content(key, attachment, new AbortController().signal)).toBe(copy));
    const moved = new DOMException("The selected disk file moved", "NotReadableError");
    rejectRead(moved);
    await vi.waitFor(() => expect(readResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify(key), 2n, "pending", new TextEncoder().encode("F89")));
    expect(failed).not.toHaveBeenCalled();
    expect(files.originalAvailability(key, attachment, false)).toBe(true);

    vi.spyOn(copy, "slice").mockReturnValue(slice);
    files.data("peer", "control", "gone");
    await vi.waitFor(() => expect(readOriginal).toHaveBeenCalledTimes(2));
    rejectRead(moved);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith(JSON.stringify(key), "gone", "file_source_unavailable"));
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...key, sha256: attachment.sha256, available: false });
    expect(files.originalAvailability(key, attachment, false)).toBeUndefined();
  } finally { files.reset(); }
});

test("confirmed message removal discards its retained copy and blocks stale attachment reads", async () => {
  const removed = new Set<number>();
  const files = new ChannelAttachments(async () => {}, async () => {}, key => key.roomId === "room" && removed.has(key.messageSeq));
  const entry = { key, attachment, file: new File(["GIF89a"], attachment.name) };
  const sibling = { ...entry, key: { ...key, messageSeq: 2 } };
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([entry, sibling]);
  const drop = vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  files.update("endpoint", { domainId: "domain", userId: "self" }, [],
    [{ id: key.roomId, authorized: true, available: true }] as ChannelRoom[], []);
  try {
    await expect(files.content(key, attachment, new AbortController().signal, inlineImage)).resolves.toBeInstanceOf(File);
    removed.add(key.messageSeq);
    files.removeMessages(key.roomId, seq => removed.has(seq));
    expect(drop).toHaveBeenCalledOnce();
    await expect(files.content(key, attachment, new AbortController().signal, inlineImage)).rejects.toThrow("attachment_unavailable");
    await expect(files.retained(key.roomId)).resolves.toEqual([sibling]);
  } finally { files.reset(); }
});

test("background downloads follow the removed message sequence and room", async () => {
  const command = vi.fn(async (_command: ChannelCommand) => {});
  const files = setup(command), cancel = vi.fn(() => []);
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    FileDelivery: class {
      start() { return []; } update() { return []; } next_deadline() { return undefined; }
      cancel = cancel; free() {}
    },
  } as never);
  stubTransferStorage({ getFileHandle: async () => ({ createWritable: async () => ({ abort: async () => {} }) }),
    removeEntry: async () => {} });
  vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  const sibling = { ...key, messageSeq: key.messageSeq + 1 }, other = { ...key, roomId: "second" };
  const keys = [key, sibling, other];
  files.update("endpoint", { domainId: "domain", userId: "self" }, [],
    [key.roomId, other.roomId].map(id => ({ id, authorized: true, available: true, reading: false })) as ChannelRoom[], []);
  const downloads = keys.map(fileKey => files.download(fileKey, attachment).catch(error => error));
  try {
    await vi.waitFor(() => expect(command.mock.calls.filter(([event]) => event.type === "file_receive" && event.enabled)).toHaveLength(3));
    files.removeMessages(key.roomId, seq => seq === key.messageSeq);
    expect(await downloads[0]).toMatchObject({ name: "AbortError" });
    expect(keys.map(fileKey => files.status(fileKey).busy)).toEqual([false, true, true]);
    files.removeMessages(key.roomId, seq => seq <= sibling.messageSeq);
    expect(await downloads[1]).toMatchObject({ name: "AbortError" });
    expect(files.status(other).busy).toBe(true);
    expect(cancel.mock.calls).toEqual([[JSON.stringify(key)], [JSON.stringify(sibling)]]);
  } finally { files.reset(); await Promise.all(downloads); vi.unstubAllGlobals(); }
});

test("clearing one room cache withdraws its copies and ignores an older cache snapshot", async () => {
  const command = vi.fn(async (_command: ChannelCommand) => {});
  const files = setup(command), file = new File(["GIF89a"], attachment.name);
  const entry = { key, attachment, file };
  const other = { ...entry, key: { ...key, roomId: "second" } };
  const stale = { ...entry, key: { ...key, messageSeq: 2 } };
  const selected = { ...entry, key: { ...key, messageSeq: 3 } };
  const scope = { domainId: "domain", userId: "self" };
  const rooms = ["room", "second"].map(id => ({ id, available: true, authorized: true })) as ChannelRoom[];
  let readOlderSnapshot!: (files: typeof entry[]) => void;
  let loadOlderSnapshot!: (files: typeof entry[]) => void;
  let finishRetain!: (result: Awaited<ReturnType<FileStore["retain"]>>) => void;
  const retain = vi.spyOn(FileStore.prototype, "retain")
    .mockResolvedValueOnce({ file, evicted: [] })
    .mockImplementationOnce(() => new Promise(resolve => { finishRetain = resolve; }));
  const remove = vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  vi.mocked(FileStore.prototype.list)
    .mockResolvedValueOnce([entry, other])
    .mockImplementationOnce(() => new Promise(resolve => { readOlderSnapshot = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { loadOlderSnapshot = resolve; }))
    .mockResolvedValue([other]);
  try {
    files.update("endpoint", scope, [], rooms, []);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ ...other.key, available: true })));
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    await new Promise(resolve => setImmediate(resolve));
    files.confirmed(key.roomId, { ...message, seq: selected.key.messageSeq }, [{ id: attachment.id, attachment, file }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(2));
    const staleInventory = files.retained(key.roomId);
    files.update("endpoint", scope, [], [rooms[0]], []);
    files.update("endpoint", scope, [], rooms, []);
    command.mockClear();

    await files.clearLocalCache(key.roomId);
    expect(remove).toHaveBeenCalledWith(key.roomId, expect.any(Function));
    expect(remove.mock.calls[0][1](stale.key.messageSeq)).toBe(true);
    expect(command.mock.calls).toEqual([[{ type: "file_offer", ...key, sha256: attachment.sha256, available: false }]]);
    expect(retain.mock.calls[1][2]?.()).toBe(false);
    finishRetain({ file, evicted: [] });
    readOlderSnapshot([entry, stale, other]);
    loadOlderSnapshot([entry, stale, other]);
    expect(await staleInventory).toEqual([selected]);
    expect(command.mock.calls.filter(([event]) => event.type === "file_offer" && event.available)
      .map(([event]) => event)).toEqual([{ type: "file_offer", ...other.key, sha256: attachment.sha256, available: true }]);
    expect(await files.retained(other.key.roomId)).toEqual([other]);
    command.mockClear();
    files.resume();
    expect(command).toHaveBeenCalledTimes(2);
    for (const entry of [other, selected]) expect(command).toHaveBeenCalledWith({
      type: "file_offer", ...entry.key, sha256: attachment.sha256, available: true,
    });

    files.reset();
    command.mockClear();
    files.update("another-endpoint", scope, [], rooms, []);
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...other.key, sha256: attachment.sha256, available: true });
  } finally { files.reset(); }
});

test("a host cleanup invalidates older reads and restores only through its confirmed sequence", async () => {
  const files = setup(), lineage = crypto.randomUUID(), scope = { domainId: "domain", userId: "self" };
  const room = { id: key.roomId, authorized: true, available: true, historyLineage: lineage } as ChannelRoom;
  files.update("endpoint", scope, [], [room], []);
  const file = new File(["GIF89a"], attachment.name);
  const rows = [1, 2, 3].map(messageSeq => ({ key: { ...key, messageSeq }, attachment, file }));
  let finishSnapshot!: (value: typeof rows) => void;
  const snapshot = new Promise<typeof rows>(resolve => { finishSnapshot = resolve; });
  let finishRetention!: (value: { file: File; evicted: [] }) => void;
  const retention = new Promise<{ file: File; evicted: [] }>(resolve => { finishRetention = resolve; });
  const retain = vi.spyOn(FileStore.prototype, "retain").mockReturnValueOnce(retention)
    .mockResolvedValue({ file, evicted: [] });
  const clear = vi.spyOn(FileStore.prototype, "clearRetained").mockResolvedValue();
  try {
    vi.mocked(FileStore.prototype.list).mockReturnValueOnce(snapshot);
    const inventory = files.retained(key.roomId);
    const restore = files.restoreRetained(key.roomId, rows);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    await expect(files.clearRetainedFor(key.roomId, "stale", 2)).rejects.toThrow("room_unavailable");
    expect(clear).not.toHaveBeenCalled();
    await files.clearRetainedFor(key.roomId, lineage, 2);
    expect(retain.mock.calls[0][2]?.()).toBe(false);
    finishSnapshot(rows);
    await expect(inventory).resolves.toEqual([rows[2]]);
    finishRetention({ file, evicted: [] });
    await expect(restore).resolves.toBe(false);
    expect(retain.mock.calls.map(([row]) => row.key.messageSeq)).toEqual([1, 3]);
    await expect(files.retained(key.roomId)).resolves.toEqual([rows[2]]);
  } finally { files.reset(); }
});

test("an old session cleanup failure cannot release the replacement session pending cache guard", async () => {
  const files = setup(), lineage = crypto.randomUUID(), scope = { domainId: "domain", userId: "self" };
  const rooms = [{ id: key.roomId, available: true, authorized: true, historyLineage: lineage }] as ChannelRoom[];
  let failFirst!: (error: Error) => void, finishSecond!: () => void;
  const first = new Promise<void>((_resolve, reject) => { failFirst = reject; });
  const second = new Promise<void>(resolve => { finishSecond = resolve; });
  vi.spyOn(FileStore.prototype, "clearRetained").mockReturnValueOnce(first).mockReturnValueOnce(second);
  const entry = { key, attachment, file: new File(["GIF89a"], attachment.name) };
  const retain = vi.spyOn(FileStore.prototype, "retain").mockResolvedValue({ file: entry.file, evicted: [] });
  try {
    files.update("endpoint", scope, [], rooms, []);
    const retired = files.clearRetainedFor(key.roomId, lineage, 1);
    files.update("replacement", scope, [], rooms, []);
    const current = files.clearRetainedFor(key.roomId, lineage, 1);
    failFirst(new Error("store closed"));
    await expect(retired).rejects.toThrow("store closed");
    expect(await files.restoreRetained(key.roomId, [entry])).toBe(false);
    expect(retain).not.toHaveBeenCalled();
    finishSecond();
    await current;
    expect(await files.restoreRetained(key.roomId, [entry])).toBe(true);
  } finally { files.reset(); }
});

test("host cleanup switches a cached upload to the selected file and permits a later explicit restore", async () => {
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command);
  const lineage = crypto.randomUUID(), scope = { domainId: "domain", userId: "self" };
  const original = new File(["GIF89a"], attachment.name), copy = new File([original], original.name);
  const signal = new AbortController().signal;
  vi.spyOn(FileStore.prototype, "retain").mockResolvedValue({ file: copy, evicted: [] });
  vi.spyOn(FileStore.prototype, "clearRetained").mockResolvedValue();
  try {
    files.update("endpoint", scope, [], [{ id: key.roomId, available: true, authorized: true, historyLineage: lineage }] as ChannelRoom[], []);
    files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: original }]);
    await vi.waitFor(async () => expect(await files.content(key, attachment, signal)).toBe(copy));
    await files.clearRetainedFor(key.roomId, lineage, key.messageSeq);
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: "file_offer", available: false }));
    expect(await files.content(key, attachment, signal)).toBe(original);
    expect(await files.restoreRetained(key.roomId, [{ key, attachment, file: copy }])).toBe(true);
    expect(await files.content(key, attachment, signal)).toBe(copy);
    await files.clearRetainedFor(key.roomId, lineage, key.messageSeq);
    expect(files.originalAvailability(key, attachment, false)).toBeUndefined();
  } finally { files.reset(); }
});

test.each(["local", "host"] as const)("clearing the %s cache retires its completed OPFS download and preserves a selected upload", async kind => {
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command);
  const file = new File(["GIF89a"], attachment.name), signal = new AbortController().signal;
  const upload = new File(["GIF89a"], attachment.name);
  const selected = { ...key, messageSeq: 2 };
  const getFileHandle = vi.fn(async (_name: string) => ({
    getFile: async () => file, createWritable: async () => ({ close: async () => {}, abort: async () => {} }),
  }));
  const removeEntry = vi.fn(async (_name: string) => {});
  stubTransferStorage({ getFileHandle, removeEntry });
  vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new DOMException("Cache full", "QuotaExceededError"));
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start() { return []; } update() { return []; } next_deadline() {} free() {}
      control() { return [{ type: "complete", key }]; }
    },
  } as never);
  try {
    files.confirmed(key.roomId, { ...message, seq: selected.messageSeq }, [{ id: attachment.id, attachment, file: upload }]);
    const downloaded = files.content(key, attachment, signal);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    files.data("source", "control", "verified");
    expect(await downloaded).toBe(file);
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...key, sha256: attachment.sha256, available: true });
    if (kind === "host") {
      const lineage = crypto.randomUUID();
      files.update("endpoint", { domainId: "domain", userId: "self" }, [],
        [{ id: key.roomId, available: true, authorized: true, historyLineage: lineage }] as ChannelRoom[], []);
      vi.spyOn(FileStore.prototype, "clearRetained").mockResolvedValue();
      removeEntry.mockRejectedValueOnce(new Error("busy"));
      await expect(files.clearRetainedFor(key.roomId, lineage, selected.messageSeq)).rejects.toThrow("busy");
      removeEntry.mockClear();
      await files.clearRetainedFor(key.roomId, lineage, selected.messageSeq);
    } else await files.clearLocalCache(key.roomId);
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...key, sha256: attachment.sha256, available: false });
    expect(removeEntry).toHaveBeenCalledExactlyOnceWith(getFileHandle.mock.calls[0][0]);
    expect(files.originalAvailability(key, attachment, false)).toBeUndefined();
    command.mockClear();
    files.resume(key.roomId);
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "file_offer", ...selected, sha256: attachment.sha256, available: true });
    expect(await files.content(selected, attachment, signal)).toBe(upload);
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("a legacy inline GIF remains readable without a live session, cache or transfer", async () => {
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
  const initializeRuntime = vi.fn(() => initialization), start = vi.fn(() => []), free = vi.fn();
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime,
    FileDelivery: class { update() { return []; } next_deadline() { return undefined; } start = start; free = free; },
  } as never);
  const save = vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => options?.outcome?.("dispatched"));
  const first = files.download(key, attachment);
  void first.catch(() => {});
  try {
    await vi.waitFor(() => expect(initializeRuntime).toHaveBeenCalledOnce());
    expect(files.status(key)).toMatchObject({ busy: true });
    files.cancelDownload(key);
    expect(files.status(key)).toMatchObject({ busy: false, outcome: "cancelled", error: null });
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

test.each(["attachment_unavailable", "disconnected"])("a reopened room reconciles its cached original and saved receipt after %s", async code => {
  vi.stubGlobal("window", { piikRevealDownload: vi.fn() });
  const file = new File(["GIF89a"], attachment.name);
  const receipt = { key, sha256: attachment.sha256, receipt: "saved-copy" };
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([{ key, attachment, file }]);
  vi.spyOn(FileStore.prototype, "receipts").mockResolvedValue([receipt]);
  const remove = vi.spyOn(FileStore.prototype, "remove").mockResolvedValue();
  let rejectOffer!: (error: Error) => void;
  const offer = new Promise<void>((_, reject) => { rejectOffer = reject; });
  const files = new ChannelAttachments(async command => {
    if (command.type === "file_offer" && command.available) await offer;
  }, async () => {});
  try {
    files.update("new-endpoint", { domainId: "domain", userId: "reader" }, [],
      [{ id: key.roomId, authorized: true, available: true }] as ChannelRoom[], []);
    await vi.waitFor(() => expect(files.hasSavedCopy(key, attachment)).toBe(true));
    rejectOffer(new Error(code));
    if (code === "attachment_unavailable") {
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(key, attachment, { forgetReceipt: true }));
      expect(files.hasSavedCopy(key, attachment)).toBe(false);
    } else {
      await vi.waitFor(() => expect(files.status(key).error).toBe("file_offer_failed"));
      expect(remove).not.toHaveBeenCalled();
      expect(files.hasSavedCopy(key, attachment)).toBe(true);
      await expect(files.content(key, attachment, new AbortController().signal)).resolves.toBe(file);
    }
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("a rejection from the old room writer cannot discard a source offered to its successor", async () => {
  const file = new File(["GIF89a"], attachment.name);
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([{ key, attachment, file }]);
  const remove = vi.spyOn(FileStore.prototype, "remove").mockResolvedValue();
  let rejectOldOffer!: (error: Error) => void;
  const oldOffer = new Promise<void>((_, reject) => { rejectOldOffer = reject; });
  let offers = 0;
  const files = new ChannelAttachments(async command => {
    if (command.type === "file_offer" && command.available && ++offers === 1) await oldOffer;
  }, async () => {});
  const room = { id: key.roomId, authorized: true, available: true, delivery: { bindingId: "old-writer" } } as ChannelRoom;
  const scope = { domainId: "domain", userId: "reader" };
  try {
    files.update("endpoint", scope, [], [room], []);
    await vi.waitFor(() => expect(offers).toBe(1));
    files.update("endpoint", scope, [], [{ ...room, delivery: { ...room.delivery!, bindingId: "new-writer" } }], []);
    rejectOldOffer(new Error("attachment_unavailable"));
    await new Promise(resolve => setImmediate(resolve));
    expect(remove).not.toHaveBeenCalled();
    expect(offers).toBe(2);
    expect(files.originalAvailability(key, attachment, false)).toBe(true);
    await expect(files.content(key, attachment, new AbortController().signal)).resolves.toBe(file);
  } finally { files.reset(); }
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

test("a platform save follows its participant across room views and ignores results after an identity switch", async () => {
  const files = setup();
  const saveReceipt = vi.spyOn(FileStore.prototype, "saveReceipt").mockImplementation(async (_entry, allowed) => allowed?.() ?? true);
  const reports: NonNullable<Parameters<typeof downloads.downloadBlob>[2]>[] = [];
  vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => {
    reports.push(options!); options?.outcome?.("requested");
  });
  const scope = { domainId: "domain", userId: "self" };
  const room = { id: key.roomId, authorized: true, available: true, reading: true } as ChannelRoom;
  const other = { ...room, id: "other", reading: false };
  try {
    files.update("endpoint", scope, [], [room, other], []);
    await files.download(key, attachment, inlineImage);
    files.update("endpoint", scope, [], [{ ...room, reading: false }, { ...other, reading: true }], []);
    reports[0].progress?.({ received: 3, total: 6 });
    expect(files.status(key)).toMatchObject({ outcome: "started", saveProgress: { received: 3, total: 6 } });
    expect(files.status({ ...key, roomId: other.id }).outcome).toBeUndefined();
    await files.download(key, attachment, inlineImage);
    expect(reports).toHaveLength(1);

    files.update("successor", { ...scope, userId: "successor" }, [], [room, other], []);
    await files.download(key, attachment, inlineImage);
    expect(reports).toHaveLength(2);
    expect(reports[0].signal?.aborted).toBe(true);
    reports[0].progress?.({ received: 6, total: 6 });
    reports[0].rememberSaved?.("old");
    reports[0].outcome?.("saved");
    reports[0].outcome?.("failed");
    expect(files.status(key)).toMatchObject({ outcome: "requested", error: null });
    expect(files.hasSavedCopy(key, attachment)).toBe(false);

    reports[1].rememberSaved?.("new");
    reports[1].outcome?.("saved");
    await vi.waitFor(() => expect(files.hasSavedCopy(key, attachment)).toBe(true));
    expect(files.status(key)).toMatchObject({ outcome: "saved", error: null });
    expect(saveReceipt).toHaveBeenCalledOnce();
    expect(saveReceipt.mock.calls[0]?.[0].receipt).toBe("new");
  } finally { files.reset(); }
});

test("a restored attachment only reuses the platform save for matching content", async () => {
  const files = setup(), reports: NonNullable<Parameters<typeof downloads.downloadBlob>[2]>[] = [];
  const saveReceipt = vi.spyOn(FileStore.prototype, "saveReceipt").mockResolvedValue(true);
  vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => {
    reports.push(options!); options!.outcome?.("requested");
  });
  try {
    const replacement = { ...attachment, sha256: "b".repeat(64) };
    const first = files.download(key, attachment, inlineImage);
    await first;
    expect(files.download(key, { ...attachment, sha256: attachment.sha256.toUpperCase() }, inlineImage)).toBe(first);
    expect(files.status(key, replacement)).toEqual({ busy: false, error: null });
    await files.download(key, replacement, { ...inlineImage, data: btoa("GIF87a") });
    expect(reports).toHaveLength(2);
    expect(reports[0].signal?.aborted).toBe(true);
    reports[0].rememberSaved?.("old"); reports[0].outcome?.("saved");
    expect(files.status(key, replacement).outcome).toBe("requested");
    reports[1].rememberSaved?.("new"); reports[1].outcome?.("saved");
    reports[0].outcome?.("failed");
    expect(files.status(key, replacement).outcome).toBe("saved");
    expect(files.status(key, attachment).outcome).toBeUndefined();
    expect(saveReceipt.mock.calls.map(([receipt]) => receipt.receipt)).toEqual(["new"]);
  } finally { files.reset(); }
});

test.each(["in progress", "completed without retention"])("restore replaces a receiver that is %s at the same attachment key", async phase => {
  let row: ChannelMessage | undefined;
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command, () => row);
  const a = { ...attachment, size: 3 }, b = { ...a, sha256: "b".repeat(64) };
  const getFileHandle = vi.fn()
    .mockImplementationOnce(async () => handle("AAA"))
    .mockImplementationOnce(async () => handle("BBB"));
  function handle(bytes: string) {
    return { getFile: async () => new File([bytes], a.name),
      createWritable: async () => ({ abort: async () => {}, close: async () => {} }) };
  }
  const cancel = vi.fn(() => []);
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start() { return []; } update() { return []; } cancel = cancel; free() {}
      next_deadline() { return undefined; }
      control() { return [{ type: "complete", key }]; }
    },
  } as never);
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new Error("quota"));
  const save = vi.spyOn(downloads, "downloadBlob").mockImplementation(() => {});
  stubTransferStorage({ getFileHandle, removeEntry: async () => {} });
  const update = (bindingId: string) => files.update("endpoint", { domainId: "domain", userId: "self" }, [],
    [{ id: key.roomId, authorized: true, available: true, delivery: { bindingId } }] as ChannelRoom[], []);
  const read = (descriptor: ChannelAttachment) => files.content(key, descriptor, new AbortController().signal).then(file => file.text());
  try {
    update("old");
    const old = read(a);
    void old.catch(() => {});
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    if (phase === "completed without retention") {
      files.data("source", "control", "finished");
      await expect(old).resolves.toBe("AAA");
    }
    update("restored");
    await expect(read(b)).rejects.toThrow("attachment_unavailable");
    row = { ...message, attachments: [b] };
    const next = read(b), download = files.download(key, b);
    await vi.waitFor(() => expect(getFileHandle).toHaveBeenCalledTimes(2));
    if (phase === "in progress") await expect(old).rejects.toThrow("attachment_unavailable");
    files.data("source", "control", "finished");
    await expect(next).resolves.toBe("BBB");
    await download;
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(await save.mock.calls[0][0].text()).toBe("BBB");
    await expect(read(a)).rejects.toThrow("attachment_unavailable");
    await expect(read(b)).resolves.toBe("BBB");
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("restoring new bytes retires a preview receiver before its old file can finish", async () => {
  const command = vi.fn(async (_event: ChannelCommand) => {});
  const files = setup(command), oldFile = new File(["GIF89a"], attachment.name);
  const replacement = { ...attachment, sha256: "b".repeat(64) }, newFile = new File(["GIF87a"], attachment.name);
  const removeEntry = vi.fn(async () => {});
  stubTransferStorage({ getFileHandle: async () => ({ getFile: async () => oldFile,
    createWritable: async () => ({ close: async () => {}, abort: async () => {} }) }), removeEntry });
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start() { return []; } update() { return []; } cancel() { return []; } free() {}
      next_deadline() {}
      control() { return [{ type: "complete", key }]; }
    },
  } as never);
  vi.spyOn(FileStore.prototype, "retain").mockImplementation(async entry => ({ file: entry.file, evicted: [] }));
  try {
    const signal = new AbortController().signal;
    const preview = files.content(key, attachment, signal);
    void preview.catch(() => {});
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    await files.restoreRetained(key.roomId, [{ key, attachment: replacement, file: newFile }]);
    files.data("source", "control", "finished");
    await expect(preview).rejects.toThrow("attachment_unavailable");
    await expect(files.content(key, replacement, signal)).resolves.toBe(newFile);
    expect(removeEntry).toHaveBeenCalledOnce();
  } finally { files.reset(); vi.unstubAllGlobals(); }
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

test.each(["confirmed", "restored"])("a late %s source cannot retain over its successor", async origin => {
  const files = setup(), old = new File(["GIF89a"], attachment.name), next = new File(["second"], attachment.name);
  const successor = { ...attachment, sha256: "b".repeat(64) };
  let complete!: (result: { file: File; evicted: [] }) => void;
  const retain = vi.spyOn(FileStore.prototype, "retain")
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockRejectedValue(new Error("optional_cache_unavailable"));
  try {
    if (origin === "confirmed") files.confirmed(key.roomId, message, [{ id: attachment.id, attachment, file: old }]);
    else void files.restoreRetained(key.roomId, [{ key, attachment, file: old }]);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    const allowed = retain.mock.calls[0][2]!;
    expect(allowed()).toBe(true);
    files.confirmed(key.roomId, { ...message, attachments: [successor] }, [{ id: successor.id, attachment: successor, file: next }]);
    expect(allowed()).toBe(false);
    complete({ file: old, evicted: [] });
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(2));
    expect(await files.content(key, successor, new AbortController().signal)).toBe(next);
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
    expect(channelErrorPresentation("file_transfer_interrupted", copy).message).toBe(copy("channel.attachment.transferInterrupted"));
    expect(channelErrorPresentation("image_decode_failed", copy, "channel.attachment.previewFailed").message).toBe(copy("channel.attachment.previewFailed"));
    expect(channelErrorPresentation("download_failed", copy, "channel.attachment.downloadFailed").message).toBe(copy("channel.attachment.saveFailed"));
    expect(channelErrorPresentation("file_offer_failed", copy).message).toBe(copy("channel.attachment.fileOfferFailed"));
  }
});

test.each(["en", "zh", "zh-Hant", "ja", "ko"] as const)("archive budget guidance names the available file option in %s", lang => {
  const copy = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t(lang, key, vars);
  const budget = channelErrorPresentation("backup_content_limit", copy);
  expect(budget).toEqual({ message: copy("channel.error.backupContentLimit", { option: copy("room.backup.includeFiles") }), connectionHelp: false });
  expect(budget.message).toContain(copy("room.backup.includeFiles"));
  expect(budget.message).not.toBe(copy("channel.error.actionFailed"));
  expect(channelErrorPresentation("invalid_backup_content", copy).message).toBe(copy("channel.error.actionFailed"));
});


test.each(["before", "after"])("a new room writer completes a pending download when the old request fails %s the last range", async timing => {
  let rejectOldReceive!: (error: Error) => void;
  const oldReceive = new Promise<void>((_, reject) => { rejectOldReceive = reject; });
  const receive = vi.fn(async () => {}).mockImplementationOnce(() => oldReceive);
  const files = setup(async command => { if (command.type === "file_receive" && command.enabled) await receive(); });
  const file = new File(["GIF89a"], attachment.name);
  const removeEntry = vi.fn(async () => {});
  const open = vi.fn(async () => ({ getFile: async () => file, createWritable: async () => ({
    write: async () => {}, close: async () => {}, abort: async () => {},
  }) }));
  stubTransferStorage({
    getFileHandle: open, removeEntry,
  });
  const start = vi.fn(() => []), cancel = vi.fn(() => []);
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start = start; cancel = cancel; update() { return []; } next_deadline() {} free() {}
      control() { return [{ type: "write", key, offset: 0, bytes: new TextEncoder().encode("GIF89a") }]; }
      written() { return [{ type: "complete", key }]; }
    },
  } as never);
  const retain = vi.spyOn(FileStore.prototype, "retain");
  if (timing === "after") retain.mockRejectedValue(new DOMException("Cache full", "QuotaExceededError"));
  else retain.mockResolvedValue({ file, evicted: [] });
  const room = (bindingId: string) => ({ id: key.roomId, authorized: true, available: true, delivery: { bindingId } }) as ChannelRoom;
  const scope = { domainId: "domain", userId: "self" };
  const controller = new AbortController();
  try {
    files.update("endpoint", scope, [], [room("previous")], []);
    const result = vi.fn();
    void files.content(key, attachment, controller.signal).then(result, result);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    files.update("endpoint", scope, [], [room("current")], []);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    if (timing === "before") rejectOldReceive(new Error("retired_writer"));
    files.update("endpoint", scope, [{ roomId: key.roomId, messageSeq: key.messageSeq, attachment, authorId: "author",
      sourceId: "source", upstream: "source", downstream: [], receiving: true }], [room("current")], []);
    files.data("source", "control", "verified-range");
    await vi.waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith(file));
    if (timing === "after") rejectOldReceive(new Error("retired_writer"));
    await oldReceive.catch(() => {});
    expect(open).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(files.progress(key)).toBeNull();
    if (timing === "after") {
      expect(removeEntry).not.toHaveBeenCalled();
      await expect((await files.content(key, attachment, controller.signal)).text()).resolves.toBe("GIF89a");
      expect(files.progress(key)).toBeNull();
      files.reset();
      await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledOnce());
    }
  } finally { controller.abort(); rejectOldReceive(new Error("retired_writer")); files.reset(); vi.unstubAllGlobals(); }
});

test.each(["write", "peer"] as const)("a %s failure reports its cause and removes the partial download", async failure => {
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command);
  const abort = vi.fn(async () => {}), removeEntry = vi.fn(async () => {});
  const write = vi.fn(async () => { throw new DOMException("Local quota exhausted", "QuotaExceededError"); });
  const getFileHandle = vi.fn(async (_name: string) => ({ createWritable: async () => ({ write, abort }) }));
  stubTransferStorage({ getFileHandle, removeEntry });
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start() { return []; } update() { return []; } cancel() { return []; } next_deadline() {} free() {}
      control() { return [failure === "write" ? { type: "write", key, offset: 0, bytes: Uint8Array.of(1) }
        : { type: "failed", key, code: "file_transfer_interrupted" }]; }
    },
  } as never);
  try {
    const code = failure === "write" ? "file_storage_full" : "file_transfer_interrupted";
    const rejected = expect(files.download(key, attachment)).rejects.toThrow(code);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    files.data("source", "control", "result");
    await rejected;
    expect(files.status(key)).toMatchObject({ busy: false, error: code });
    const message = failure === "write" ? "channel.attachment.storageFull" : "channel.attachment.transferInterrupted";
    for (const fallback of ["channel.attachment.downloadFailed", "channel.attachment.previewFailed"] as const)
      expect(channelErrorPresentation(code, key => key, fallback).message).toBe(message);
    expect(abort).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledExactlyOnceWith(getFileHandle.mock.calls[0][0]));
    expect(files.progress(key)).toBeNull();
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("cancel while waiting for a source permits retry before the old receive command settles", async () => {
  let rejectOldReceive!: (reason: Error) => void;
  const oldReceive = new Promise<void>((_, reject) => { rejectOldReceive = reject; });
  let starts = 0;
  const command = vi.fn(async (command: ChannelCommand) => {
    if (command.type === "file_receive" && command.enabled && ++starts === 1) await oldReceive;
  });
  const files = setup(command);
  const cancel = vi.fn(() => []), removeEntry = vi.fn(async (_name: string) => {});
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    FileDelivery: class {
      start() { return []; } update() { return []; } next_deadline() { return undefined; }
      cancel = cancel; free() {}
    },
  } as never);
  stubTransferStorage({
    getFileHandle: async () => ({ createWritable: async () => ({ abort: async () => {} }) }),
    removeEntry,
  });
  const room = { id: key.roomId, authorized: true, available: true } as ChannelRoom;
  const scope = { domainId: "domain", userId: "self" };
  const plan = { roomId: key.roomId, messageSeq: key.messageSeq, attachment, authorId: "author",
    sourceId: null, upstream: null, downstream: [], receiving: true };
  try {
    files.update("endpoint", scope, [plan], [room], []);
    const first = files.download(key, attachment);
    void first.catch(() => {});
    await vi.waitFor(() => expect(starts).toBe(1));
    files.update("endpoint", scope, [plan], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 0, state: "waiting-source" });
    files.cancelDownload(key);
    expect(files.progress(key)).toBeNull();
    const retry = files.download(key, attachment);
    void retry.catch(() => {});
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(starts).toBe(2));
    rejectOldReceive(new Error("retired_receive_failed"));
    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    expect(files.status(key)).toMatchObject({ busy: true, error: null });
    expect(files.progress(key)).toMatchObject({ received: 0 });
    files.cancelDownload(key);
    await expect(retry).rejects.toMatchObject({ name: "AbortError" });
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test.each(["cancel", "revoke", "identity switch"])("shared file progress survives leaving the view and a retired writer cannot affect a retry after %s", async retirement => {
  const openPeers = new Set(["source"]);
  const command = vi.fn(async (_command: ChannelCommand) => {}), files = setup(command, undefined, peer => openPeers.has(peer));
  const file = new File(["GIF89a"], attachment.name);
  const save = vi.spyOn(downloads, "downloadBlob").mockImplementation((_file, _name, options) => options?.outcome?.("dispatched"));
  let finishWrite!: () => void;
  const written = vi.fn((_key: string, _offset: bigint, size: number) => size === file.size ? [{ type: "complete", key }] : []);
  const cancel = vi.fn(() => []), remove = vi.fn(async () => {});
  const removeSession = vi.fn(async (_name: string) => {});
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    FileDelivery: class {
      start() { return []; } update() { return []; } next_deadline() { return undefined; }
      peer_unavailable() { return []; }
      written = written; cancel = cancel; free() {}
      control(_peer: string, data: string) {
        if (data === "queued-write" || data === "resumed-write") {
          return [{ type: "write", key, offset: data === "queued-write" ? 3 : 4, bytes: Uint8Array.of(4) }];
        }
        const bytes = data === "retry-write" ? new TextEncoder().encode("GIF89a") : Uint8Array.of(1, 2, 3);
        return [{ type: "write", key, offset: 0, bytes }];
      }
    },
  } as never);
  stubTransferStorage({
    getFileHandle: async () => ({ getFile: async () => file, createWritable: async () => ({
      write: () => new Promise<void>(resolve => { finishWrite = resolve; }), close: async () => {}, abort: async () => {},
    }) }), removeEntry: remove,
  }, removeSession);
  const first = new AbortController();
  const scope = { domainId: "domain", userId: "self" };
  const room = { id: key.roomId, authorized: true, available: true } as ChannelRoom;
  const plan = { roomId: key.roomId, messageSeq: key.messageSeq, attachment, authorId: "author",
    sourceId: "source", upstream: "source", downstream: [], receiving: true };
  files.update("endpoint", scope, [plan], [room], []);
  const a = files.content(key, attachment, first.signal), b = files.download(key, attachment);
  void a.catch(() => {}); void b.catch(() => {});
  try {
    await vi.waitFor(() => expect(files.progress(key)).toEqual({ received: 0, total: attachment.size, state: "waiting" }));
    expect(files.progress(key)).toBe(files.progress(key)); // Stable useSyncExternalStore snapshot.
    files.data("source", "control", "owned-write");
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    expect(files.progress(key)?.received).toBe(0); expect(written).not.toHaveBeenCalled();
    const firstWrite = finishWrite;
    files.data("source", "control", "queued-write");
    const sourceGone = { ...plan, sourceId: null, upstream: null };
    files.update("endpoint", scope, [sourceGone], [room], []);
    finishWrite();
    await vi.waitFor(() => expect(files.progress(key)).toEqual({ received: 3, total: attachment.size, state: "waiting-source" }));
    expect(written).toHaveBeenCalledWith(JSON.stringify(key), 0n, 3);
    await vi.waitFor(() => expect(finishWrite).not.toBe(firstWrite));
    first.abort(); await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(files.progress(key)?.received).toBe(3); expect(cancel).not.toHaveBeenCalled();
    const otherRoom = { ...room, id: "second", reading: true };
    files.update("endpoint", scope, [sourceGone], [{ ...room, reading: false }, otherRoom], []);
    expect(files.progress(key)).toMatchObject({ received: 3, state: "waiting-source" });
    const alternate = { ...plan, sourceId: "alternate", upstream: "alternate" };
    files.update("endpoint", scope, [alternate], [{ ...room, reading: true }, { ...otherRoom, reading: false }], []);
    expect(files.progress(key)).toMatchObject({ received: 3, state: "connecting" });
    const queuedWrite = finishWrite;
    queuedWrite();
    await vi.waitFor(() => expect(files.progress(key)).toMatchObject({ received: 4, state: "connecting" }));
    // The newly selected upstream may already have an open room connection.
    files.update("endpoint", scope, [plan], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 4, state: "waiting" });
    files.update("endpoint", scope, [alternate], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 4, state: "connecting" });
    files.peerState("source", true);
    expect(files.progress(key)).toMatchObject({ received: 4, state: "connecting" });
    openPeers.add("alternate");
    files.data("alternate", "control", "resumed-write");
    await vi.waitFor(() => expect(finishWrite).not.toBe(queuedWrite));
    const resumedWrite = finishWrite;
    resumedWrite();
    await vi.waitFor(() => expect(files.progress(key)).toMatchObject({ received: 5, state: "receiving" }));
    files.update("endpoint", scope, [alternate], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 5, state: "receiving" });
    openPeers.delete("alternate");
    files.update("endpoint", scope, [{ ...alternate, upstream: null }], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 5, state: "connecting" });
    files.update("endpoint", scope, [alternate], [room], []);
    expect(files.progress(key)).toMatchObject({ received: 5, state: "connecting" });
    openPeers.add("alternate");
    files.peerState("alternate", true);
    expect(files.progress(key)).toMatchObject({ received: 5, state: "waiting" });
    files.data("alternate", "control", "old-write");
    await vi.waitFor(() => expect(finishWrite).not.toBe(resumedWrite));
    const oldWrite = finishWrite;
    const cancellationSnapshots: boolean[] = [];
    const unsubscribe = files.subscribe(() => cancellationSnapshots.push(files.status(key).busy));
    try {
      if (retirement === "cancel") files.cancelDownload(key);
      else if (retirement === "revoke") files.update("endpoint", scope, [], [{ ...room, authorized: false, available: false }], []);
      else files.update("new-endpoint", { ...scope, userId: "successor" }, [alternate], [room], []);
    } finally { unsubscribe(); }
    const retiredCancels = retirement === "identity switch" ? 0 : 1;
    if (retirement === "identity switch") {
      expect(command).not.toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: false });
    }
    expect(cancellationSnapshots).toContain(false);
    expect(cancellationSnapshots).not.toContain(true);
    expect(files.progress(key)).toBeNull();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(retiredCancels));
    if (retirement === "revoke") {
      await expect(files.content(key, attachment, new AbortController().signal, inlineImage)).rejects.toThrow("room_unavailable");
      files.update("new-endpoint", scope, [alternate], [room], []);
    }
    const retry = files.download(key, attachment);
    void retry.catch(() => {});
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(files.progress(key)).toEqual({ received: 0, total: attachment.size, state: "waiting" }));
    expect(remove).not.toHaveBeenCalled();
    expect(removeSession).not.toHaveBeenCalled();
    oldWrite();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    if (retirement === "identity switch") await vi.waitFor(() => expect(removeSession).toHaveBeenCalledOnce());
    expect(files.progress(key)).toEqual({ received: 0, total: attachment.size, state: "waiting" });
    expect(written).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(retiredCancels);
    expect(save).not.toHaveBeenCalled();
    files.data("source", "control", "retry-write");
    await vi.waitFor(() => expect(finishWrite).not.toBe(oldWrite));
    finishWrite();
    await retry;
    expect(save).toHaveBeenCalledExactlyOnceWith(file, attachment.name, expect.anything());
    expect(command).toHaveBeenCalledWith({ type: "file_offer", ...key, sha256: attachment.sha256, available: true });
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test.each(["cancel", "revoke"])("a retired download cannot retain its OPFS file during completion after %s", async retirement => {
  const files = setup(), file = new File(["GIF89a"], attachment.name);
  const removeEntry = vi.fn(async (_name: string) => {});
  const getFileHandle = vi.fn(async (_name: string) => ({
    getFile: async () => file, createWritable: async () => ({ close: async () => {}, abort: async () => {} }),
  }));
  let commit!: () => void;
  const retain = vi.spyOn(FileStore.prototype, "retain").mockImplementation((_entry, _limits, allowed) =>
    new Promise(resolve => { commit = () => resolve({ file: allowed?.() ? file : null, evicted: [] }); }));
  const save = vi.spyOn(downloads, "downloadBlob").mockImplementation(() => {});
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await vi.mocked(hosting.loadRoomHosting)(),
    FileDelivery: class {
      start() { return []; } update() { return []; } cancel() { return []; } free() {}
      next_deadline() { return undefined; }
      control() { return [{ type: "complete", key }]; }
    },
  } as never);
  stubTransferStorage({ getFileHandle, removeEntry });
  const scope = { domainId: "domain", userId: "self" };
  const room = { id: key.roomId, authorized: true, available: true } as ChannelRoom;
  const pending = files.download(key, attachment);
  void pending.catch(() => {});
  try {
    await vi.waitFor(() => expect(files.progress(key)).not.toBeNull());
    files.data("source", "control", "verified");
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    expect(files.progress(key)?.state).toBe("finishing");
    if (retirement === "cancel") files.cancelDownload(key);
    else {
      files.update("endpoint", scope, [], [{ ...room, authorized: false }], []);
      files.update("endpoint", scope, [], [room], []);
    }
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const retry = files.download(key, attachment);
    void retry.catch(() => {});
    await vi.waitFor(() => expect(getFileHandle).toHaveBeenCalledTimes(2));
    expect(retain.mock.calls[0][2]?.()).toBe(false);
    commit();
    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledExactlyOnceWith(getFileHandle.mock.calls[0][0]));
    expect(files.progress(key)?.state).toBe("waiting");
    expect(save).not.toHaveBeenCalled();
  } finally { commit?.(); files.reset(); vi.unstubAllGlobals(); }
});

test("small and animated images retain their original file and send a separate thumbnail", async () => {
  const files = setup();
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({ initializeRuntime: async () => {},
    attachment_limits: () => JSON.stringify({ maxFileBytes: 2048, maxAttachmentsPerMessage: 8, maxRetainedBytes: 4096, maxRetainedFiles: 8, maxInlineImageBytes: 1024, maxInlineImageEdge: 1280 }),
    attachment_media_type: (bytes: Uint8Array) => bytes[0] === 71 ? "image/gif" : "image/png",
    AttachmentHash: class { update() {} finish() { return "a".repeat(64); } },
  } as never);
  const decode = vi.fn(async () => {});
  vi.stubGlobal("Image", class { naturalWidth = 1500; naturalHeight = 750; decode = decode; });
  const thumbnail = new Blob(["RIFFabcdWEBPpreview"], { type: "image/webp" });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage() {} }),
    toBlob: (callback: BlobCallback) => callback(thumbnail) }) });
  try {
    const selected = [new File(["GIF89a"], "tiny.gif"), new File(["PNG", new Uint8Array(1024)], "large.png")]
      .map(file => ({ file, id: crypto.randomUUID() }));
    const prepared = await files.describe(selected);
    for (const [i, image] of prepared.entries()) {
      expect(image.file).toBe(selected[i].file);
      expect(image.attachment.size).toBe(selected[i].file.size);
      expect(image.inlineImage).toEqual({ original: false, mediaType: "image/webp", width: 1280, height: 640, data: btoa(await thumbnail.text()) });
    }
    decode.mockRejectedValue(new Error("invalid_image"));
    expect((await files.describe(selected)).every(entry => entry.inlineImage === undefined)).toBe(true);
  } finally { files.reset(); vi.unstubAllGlobals(); }
});

test("a late receive timeout preserves the completed session file until cache cleanup", async () => {
  let rejectReceive!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { rejectReceive = reject; });
  const command = vi.fn(async (event: ChannelCommand) => {
    if (event.type === "file_receive" && event.enabled) await pending;
  });
  const files = setup(command);
  const file = new File(["GIF89a"], attachment.name);
  const removeEntry = vi.fn(async () => {});
  stubTransferStorage({ getFileHandle: async () => ({
    createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
    getFile: async () => file,
  }), removeEntry });
  vi.spyOn(FileStore.prototype, "retain").mockRejectedValue(new DOMException("Quota exceeded", "QuotaExceededError"));
  vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  vi.mocked(hosting.loadRoomHosting).mockResolvedValue({
    ...await hosting.loadRoomHosting(),
    FileDelivery: class {
      start() { return []; } cancel() { return []; } update() { return []; } next_deadline() {} free() {}
      control() { return [{ type: "write", key, offset: 0, bytes: new TextEncoder().encode("GIF89a") }]; }
      written() { return [{ type: "complete", key }]; }
    },
  } as never);
  try {
    const signal = new AbortController().signal;
    const read = files.content(key, attachment, signal);
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ type: "file_receive", ...key, enabled: true }));
    files.update("endpoint", { domainId: "domain", userId: "self" }, [{
      roomId: key.roomId, messageSeq: key.messageSeq, attachment, authorId: "author",
      sourceId: "source", upstream: "source", downstream: [], receiving: true,
    }], [{ id: key.roomId, authorized: true, available: true }] as ChannelRoom[], []);
    files.data("source", "control", "verified-range");
    await expect(read).resolves.toBe(file);
    rejectReceive(new Error("request_timeout"));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(removeEntry).not.toHaveBeenCalled();
    await expect(files.content(key, attachment, signal)).resolves.toBe(file);
    await files.clearLocalCache(key.roomId);
    expect(removeEntry).toHaveBeenCalledOnce();
  } finally { files.reset(); vi.unstubAllGlobals(); }
});
