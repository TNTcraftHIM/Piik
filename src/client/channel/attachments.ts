import { z } from "zod";
import { downloadBlob, type DownloadOutcome, type DownloadProgress } from "../lib/download";
import { FileStore, sameContent, type FileScope, type FileRetentionLimits, type RetainedFile, type SavedReceipt } from "./file-store";
import { loadRoomHosting } from "./hosting";
import type { AttachmentHash, FileDelivery } from "../../../prototype/channel-browser/pkg/piik_channel_browser";
import { attachmentSchema, fileKeyString, type ChannelAttachment, type ChannelCommand, type ChannelFileKey, type ChannelFilePlan, type ChannelMessage, type ChannelRoom, type ChannelPair, type ImageRendition } from "./protocol";
import { VisibleFileAvailability } from "./file-availability";
import { inlineImageFile, prepareInlineImage } from "./image-preview";
import { openTransferStorage, type TransferStorage } from "./transfer-storage";

export const attachmentLimitsSchema = z.object({ maxFileBytes: z.number().positive(), maxAttachmentsPerMessage: z.number().positive(), maxRetainedBytes: z.number().positive(), maxRetainedFiles: z.number().positive(), maxInlineImageBytes: z.number().int().positive(), maxInlineImageEdge: z.number().int().positive() });
export type AttachmentLimits = z.infer<typeof attachmentLimitsSchema>;
export interface DraftFile { id: string; file: File }
export interface PreparedFile extends DraftFile { attachment: ChannelAttachment; inlineImage?: ImageRendition }
type Hosting = Awaited<ReturnType<typeof loadRoomHosting>>;
type Effect =
  | { type: "send_control"; peer: string; control: { type: string; key: ChannelFileKey; requestId: string } }
  | { type: "send_chunk"; peer: string; key: ChannelFileKey; requestId: string; offset: number; frame: Uint8Array<ArrayBuffer> }
  | { type: "cancel_chunks"; peer: string; key: ChannelFileKey; requestId: string; offset: number }
  | { type: "read"; key: ChannelFileKey; requestId: string; offset: number; length: number }
  | { type: "write"; key: ChannelFileKey; offset: number; bytes: Uint8Array<ArrayBuffer> }
  | { type: "complete"; key: ChannelFileKey }
  | { type: "failed"; key: ChannelFileKey; code: string };
interface Runtime { module: Hosting; delivery: FileDelivery; lifetime: AbortController }
interface Sink {
  lifetime: AbortController;
  file: FileSystemFileHandle; directory: FileSystemDirectoryHandle; name: string;
  writer: FileSystemWritableFileStream; complete: boolean;
  tail: Promise<void>; promise: Promise<File>; resolve(file: File): void; reject(error: Error): void;
}
export interface AttachmentProgress { received: number; total: number; state: "waiting" | "connecting" | "waiting-source" | "receiving" | "finishing" }
interface PendingSink { key: ChannelFileKey; attachment: ChannelAttachment; ready: Promise<Sink>; consumers: Set<symbol>; progress: AttachmentProgress | null; receive?: symbol }
export function isNativeSavePending(outcome?: DownloadOutcome): boolean {
  return outcome === "requested" || outcome === "started";
}

export function attachmentDownloadDocument(surface?: Document | null): Document | undefined {
  // The App's room document owns download callbacks and receipts across panel movement.
  if (typeof document !== "undefined" && document.defaultView?.piikNativeDownloads === true
    && typeof document.defaultView.piikRevealDownload === "function") return document;
  return surface ?? undefined;
}

interface Download { key: ChannelFileKey; attachment: ChannelAttachment; controller: AbortController; promise: Promise<void>; status: { busy: boolean; error: string | null; outcome?: DownloadOutcome; saveProgress?: DownloadProgress } }
interface Source { key: ChannelFileKey; attachment: ChannelAttachment; file: File; status: typeof idle; storage: "original" | "retained" | "session-cache"; offer?: Promise<void> }
interface CacheClear { revision: number; pending?: Promise<void> }
const idle: Download["status"] = { busy: false, error: null };
const cacheRoom = (scope: FileScope, roomId: string) => JSON.stringify([scope.domainId, scope.userId, roomId]);
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error));
function throwStorageError(error: unknown, fallback?: string): never {
  if (error instanceof DOMException && error.name === "QuotaExceededError") throw new Error("file_storage_full");
  if (fallback) throw new Error(fallback, { cause: error });
  throw error;
}
const aborted = () => new DOMException("Cancelled", "AbortError");

/** Participant-owned readable files and active sinks; Rust owns range and route decisions. */
export class ChannelAttachments {
  private sessionId: string | null = null;
  private lifetime = new AbortController();
  private runtime: Promise<Runtime> | null = null;
  private plans: ChannelFilePlan[] = [];
  private roomPeers: [string, string[]][] = [];
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private rooms: ChannelRoom[] = [];
  private availability = new VisibleFileAvailability(() => this.rooms, command => this.command(command),
    () => this.changed(), key => this.messageRemoved(key), () => this.observationLimit());
  private sources = new Map<string, Source>();
  private scope: FileScope | null = null;
  private store: FileStore | null = null;
  private savedReceipts = new Map<string, SavedReceipt>();
  private cacheRevision = 0;
  private cacheClears = new Map<string, CacheClear>();
  private sinks = new Map<string, PendingSink>();
  private transferStorage?: Promise<TransferStorage>;
  private sinkDisposals = new Set<Promise<void>>();
  private downloads = new Map<string, Download>();
  private listeners = new Set<() => void>();
  constructor(private command: (command: ChannelCommand) => Promise<void>,
    private sendData: (peer: string, kind: "control" | "chunk", data: string | Uint8Array, allowed: () => boolean, request?: string) => Promise<void>,
    private messageRemoved: (key: Pick<ChannelFileKey, "roomId" | "messageSeq">) => boolean = () => false,
    private cancelChunks?: (peer: string, request: string) => void,
    private observationLimit: () => number = () => 0,
    private confirmedMessage?: (key: ChannelFileKey) => ChannelMessage | undefined) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  status = (key: ChannelFileKey, attachment?: ChannelAttachment) => {
    const id = fileKeyString(key), entry = this.downloads.get(id), holder = this.sources.get(id);
    const download = entry && (!attachment || sameContent(entry.attachment, attachment)) ? entry.status : undefined;
    const source = holder && (!attachment || sameContent(holder.attachment, attachment)) ? holder.status : undefined;
    if (download && (download.busy || download.outcome || download.error)) return download;
    return source?.error ? source : download ?? idle;
  };
  observe(key: ChannelFileKey): () => void { return this.availability.observe(key); }

