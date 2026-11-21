import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { downloadBlob, type DownloadOutcome } from "../src/client/lib/download";
import { FileStore } from "../src/client/channel/file-store";
import type { ChannelRoom } from "../src/client/channel/protocol";
import { ChannelAttachments } from "../src/client/channel/attachments";

const reportScript = readFileSync(new URL("../prototype/channel-server/src/app_windows/download.rs", import.meta.url), "utf8")
  .match(/const REPORT: &str = r#"([\s\S]*?)"#;/)![1];
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(native = true, origin = "https://owned.test", globals = true) {
  vi.useFakeTimers();
  let sequence = 0;
  const create = vi.fn(() => "blob:" + origin + "/owned-" + ++sequence), revoke = vi.fn();
  const view = Object.assign(new EventTarget(), { origin, closed: false, piikNativeDownloads: native,
    URL: { createObjectURL: create, revokeObjectURL: revoke }, setTimeout });
  const clicked: Anchor[] = [], anchors: Anchor[] = [];
  class Anchor extends EventTarget {
    href = ""; download = ""; hidden = false; dataset: Record<string, string> = {};
    click() { clicked.push(this); }
    remove() { const index = anchors.indexOf(this); if (index !== -1) anchors.splice(index, 1); }
  }
  const owner = { defaultView: view, createElement: () => new Anchor(),
    body: { append: (link: Anchor) => anchors.push(link) }, querySelectorAll: () => anchors };
  if (globals) { vi.stubGlobal("window", view); vi.stubGlobal("document", owner); }
  const report = (url: string, status: string | { status: "saved"; receipt: string } | { status: "progress"; received: number; total: number | null }) => runInNewContext("(" + reportScript + ")", {
    window: view, document: owner, URL, CustomEvent,
  })(url, typeof status === "string" ? { status } : status);
  return { view, document: owner as unknown as Document, clicked, anchors, create, revoke, report };
}

test.each(["saved", "cancelled", "failed"])("Native %s belongs to its still-live anchor", status => {
  const f = fixture(), outcomes: DownloadOutcome[] = [];
  downloadBlob(new Blob(["owned"]), "owned.txt", { outcome: value => outcomes.push(value) });
  const url = f.clicked[0].href;
  expect(outcomes).toEqual(["requested"]); expect(f.anchors).toHaveLength(1);
  vi.runOnlyPendingTimers(); expect(f.revoke).toHaveBeenCalledWith(url);
  f.report("blob:https://owned.test/other", "saved"); expect(outcomes).toEqual(["requested"]);
  f.report(url, "started"); expect(outcomes).toEqual(["requested", "started"]);
  f.report(url, status); expect(outcomes).toEqual(["requested", "started", status]); expect(f.anchors).toEqual([]);
  f.report(url, "started"); expect(outcomes.at(-1)).toBe(status);
});

test.each([false, true])("page retirement releases observation (started=%s)", started => {
  const f = fixture(), outcome = vi.fn();
  downloadBlob(new Blob(["owned"]), "owned.txt", { outcome });
  const url = f.clicked[0].href;
  if (started) f.report(url, "started");
  f.view.dispatchEvent(new Event("pagehide"));
  expect(f.anchors).toEqual([]);
  f.report(url, "saved");
  expect(outcome.mock.calls.flat()).toEqual(started ? ["requested", "started", "dispatched"] : ["requested", "dispatched"]);
  const next = fixture(true, "https://next.test", false), unexpected = vi.fn();
  const link = next.document.createElement("a"); link.href = url;
  link.addEventListener("piik-native-download", unexpected); next.document.body.append(link);
  next.report(url, "saved"); expect(unexpected).not.toHaveBeenCalled();
});

test("aborting observation removes both page and native listeners", () => {
  const f = fixture(), outcome = vi.fn(), controller = new AbortController();
  downloadBlob(new Blob(["owned"]), "owned.txt", { outcome, signal: controller.signal });
  controller.abort();
  f.view.dispatchEvent(new Event("pagehide"));
  f.report(f.clicked[0].href, "saved");
  expect(f.anchors).toEqual([]);
  expect(outcome.mock.calls.flat()).toEqual(["requested"]);
});

test("a completed result cannot be overwritten by a later starting notification", () => {
  const f = fixture(), outcome = vi.fn();
  downloadBlob(new Blob(["owned"]), "owned.txt", { outcome });
  f.report(f.clicked[0].href, "saved"); f.report(f.clicked[0].href, "started");
  expect(outcome.mock.calls.map(([value]) => value)).toEqual(["requested", "saved"]);
});

test("Browser dispatch has no saved claim, and unobserved exports retain no anchors", () => {
  const f = fixture(false), outcome = vi.fn();
  downloadBlob(new Blob(["owned"]), "owned.txt", { outcome });
  expect(outcome).toHaveBeenCalledWith("dispatched"); expect(f.anchors).toEqual([]);
  f.view.piikNativeDownloads = true;
  downloadBlob(new Blob(["owned"]), "export.txt"); expect(f.anchors).toEqual([]);
});

test("confirmed attachment receipts restore only for the current identity and original digest", async () => {
  const f = fixture(), files = new ChannelAttachments(async () => {}, async () => {});
  const reveal = vi.fn().mockResolvedValue("unavailable");
  Object.assign(f.view, { piikRevealDownload: reveal });
  const scope = { domainId: "domain", userId: "alice" };
  const rooms = [{ id: "room", authorized: true }] as ChannelRoom[];
  const key = { roomId: "room", messageSeq: 1, attachmentId: "file" };
  const receipt = "a2ba9eea-8aa4-4ce9-97f2-3ff030242412";
  const file = { id: key.attachmentId, name: "saved.txt", size: 5, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const entry = { key, sha256: file.sha256, receipt };
  const read = vi.spyOn(FileStore.prototype, "receipts").mockResolvedValue([]);
  const save = vi.spyOn(FileStore.prototype, "saveReceipt").mockImplementation(async (_entry, allowed) => allowed());
  const forget = vi.spyOn(FileStore.prototype, "forgetReceipt").mockResolvedValue();
  vi.spyOn(FileStore.prototype, "list").mockResolvedValue([]);
  vi.spyOn(files, "content").mockResolvedValue(new File(["saved"], file.name));
  files.update("session", scope, [], rooms, []);
  await files.download(key, file);
  const first = f.clicked[0];
  expect(first.dataset).toHaveProperty("piikRemember");
  expect(files.hasSavedCopy(key, file)).toBe(false);
  f.report(first.href, { status: "saved", receipt });
  await Promise.resolve();
  expect(save).toHaveBeenCalledWith(entry, expect.any(Function));
  expect(files.hasSavedCopy(key, file)).toBe(true);
  expect(files.hasSavedCopy(key, { ...file, sha256: "b".repeat(64) })).toBe(false);
  await files.download(key, file);
  const retired = f.clicked.at(-1)!;
  files.update("session2", { ...scope, userId: "bob" }, [], rooms, []);
  f.report(retired.href, { status: "saved", receipt });
  expect(save).toHaveBeenCalledOnce();
  expect(files.hasSavedCopy(key, file)).toBe(false);

  read.mockResolvedValue([entry]);
  files.update("session3", scope, [], rooms, []);
  await vi.waitFor(() => expect(files.hasSavedCopy(key, file)).toBe(true));
  reveal.mockResolvedValueOnce("failed").mockResolvedValueOnce("revealed");
  await files.revealSavedCopy(key, file, { ownerDocument: f.document } as Element);
  expect(files.status(key).error).toBe("reveal_saved_copy_failed");
  expect(forget).not.toHaveBeenCalled();
  expect(files.hasSavedCopy(key, file)).toBe(true);
  await files.revealSavedCopy(key, file, { ownerDocument: f.document } as Element);
  expect(files.status(key).error).toBeNull();
  await files.revealSavedCopy(key, file, { ownerDocument: f.document } as Element);
  expect(reveal).toHaveBeenCalledWith(receipt);
  expect(forget).toHaveBeenCalledWith(entry);
  expect(files.hasSavedCopy(key, file)).toBe(false);
  expect(files.status(key)).toEqual({ busy: false, error: "saved_copy_missing" });
  expect(f.clicked).toHaveLength(2);

  const purge = vi.spyOn(FileStore.prototype, "removeMessages").mockResolvedValue();
  await files.download(key, file);
  f.report(f.clicked.at(-1)!.href, { status: "saved", receipt });
  await vi.waitFor(() => expect(files.hasSavedCopy(key, file)).toBe(true));
  expect(files.status(key).outcome).toBe("saved");
  await files.clearLocalCache(key.roomId);
  expect(files.hasSavedCopy(key, file)).toBe(false);
  expect(files.status(key).outcome).toBeUndefined();

  await files.download(key, file);
  expect(files.status(key)).toMatchObject({ error: null, outcome: "requested" });
  const pending = f.clicked.at(-1)!;
  await files.clearLocalCache(key.roomId);
  expect(purge).toHaveBeenCalledWith(key.roomId, expect.any(Function));
  f.report(pending.href, { status: "saved", receipt });
  await Promise.resolve();
  expect(files.hasSavedCopy(key, file)).toBe(false);
  files.reset();
});

test("one attachment save owns the request through its native result", async () => {
  const f = fixture();
  const files = new ChannelAttachments(async () => {}, async () => {});
  const file = { id: "owned", name: "owned.txt", size: 5, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const key = { roomId: "owned", messageSeq: 1, attachmentId: file.id };
  vi.spyOn(files, "content").mockResolvedValue(new File(["owned"], file.name));
  const save = files.download(key, file);
  await save;
  expect(files.status(key).outcome).toBe("requested");
  expect(files.download(key, file)).toBe(save);
  const first = f.clicked[0];
  f.report(first.href, "started");
  expect(files.status(key).outcome).toBe("started");
  expect(files.download(key, file)).toBe(save);
  files.cancelDownload(key);
  expect(f.clicked).toEqual([first]);
  expect(f.anchors).toEqual([first]);
  f.report(first.href, "failed"); expect(files.status(key).error).toBe("download_failed");
  expect(f.anchors).toEqual([]);
  await files.download(key, file);
  expect(f.clicked).toHaveLength(2);
  files.reset(); expect(f.anchors).toEqual([]);
});

test("an adopted attachment uses its current document and window when bytes arrive", async () => {
  const home = fixture(), pip = fixture(true, "https://owned.test", false);
  const files = new ChannelAttachments(async () => {}, async () => {});
  const file = { id: "owned", name: "owned.txt", size: 5, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const key = { roomId: "owned", messageSeq: 1, attachmentId: file.id };
  let finish!: (file: File) => void;
  vi.spyOn(files, "content").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const surface = { ownerDocument: home.document };
  const pending = files.download(key, file, undefined, surface as Element);
  surface.ownerDocument = pip.document;
  finish(new File(["owned"], file.name)); await pending;
  expect(home.create).not.toHaveBeenCalled(); expect(pip.create).toHaveBeenCalledOnce();
  const url = pip.clicked[0].href;
  home.report(url, "saved"); expect(files.status(key).outcome).toBe("requested");
  pip.report(url, "started"); pip.report(url, "saved"); expect(files.status(key).outcome).toBe("saved");
  expect(home.anchors).toEqual([]); expect(pip.anchors).toEqual([]); files.reset();
});


test("system save progress follows verified content and retires with its own retry", async () => {
  const f = fixture(), files = new ChannelAttachments(async () => {}, async () => {});
  const file = { id: "progress", name: "owned.txt", size: 8, mediaType: "application/octet-stream" as const, sha256: "a".repeat(64) };
  const key = { roomId: "owned", messageSeq: 1, attachmentId: file.id };
  let received!: (file: File) => void;
  vi.spyOn(files, "content").mockImplementationOnce(() => new Promise(resolve => { received = resolve; }))
    .mockResolvedValue(new File(["verified"], file.name));
  const receiving = files.download(key, file);
  expect(files.status(key)).toEqual({ busy: true, error: null });
  expect(f.clicked).toHaveLength(0);
  received(new File(["verified"], file.name)); await receiving;
  const first = f.clicked[0].href;
  f.report(first, "started");
  for (const progress of [{ received: 0, total: null }, { received: 0, total: 8 }, { received: 4, total: 8 }, { received: 0, total: 8 }, { received: 8, total: 8 }]) {
    f.report(first, { status: "progress", ...progress });
    expect(files.status(key)).toMatchObject({ busy: false, error: null, outcome: "started", saveProgress: progress });
    expect(files.progress(key)).toBeNull();
  }
  f.report(first, "failed");
  expect(files.status(key)).toMatchObject({ outcome: "failed", error: "download_failed", saveProgress: undefined });
  await files.download(key, file);
  const next = f.clicked[1].href;
  f.report(first, { status: "progress", received: 8, total: 8 }); f.report(first, "saved");
  expect(files.status(key).outcome).toBe("requested");
  f.report(next, "started"); f.report(next, { status: "progress", received: 8, total: 8 });
  expect(files.status(key).outcome).toBe("started");
  f.report(next, "saved");
  expect(files.status(key)).toMatchObject({ outcome: "saved", error: null, saveProgress: undefined });
  expect(f.anchors).toHaveLength(0);
  await files.download(key, file); const cancelled = f.clicked[2].href;
  f.report(cancelled, "cancelled");
  f.report(cancelled, { status: "progress", received: 8, total: 8 });
  expect(files.status(key).outcome).toBe("cancelled");
  files.reset();
});