  originalAvailability(key: ChannelFileKey, attachment: ChannelAttachment, inlineOriginal: boolean): boolean | undefined {
    if (this.messageRemoved(key) || !this.matchesRead(key, attachment)) return undefined;
    const room = this.rooms.find(room => room.id === key.roomId);
    if (room && !room.authorized) return undefined;
    const id = fileKeyString(key), source = this.sources.get(id);
    if (inlineOriginal || (source && sameContent(source.attachment, attachment))) return true;
    return this.availability.current(key, room);
  }

  hasSavedCopy(key: ChannelFileKey, attachment: ChannelAttachment): boolean {
    return this.savedReceipts.get(fileKeyString(key))?.sha256 === attachment.sha256.toLowerCase();
  }
  async revealSavedCopy(key: ChannelFileKey, attachment: ChannelAttachment, surface: Element): Promise<void> {
    const id = fileKeyString(key), entry = this.savedReceipts.get(id), store = this.store;
    const view = attachmentDownloadDocument(surface.ownerDocument)?.defaultView;
    if (!entry || !store || !this.hasSavedCopy(key, attachment) || !view?.piikRevealDownload) return;
    const previous = this.downloads.get(id);
    const result = await view.piikRevealDownload(entry.receipt);
    if (result === "cancelled") return;
    if (this.store !== store || this.savedReceipts.get(id) !== entry) return;
    if (result === "unavailable") this.savedReceipts.delete(id);
    if (this.downloads.get(id) === previous && !previous?.status.busy && !isNativeSavePending(previous?.status.outcome)) {
      if (result === "revealed") {
        if (previous?.status.error === "reveal_saved_copy_failed") previous.status = { ...previous.status, error: null };
      } else {
        const status = { busy: false, error: result === "failed" ? "reveal_saved_copy_failed" : "saved_copy_missing" };
        if (previous && sameContent(previous.attachment, attachment)) previous.status = status;
        else this.downloads.set(id, { key, attachment, controller: new AbortController(), promise: Promise.resolve(), status });
      }
    }
    this.changed();
    if (result === "unavailable") await store.forgetReceipt(entry);
  }
  progress = (key: ChannelFileKey): AttachmentProgress | null => this.sinks.get(fileKeyString(key))?.progress ?? null;
  private changed() { for (const listener of this.listeners) listener(); }
  private async module(): Promise<Hosting> { const module = await loadRoomHosting(); await module.initializeRuntime(); return module; }
  limits = async (signal?: AbortSignal): Promise<AttachmentLimits> => {
    const module = await this.module(); signal?.throwIfAborted();
    return attachmentLimitsSchema.parse(JSON.parse(module.attachment_limits()));
  };
  private ensure(): Promise<Runtime> {
    if (!this.sessionId) return Promise.reject(new Error("disconnected"));
    if (this.runtime) return this.runtime;
    const lifetime = this.lifetime, session = this.sessionId;
    const runtime = this.module().then(module => {
      lifetime.signal.throwIfAborted();
      const runtime = { module, delivery: new module.FileDelivery(session), lifetime };
      try {
        this.invoke(runtime, () => this.project(runtime));
      } catch (error) {
        runtime.delivery.free();
        throw error;
      }
      return runtime;
    });
    // A failed load is not a runtime; the next demand loads again.
    runtime.catch(() => { if (this.runtime === runtime) this.runtime = null; });
    return this.runtime = runtime;
  }
  private current(runtime: Runtime): boolean { return this.lifetime === runtime.lifetime && !runtime.lifetime.signal.aborted; }
  private project(runtime: Runtime): Effect[] { return runtime.delivery.update(JSON.stringify(this.plans), JSON.stringify(this.roomPeers), BigInt(Date.now())); }
  private invoke(runtime: Runtime, work: () => Effect[]): void {
    if (!this.current(runtime)) return;
    this.effects(runtime, work());
    clearTimeout(this.expiry);
    const deadline = runtime.delivery.next_deadline();
    this.expiry = deadline === undefined ? undefined : setTimeout(() => this.invoke(runtime,
      () => runtime.delivery.expire(BigInt(Date.now()))), Math.max(0, Number(deadline) - Date.now()));
  }

  update(sessionId: string, scope: FileScope, plans: ChannelFilePlan[], rooms: ChannelRoom[], pairs: Pick<ChannelPair, "peerId" | "rooms">[]): void {
    if ((this.sessionId && this.sessionId !== sessionId) || (this.scope && (this.scope.domainId !== scope.domainId || this.scope.userId !== scope.userId))) this.reset();
    this.sessionId = sessionId;
    const opening = !this.store;
    this.scope = scope;
    const store = this.store ??= new FileStore(scope);
    const previous = this.rooms;
    const authorized = new Set(rooms.filter(room => room.authorized).map(room => room.id));
    plans = plans.filter(plan => authorized.has(plan.roomId) && !this.messageRemoved(plan));
    const previousPlans = this.plans;
    this.rooms = rooms; this.plans = plans;
    this.roomPeers = pairs.map(pair => [pair.peerId, pair.rooms]);
    let changed = this.availability.update(scope, previous);
    for (const [id, entry] of this.sinks) {
      if (!authorized.has(entry.key.roomId)) {
        this.sinks.delete(id);
        if (this.runtime) void this.runtime.then(runtime => this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(entry.key)))).catch(() => {});
        void this.retireSink(entry.ready, new Error("room_unavailable"));
        changed = true;
        continue;
      }
      const matches = (plan: ChannelFilePlan) => plan.roomId === entry.key.roomId && plan.messageSeq === entry.key.messageSeq
        && plan.attachment.id === entry.key.attachmentId;
      const plan = plans.find(matches);
      if (plan && !sameContent(plan.attachment, entry.attachment)) {
        void this.stopSink(entry, new Error("attachment_unavailable"));
        continue;
      }
      if (!entry.progress || entry.progress.state === "finishing") continue;
      let state = entry.progress.state;
      if (!plan?.sourceId) state = "waiting-source";
      else if (!plan.upstream) state = "connecting";
      else if (state === "waiting-source" || (state === "connecting" && !previousPlans.find(matches)?.upstream)) state = "waiting";
      if (state !== entry.progress.state) { entry.progress = { ...entry.progress, state }; changed = true; }
    }
    for (const [id, download] of this.downloads) {
      if (authorized.has(download.key.roomId)) continue;
      this.downloads.delete(id);
      download.controller.abort();
      changed = true;
    }
    for (const [id, source] of this.sources) {
      if (!authorized.has(source.key.roomId)) this.sources.delete(id);
      else if (!this.matchesPlan(source)) this.withdraw(source, true);
    }
    for (const [id, { key }] of this.savedReceipts) {
      if (!authorized.has(key.roomId)) {
        this.savedReceipts.delete(id); changed = true;
      }
    }
    if (changed) this.changed();
    const cacheRooms = rooms.filter(room => room.authorized && (opening || !previous.some(old => old.id === room.id && old.authorized))).map(room => room.id);
    if (cacheRooms.length) {
      const revision = this.cacheRevision;
      let receiptsLoaded: Promise<void> | undefined;
      if (typeof window !== "undefined" && typeof window.piikRevealDownload === "function") {
        const clearing = cacheRooms.flatMap(roomId => this.cacheClears.get(cacheRoom(scope, roomId))?.pending ?? []);
        receiptsLoaded = Promise.allSettled(clearing).then(() => store.receipts(cacheRooms)).then(entries => {
          if (this.store !== store) return;
          let changed = false;
          for (const entry of entries) {
            const { key } = entry, id = fileKeyString(key);
            if (this.messageRemoved(key) || this.savedReceipts.has(id)
              || (this.cacheClears.get(cacheRoom(scope, key.roomId))?.revision ?? 0) > revision
              || !this.rooms.some(room => room.id === key.roomId && room.authorized)) continue;
            this.savedReceipts.set(id, entry); changed = true;
          }
          if (changed) this.changed();
        }).catch(() => {});
      }
      void this.listCachedFiles(store, scope, cacheRooms).then(async files => {
        // A rejected offer can retire the saved receipt as soon as a source is installed.
        if (receiptsLoaded) await receiptsLoaded;
        if (this.store !== store) return;
        for (const { key, attachment, file } of files) if ((this.cacheClears.get(cacheRoom(scope, key.roomId))?.revision ?? 0) <= revision
          && !this.messageRemoved(key) && this.rooms.some(room => room.id === key.roomId && room.authorized) && !this.sources.has(fileKeyString(key))) {
          this.installSource({ key, attachment, file, status: idle, storage: "retained" });
        }
      }).catch(() => {});
    }
    if (plans.length || this.runtime) void this.ensure().then(runtime => this.invoke(runtime, () => this.project(runtime))).catch(() => {});
    for (const room of rooms) if (room.authorized && room.available && previous.some(old => old.id === room.id
      && (!old.available || old.delivery?.bindingId !== room.delivery?.bindingId))) this.resume(room.id);
  }
  private matchesPlan(source: Pick<Source, "key" | "attachment">): boolean {
    const plan = this.plans.find(plan => fileKeyString({ roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id }) === fileKeyString(source.key));
    return !plan || sameContent(source.attachment, plan.attachment);
  }
  private listCachedFiles(store: FileStore, scope: FileScope, roomIds: string[]): Promise<RetainedFile[]> {
    const clearing = roomIds.flatMap(roomId => this.cacheClears.get(cacheRoom(scope, roomId))?.pending ?? []);
    return clearing.length ? Promise.allSettled(clearing).then(() => store.list(roomIds)) : store.list(roomIds);
  }
  async clearLocalCache(roomId: string): Promise<void> {
    const store = this.store, scope = this.scope;
    if (!store || !scope || !this.rooms.some(room => room.id === roomId && room.authorized)) throw new Error("room_unavailable");
    const id = cacheRoom(scope, roomId), previous = this.cacheClears.get(id);
    if (previous?.pending) return previous.pending;
    const clear: CacheClear = { revision: ++this.cacheRevision };
    this.cacheClears.set(id, clear);
    clear.pending = store.removeMessages(roomId, () => true).then(async () => {
      if (!this.scope || cacheRoom(this.scope, roomId) !== id) return;
      for (const [id, entry] of this.savedReceipts) {
        if (entry.key.roomId !== roomId) continue;
        this.savedReceipts.delete(id);
        if (this.downloads.get(id)?.status.outcome === "saved") this.downloads.delete(id);
      }
      for (const source of this.sources.values()) {
        if (source.key.roomId === roomId && source.storage !== "original") this.withdraw(source, false);
      }
      const disposals = [];
      for (const [id, entry] of this.sinks) {
        if (entry.key.roomId !== roomId || entry.progress) continue;
        this.sinks.delete(id);
        disposals.push(this.retireSink(entry.ready, aborted()));
      }
      this.changed();
      await Promise.all(disposals);
    }, error => {
      if (previous) this.cacheClears.set(id, previous);
      else this.cacheClears.delete(id);
      throw error;
    }).finally(() => { clear.pending = undefined; });
    return clear.pending;
  }
  removeMessages(roomId: string, removed: (seq: number) => boolean): void {
    const matches = (key: Pick<ChannelFileKey, "roomId" | "messageSeq">) => key.roomId === roomId && removed(key.messageSeq);
    this.plans = this.plans.filter(plan => !matches(plan));
    for (const [id, entry] of this.savedReceipts) if (matches(entry.key)) this.savedReceipts.delete(id);
    for (const [id, source] of this.sources) if (matches(source.key)) this.sources.delete(id);
    for (const [id, download] of this.downloads) {
      if (!matches(download.key)) continue;
      download.controller.abort();
      this.downloads.delete(id);
    }
    for (const entry of this.sinks.values()) {
      if (matches(entry.key)) void this.stopSink(entry, new Error("attachment_unavailable"));
    }
    if (this.runtime) void this.runtime.then(runtime => this.invoke(runtime, () => this.project(runtime))).catch(() => {});
    void this.store?.removeMessages(roomId, removed).catch(() => {});
    this.changed();
  }
  private withdraw(source: Source, removeStored = source.storage === "retained"): void {
    const key = source.key;
    if (this.sources.get(fileKeyString(key)) !== source) return;
    this.sources.delete(fileKeyString(key));
    void this.command({ type: "file_offer", ...key, sha256: source.attachment.sha256, available: false }).catch(() => {});
    if (removeStored) void this.store?.remove(key, source.attachment).catch(() => {});
  }
  private async retain(key: ChannelFileKey, attachment: ChannelAttachment, file: File, ownsFile: () => boolean): Promise<File | null> {
    const store = this.store, scope = this.scope;
    if (!store || !scope) return null;
    const id = cacheRoom(scope, key.roomId), clear = this.cacheClears.get(id);
    if (clear?.pending) return null;
    const allowed = () => this.store === store && this.cacheClears.get(id) === clear
      && ownsFile()
      && this.rooms.some(room => room.id === key.roomId && room.authorized)
      && !this.messageRemoved(key) && this.matchesPlan({ key, attachment });
    try {
      const limits: FileRetentionLimits = await this.limits();
      if (!allowed()) return null;
      const retained = await store.retain({ key, attachment, file }, limits, allowed);
      if (this.messageRemoved(key)) { await store.remove(key, attachment); return null; }
      if (this.store !== store) return null;
      for (const key of retained.evicted) {
        const source = this.sources.get(fileKeyString(key));
        if (source?.storage === "retained") this.withdraw(source, false);
      }
      return allowed() ? retained.file : null;
    } catch { return null; } // Optional retention cannot fail a confirmed send/download.
  }
  async retained(roomId: string): Promise<RetainedFile[]> {
    const store = this.store, scope = this.scope, lifetime = this.lifetime;
    if (!store || !scope || !this.rooms.some(room => room.id === roomId && room.authorized)) return [];
    const revision = this.cacheRevision;
    const files = await this.listCachedFiles(store, scope, [roomId]);
    if (this.store !== store || this.lifetime !== lifetime || lifetime.signal.aborted
      || !this.rooms.some(room => room.id === roomId && room.authorized)) return [];
    const fresh = (this.cacheClears.get(cacheRoom(scope, roomId))?.revision ?? 0) <= revision;
    const available = new Map((fresh ? files : []).filter(file => file.key.roomId === roomId && !this.messageRemoved(file.key)).map(file => [fileKeyString(file.key), file]));
    for (const { key, attachment, file } of this.sources.values()) {
      if (key.roomId === roomId && !this.cacheClears.get(cacheRoom(scope, roomId))?.pending) available.set(fileKeyString(key), { key, attachment, file });
    }
    return [...available.values()];
  }
  /** Called after authority commit with archive-verified bytes; cache failure keeps live sources. */
  async restoreRetained(roomId: string, files: RetainedFile[]): Promise<boolean> {
    const store = this.store, lifetime = this.lifetime;
    const current = () => this.store === store && this.lifetime === lifetime && !lifetime.signal.aborted
      && this.rooms.some(room => room.id === roomId && room.authorized);
    if (!store || !current() || files.some(file => file.key.roomId !== roomId)) return false;
    let saved = true;
    for (const { key, attachment, file } of files) {
      if (!current()) return false;
      if (this.messageRemoved(key)) { saved = false; continue; }
      const source: Source = { key, attachment, file, status: idle, storage: "original" };
      this.installSource(source);
      const retained = await this.retain(key, attachment, file, () => this.sources.get(fileKeyString(key)) === source);
      if (!current()) return false;
      if (this.sources.get(fileKeyString(key)) !== source) { saved = false; continue; }
      if (retained) { source.file = retained; source.storage = "retained"; }
      else saved = false;
    }
    return saved && files.every(({ key }) => this.sources.get(fileKeyString(key))?.storage === "retained");
  }
  resume(roomId?: string): void {
    for (const source of this.sources.values()) if (!roomId || source.key.roomId === roomId) this.reofferKey(source.key);
    const receiving = new Map<string, ChannelFileKey>();
    for (const plan of this.plans) {
      if (!plan.receiving || (roomId && plan.roomId !== roomId)) continue;
      const key = { roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id };
      receiving.set(fileKeyString(key), key);
    }
    for (const [id, entry] of this.sinks) {
      if (!entry.consumers.size || (roomId && entry.key.roomId !== roomId)) continue;
      if (!receiving.delete(id) && entry.progress && entry.progress.state !== "finishing") this.requestReceive(entry);
    }
    for (const key of receiving.values()) {
      void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {});
    }
  }
  private ownsRoomBinding(roomId: string, bindingId: string | undefined): boolean {
    return this.rooms.some(room => room.id === roomId && room.available && room.authorized && room.delivery?.bindingId === bindingId);
  }
  private requestReceive(entry: PendingSink): void {
    const { key } = entry, id = fileKeyString(key);
    const bindingId = this.rooms.find(room => room.id === key.roomId)?.delivery?.bindingId;
    const request = entry.receive = Symbol();
    const current = () => this.sinks.get(id) === entry && entry.receive === request && this.ownsRoomBinding(key.roomId, bindingId);
    void entry.ready.then(async () => {
      if (!current()) return;
      try { await this.command({ type: "file_receive", ...key, enabled: true }); }
      catch (error) { if (current()) await this.stopSink(entry, errorOf(error)); }
    }, () => {}); // Local storage errors are delivered to the sink's consumers.
  }
  private installSource(source: Source): void {
    const id = fileKeyString(source.key), download = this.downloads.get(id);
    // A confirmed send or restored original supersedes the previous platform save.
    // A retained cache candidate still awaits the writer's verification.
    if (source.storage === "original" && download && !sameContent(download.attachment, source.attachment)) {
      this.downloads.delete(id);
      download.controller.abort();
    }
    this.sources.set(id, source);
    this.reofferKey(source.key);
    this.changed();
  }
  private reofferKey(key: ChannelFileKey) {
    if (this.messageRemoved(key)) return;
    const id = fileKeyString(key), source = this.sources.get(id);
    if (source && !this.matchesPlan(source)) { this.withdraw(source, true); return; }
    const room = this.rooms.find(room => room.id === key.roomId);
    if (!source || !room?.available || !room.authorized) return;
    const bindingId = room.delivery?.bindingId;
    const offer = source.offer = this.command({ type: "file_offer", ...key, sha256: source.attachment.sha256, available: true });
    const current = () => this.sources.get(id) === source && source.offer === offer && this.ownsRoomBinding(key.roomId, bindingId);
    void offer.then(() => {
      if (current()) { source.status = idle; this.changed(); }
    }).catch(error => {
      if (!current()) return;
      if (source.storage === "retained" && errorOf(error).message === "attachment_unavailable") {
        this.sources.delete(id);
        if (this.hasSavedCopy(key, source.attachment)) this.savedReceipts.delete(id);
        void this.store?.remove(key, source.attachment, { forgetReceipt: true }).catch(() => {});
      } else source.status = { busy: false, error: "file_offer_failed" };
      this.changed();
    });
  }

  async describe(files: DraftFile[], signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<PreparedFile[]> {
    const lifetime = this.lifetime;
    const preparation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const module = await this.module(), limits = attachmentLimitsSchema.parse(JSON.parse(module.attachment_limits()));
    preparation.throwIfAborted();
    if (files.length > limits.maxAttachmentsPerMessage || files.some(entry => entry.file.size > limits.maxFileBytes)) throw new Error("invalid_attachments");
    const prepared: PreparedFile[] = [];
    let inlineBytes = 0;
    const totalBytes = files.reduce((total, entry) => total + entry.file.size, 0);
    let hashedBytes = 0, reportedPercent = 0;
    const mediaTypes = await Promise.all(files.map(async entry => module.attachment_media_type(new Uint8Array(await entry.file.slice(0, 12).arrayBuffer()))));
    preparation.throwIfAborted();
    let remainingImages = mediaTypes.filter(type => type.startsWith("image/")).length;
    for (const [index, entry] of files.entries()) {
      let hash: AttachmentHash | null = new module.AttachmentHash();
      try {
        for (let offset = 0; offset < entry.file.size; offset += 65536) {
          preparation.throwIfAborted();
          const bytes = new Uint8Array(await entry.file.slice(offset, offset + 65536).arrayBuffer());
          preparation.throwIfAborted(); hash.update(bytes);
          if (onProgress) {
            hashedBytes += bytes.byteLength;
            // Leave room for image renditions and metadata after the original bytes are hashed.
            const percent = Math.min(99, Math.floor(hashedBytes / totalBytes * 100));
            if (percent !== reportedPercent) {
              reportedPercent = percent;
              onProgress(percent);
            }
          }
        }
        const finished = hash; hash = null;
        const sha256 = finished.finish();
        const mediaType = mediaTypes[index];
        preparation.throwIfAborted();
        let inlineImage: ImageRendition | undefined;
        if (mediaType.startsWith("image/")) {
          const budget = Math.floor((limits.maxInlineImageBytes - inlineBytes) / remainingImages--);
          inlineImage = await prepareInlineImage(entry.file, mediaType, budget, limits.maxInlineImageEdge, preparation);
          preparation.throwIfAborted();
          if (inlineImage) inlineBytes += Math.floor(inlineImage.data.length / 4) * 3 - (inlineImage.data.endsWith("==") ? 2 : inlineImage.data.endsWith("=") ? 1 : 0);
        }
        prepared.push({ ...entry, attachment: attachmentSchema.parse({ id: entry.id, name: entry.file.name, size: entry.file.size, mediaType, sha256 }),
          ...(inlineImage !== undefined ? { inlineImage } : {}) });
      } finally { hash?.free(); }
    }
    return prepared;
  }
  confirmed(roomId: string, message: ChannelMessage, files: PreparedFile[]): void {
    for (const attachment of message.attachments) {
      const selected = files.find(file => file.attachment.id === attachment.id && sameContent(file.attachment, attachment));
      if (!selected) continue;
      const key = { roomId, messageSeq: message.seq, attachmentId: attachment.id };
      const source: Source = { key, attachment, file: selected.file, status: idle, storage: "original" };
      this.installSource(source);
      void this.retain(key, attachment, selected.file, () => this.sources.get(fileKeyString(key)) === source).then(copy => {
        // The page keeps its live offer even if this saved copy is later evicted.
        if (copy && this.sources.get(fileKeyString(key)) === source) {
          source.file = copy;
          source.storage = "session-cache";
        }
      });
    }
  }
  data(peer: string, kind: "control" | "chunk", data: string | Uint8Array): void {
    void this.ensure().then(runtime => this.invoke(runtime, () => kind === "control" ? runtime.delivery.control(peer, data as string, BigInt(Date.now())) : runtime.delivery.chunk(peer, data as Uint8Array))).catch(() => {});
  }
  peerState(peer: string, available: boolean): void {
    for (const plan of this.plans.filter(plan => plan.upstream === peer)) {
      const entry = this.sinks.get(fileKeyString({ roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id }));
      if (entry?.progress && entry.progress.state !== "finishing" && (!available || entry.progress.state === "connecting")) {
        entry.progress = { ...entry.progress, state: available ? "waiting" : "connecting" }; this.changed();
      }
    }
    if (this.runtime) void this.runtime.then(runtime => this.invoke(runtime, () => available ? this.project(runtime) : runtime.delivery.peer_unavailable(peer))).catch(() => {});
  }
  bulkClosed(peer: string): void {
    if (this.runtime) void this.runtime.then(runtime => {
      for (const plan of this.plans) if (plan.upstream === peer || plan.downstream.includes(peer)) {
        const key = { roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id };
        this.invoke(runtime, () => runtime.delivery.peer_closed(JSON.stringify(key), peer, "data_channel_unavailable"));
      }
    }).catch(() => {});
  }
  private matchesRead(key: ChannelFileKey, attachment: ChannelAttachment): boolean {
    if (!this.matchesPlan({ key, attachment })) return false;
    const message = this.confirmedMessage?.(key);
    if (message) return message.attachments.some(file => file.id === key.attachmentId && sameContent(file, attachment));
    const id = fileKeyString(key), local = this.sources.get(id) ?? this.sinks.get(id);
    return !local || sameContent(local.attachment, attachment);
  }
  download(key: ChannelFileKey, attachment: ChannelAttachment, inlineImage?: ImageRendition, surface?: Element): Promise<void> {
    if (!this.matchesRead(key, attachment)) return Promise.reject(new Error("attachment_unavailable"));
    const id = fileKeyString(key), previous = this.downloads.get(id), store = this.store, scope = this.scope;
    const cacheRevision = scope ? this.cacheClears.get(cacheRoom(scope, key.roomId))?.revision : undefined;
    if (previous && sameContent(previous.attachment, attachment) && !previous.controller.signal.aborted
      && (previous.status.busy || isNativeSavePending(previous.status.outcome))) return previous.promise;
    previous?.controller.abort();
    const download: Download = { key, attachment, controller: new AbortController(), promise: Promise.resolve(), status: { busy: true, error: null } };
    this.downloads.set(id, download); this.changed();
    download.promise = this.content(key, attachment, download.controller.signal, inlineImage).then(file => {
      download.controller.signal.throwIfAborted();
      const rememberSaved = store && scope ? (receipt: string) => {
        const clear = this.cacheClears.get(cacheRoom(scope, key.roomId));
        if (this.store !== store || this.downloads.get(id) !== download || download.controller.signal.aborted
          || this.messageRemoved(key) || !this.rooms.some(room => room.id === key.roomId && room.authorized)
          || clear?.pending || clear?.revision !== cacheRevision) return;
        const entry = { key, sha256: attachment.sha256.toLowerCase(), receipt };
        this.savedReceipts.set(id, entry);
        void store.saveReceipt(entry, () => this.savedReceipts.get(id) === entry
          && this.cacheClears.get(cacheRoom(scope, key.roomId)) === clear).catch(() => {});
      } : undefined;
      downloadBlob(file, attachment.name, { document: attachmentDownloadDocument(surface?.ownerDocument), signal: download.controller.signal, rememberSaved, outcome: outcome => {
        if (this.downloads.get(id) !== download) return;
        download.status = { busy: false, error: outcome === "failed" ? "download_failed" : null, outcome,
          saveProgress: outcome === "started" ? download.status.saveProgress : undefined };
        this.changed();
      }, progress: saveProgress => {
        if (this.downloads.get(id) !== download) return;
        download.status = { busy: false, error: null, outcome: "started", saveProgress };
        this.changed();
      } });
    })
      .catch(error => {
        if (this.downloads.get(id) === download && !download.controller.signal.aborted) {
          download.status = { busy: false, error: errorOf(error).message };
          this.changed();
        }
        throw error;
      });
    return download.promise;
  }
  cancelDownload(key: ChannelFileKey): void {
    const download = this.downloads.get(fileKeyString(key));
    if (!download?.status.busy) return;
    download.status = { busy: false, error: null, outcome: "cancelled" };
    download.controller.abort();
    this.changed();
  }
  async content(key: ChannelFileKey, attachment: ChannelAttachment, signal: AbortSignal, inlineImage?: ImageRendition): Promise<File> {
    signal.throwIfAborted();
    if (this.messageRemoved(key)) throw new Error("attachment_unavailable");
    if (this.sessionId && !this.rooms.some(room => room.id === key.roomId && room.authorized)) throw new Error("room_unavailable");
    if (!this.matchesRead(key, attachment)) throw new Error("attachment_unavailable");
    if (inlineImage?.original) return inlineImageFile(inlineImage, attachment.name);
    const id = fileKeyString(key), source = this.sources.get(id);
    if (source && sameContent(source.attachment, attachment)) return source.file;
    // Runtime initialization is shared; cancellation only retires this wait.
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(aborted());
      signal.addEventListener("abort", cancel, { once: true });
    });
    let runtime: Runtime;
    try { runtime = await Promise.race([this.ensure(), cancelled]); }
    finally { signal.removeEventListener("abort", cancel); }
    signal.throwIfAborted();
    if (this.messageRemoved(key)) throw new Error("attachment_unavailable");
    const room = this.rooms.find(room => room.id === key.roomId);
    if (!this.current(runtime) || !room?.authorized) throw new Error("room_unavailable");
    if (!this.matchesRead(key, attachment)) throw new Error("attachment_unavailable");
    if (source && room.available) this.withdraw(source, true);
    let entry = this.sinks.get(id);
    if (entry && !sameContent(entry.attachment, attachment)) {
      void this.stopSink(entry, new Error("attachment_unavailable"));
      entry = undefined;
    }
    if (!entry) {
      if (!room.available) throw new Error("room_unavailable");
      const consumers = new Set<symbol>();
      entry = { key, attachment, consumers, ready: this.createSink(runtime, key, consumers),
        progress: { received: 0, total: attachment.size, state: "waiting" } };
      this.sinks.set(id, entry);
      this.requestReceive(entry);
      const creating = entry;
      void entry.ready.catch(() => { if (this.sinks.get(id) === creating) { this.sinks.delete(id); this.changed(); } });
    }
    const active = entry, consumer = Symbol();
    active.consumers.add(consumer); this.changed();
    return new Promise<File>((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener("abort", cancel); active.consumers.delete(consumer); };
      const cancel = () => {
        cleanup(); reject(aborted());
        if (!active.consumers.size && this.sinks.get(id) === active) {
          this.sinks.delete(id); this.changed(); this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)));
          void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {});
          void this.retireSink(active.ready, aborted());
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      active.ready.then(sink => sink.promise).then(file => { cleanup(); resolve(file); }, error => { cleanup(); reject(error); });
      if (signal.aborted) cancel();
    });
  }
  private async createSink(runtime: Runtime, key: ChannelFileKey, consumers: Set<symbol>): Promise<Sink> {
    const storage = this.transferStorage ??= openTransferStorage();
    const { directory } = await storage.catch(error => {
      if (this.transferStorage === storage) this.transferStorage = undefined;
      return throwStorageError(error, "file_storage_unavailable");
    });
    runtime.lifetime.signal.throwIfAborted();
    const name = crypto.randomUUID(), file = await directory.getFileHandle(name, { create: true }).catch(throwStorageError);
    let writer: FileSystemWritableFileStream;
    try { writer = await file.createWritable(); }
    catch (error) { await directory.removeEntry(name).catch(() => {}); throwStorageError(error); }
    let resolve!: (file: File) => void, reject!: (error: Error) => void;
    const promise = new Promise<File>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const sink: Sink = { lifetime: new AbortController(), directory, name, file, writer, complete: false, tail: Promise.resolve(), promise, resolve, reject };
    if (!this.current(runtime) || !consumers.size || this.sinks.get(fileKeyString(key))?.consumers !== consumers) {
      await this.disposeSink(sink, aborted()); throw aborted();
    }
    try {
      this.invoke(runtime, () => runtime.delivery.start(JSON.stringify(key)));
      return sink;
    } catch (error) {
      if (this.sinks.get(fileKeyString(key))?.consumers === consumers) this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)));
      await this.disposeSink(sink, errorOf(error)); throw error;
    }
  }
  private effects(runtime: Runtime, effects: Effect[]): void {
    const failedResponses = new Set<string>();
    for (const effect of effects) {
      const key = "key" in effect ? effect.key : effect.control.key;
      const request = effect.type === "send_chunk" || effect.type === "cancel_chunks"
        ? JSON.stringify([effect.peer, key.roomId, key.messageSeq, key.attachmentId, effect.offset, effect.requestId]) : undefined;
      if (effect.type === "cancel_chunks") {
        this.cancelChunks?.(effect.peer, request!);
      } else if (effect.type === "send_control" || effect.type === "send_chunk") {
        const peer = effect.peer, isError = effect.type === "send_control" && effect.control.type === "error";
        const terminal = isError || (effect.type === "send_control" && effect.control.type === "cancel");
        const kind = effect.type === "send_control" ? "control" : "chunk";
        const data = effect.type === "send_control" ? JSON.stringify(effect.control) : effect.frame;
        const allowed = () => this.current(runtime) && (request === undefined || !failedResponses.has(request))
          && this.rooms.some(room => room.id === key.roomId && room.authorized && room.available)
          && this.roomPeers.some(([id, rooms]) => id === peer && rooms.includes(key.roomId))
          && (terminal || !this.messageRemoved(key) && this.plans.some(plan => plan.roomId === key.roomId && plan.messageSeq === key.messageSeq
            && plan.attachment.id === key.attachmentId && (plan.upstream === peer || plan.downstream.includes(peer))));
        void this.sendData(peer, kind, data, allowed, request)
          .catch(error => {
            if (terminal || !this.current(runtime)) return;
            if (request !== undefined) {
              if (failedResponses.has(request)) return;
              failedResponses.add(request);
              this.cancelChunks?.(peer, request);
            }
            const code = errorOf(error).message;
            this.invoke(runtime, () => runtime.delivery.peer_failed(JSON.stringify(key), peer,
              effect.type === "send_control" ? effect.control.requestId : effect.requestId, code === "data_channel_busy" ? "file_transfer_busy" : code));
          });
      } else if (effect.type === "read") {
        const id = fileKeyString(key), source = this.sources.get(id);
        const failed = () => {
          if (!this.current(runtime)) return;
          const effects = runtime.delivery.request_failed(JSON.stringify(key), effect.requestId, "file_source_unavailable") as Effect[];
          if (effects.length && source) this.withdraw(source);
          this.effects(runtime, effects);
        };
        if (!source) { failed(); continue; }
        const original = source.file;
        const read = (file: File) => file.slice(effect.offset, effect.offset + effect.length).arrayBuffer();
        const deliver = (bytes: ArrayBuffer) => this.invoke(runtime, () =>
          runtime.delivery.read_result(JSON.stringify(key), BigInt(effect.offset), effect.requestId, new Uint8Array(bytes)));
        void read(original).then(deliver, () => {
          // Retention can adopt a readable copy while the selected file's read is pending.
          if (this.current(runtime) && this.sources.get(id) === source && source.file !== original) {
            return read(source.file).then(deliver, failed);
          }
          failed();
        });
      } else {
        const entry = this.sinks.get(fileKeyString(key));
        if (!entry) continue;
        const sinkFailed = (error: unknown) => { if (this.sinks.get(fileKeyString(key)) === entry) void this.stopSink(entry, errorOf(error)); };
        void entry.ready.then(sink => {
          if (effect.type === "failed") { if (!sink.complete) return this.stopSink(entry, new Error(effect.code)); return; }
          sink.tail = sink.tail.then(async () => {
            if (this.sinks.get(fileKeyString(key)) !== entry || !entry.progress) return;
            sink.lifetime.signal.throwIfAborted();
            if (effect.type === "write") {
              const bytes = effect.bytes;
              await sink.writer.write({ type: "write", position: effect.offset, data: bytes }).catch(throwStorageError);
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(fileKeyString(key)) !== entry) return;
              // Progress counts completed sink writes, never requested or queued bytes.
              const progress = entry.progress;
              entry.progress = { ...progress, received: effect.offset + bytes.length,
                state: progress.state === "waiting" ? "receiving" : progress.state };
              this.changed();
              this.invoke(runtime, () => runtime.delivery.written(JSON.stringify(key), BigInt(effect.offset), bytes.length));
            } else {
              // Complete is emitted only after shared Rust verifies the digest and written ranges.
              entry.progress = { ...entry.progress, state: "finishing" }; this.changed();
              await sink.writer.close().catch(throwStorageError); sink.lifetime.signal.throwIfAborted();
              const file = await sink.file.getFile();
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(fileKeyString(key)) !== entry) return;
              if (file.size !== entry.attachment.size) throw new Error("file_size_mismatch");
              sink.complete = true;
              const retained = await this.retain(key, entry.attachment, file,
                () => this.sinks.get(fileKeyString(key)) === entry);
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(fileKeyString(key)) !== entry || this.messageRemoved(key)) return;
              const readable = retained ?? file;
              entry.progress = null;
              this.installSource({ key, attachment: entry.attachment, file: readable, status: idle, storage: retained ? "retained" : "session-cache" });
              void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {}); sink.resolve(readable);
              if (retained) {
                try {
                  await sink.directory.removeEntry(sink.name);
                  if (this.sinks.get(fileKeyString(key)) === entry) { this.sinks.delete(fileKeyString(key)); this.changed(); }
                }
                catch { /* The existing temporary owner retries cleanup on reset. */ }
              }
            }
          }).catch(sinkFailed);
        }).catch(sinkFailed);
      }
    }
  }
  private async stopSink(entry: PendingSink, error: Error): Promise<void> {
    const { key } = entry;
    if (this.sinks.get(fileKeyString(key)) !== entry) return;
    this.sinks.delete(fileKeyString(key)); this.changed();
    if (this.runtime) void this.runtime.then(runtime => this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)))).catch(() => {});
    void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {});
    await this.retireSink(entry.ready, error);
  }
  private retireSink(ready: Promise<Sink>, error: Error): Promise<void> {
    const disposals = this.sinkDisposals;
    const disposal = ready.then(sink => this.disposeSink(sink, error)).catch(() => {});
    disposals.add(disposal);
    void disposal.then(() => disposals.delete(disposal));
    return disposal;
  }
  private async disposeSink(sink: Sink, error: Error): Promise<void> {
    sink.lifetime.abort(); sink.reject(error);
    try { await sink.writer.abort(); } catch { /* A completed writer is already closed. */ }
    await sink.tail;
    try { await sink.directory.removeEntry(sink.name); } catch { /* A failed creation may have no entry. */ }
  }
  reset(): void {
    clearTimeout(this.expiry); this.expiry = undefined;
    this.lifetime.abort();
    if (this.runtime) void this.runtime.then(runtime => runtime.delivery.free()).catch(() => {});
    const downloads = [...this.downloads.values()], sinks = [...this.sinks.values()];
    this.availability.disconnect();
    this.savedReceipts.clear(); this.sources.clear(); this.sinks.clear(); this.downloads.clear(); this.runtime = null; this.plans = []; this.rooms = []; this.roomPeers = []; this.sessionId = null; this.scope = null; this.store = null;
    // Abort handlers run synchronously and must not send cancellation for the retired session.
    for (const download of downloads) download.controller.abort();
    for (const entry of sinks) void this.retireSink(entry.ready, aborted());
    const storage = this.transferStorage, disposals = this.sinkDisposals;
    this.transferStorage = undefined;
    this.sinkDisposals = new Set();
    if (storage) void storage.then(async lease => {
      await Promise.all(disposals);
      await lease.close();
    }).catch(() => {});
    this.lifetime = new AbortController(); this.changed();
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
}
