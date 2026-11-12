import { z } from "zod";
import { downloadBlob } from "../lib/download";
import { FileStore, type FileScope, type FileRetentionLimits, type RetainedFile } from "./file-store";
import { loadRoomHosting, type AttachmentHash, type FileDelivery } from "./hosting";
import { attachmentSchema, type ChannelAttachment, type ChannelCommand, type ChannelFileKey, type ChannelFilePlan, type ChannelMessage, type ChannelRoom, type ChannelPair, type ImageRendition } from "./protocol";
import { inlineImageFile, prepareInlineImage } from "./image-preview";

export const attachmentLimitsSchema = z.object({ maxFileBytes: z.number().positive(), maxAttachmentsPerMessage: z.number().positive(), maxRetainedBytes: z.number().positive(), maxRetainedFiles: z.number().positive(), maxInlineImageBytes: z.number().int().positive() });
export type AttachmentLimits = z.infer<typeof attachmentLimitsSchema>;
export interface DraftFile { id: string; file: File }
export interface PreparedFile extends DraftFile { attachment: ChannelAttachment; inlineImage?: ImageRendition }
type Hosting = Awaited<ReturnType<typeof loadRoomHosting>>;
type Effect =
  | { type: "send_control"; peer: string; control: { type: string; key: ChannelFileKey; requestId: string } }
  | { type: "send_chunk"; peer: string; key: ChannelFileKey; requestId: string; frame: number[] }
  | { type: "read"; key: ChannelFileKey; requestId: string; offset: number; length: number }
  | { type: "write"; key: ChannelFileKey; offset: number; bytes: number[] }
  | { type: "complete"; key: ChannelFileKey }
  | { type: "failed"; key: ChannelFileKey; code: string };
interface Runtime { module: Hosting; delivery: FileDelivery; lifetime: AbortController }
interface Sink {
  key: ChannelFileKey; attachment: ChannelAttachment; lifetime: AbortController;
  file: FileSystemFileHandle; directory: FileSystemDirectoryHandle; name: string;
  writer: FileSystemWritableFileStream; complete: boolean;
  tail: Promise<void>; promise: Promise<File>; resolve(file: File): void; reject(error: Error): void;
}
interface PendingSink { ready: Promise<Sink>; consumers: Set<symbol> }
interface Download { controller: AbortController; promise: Promise<void>; status: { busy: boolean; error: string | null } }
interface Source { key: ChannelFileKey; attachment: ChannelAttachment; file: File; status: typeof idle; retained: boolean }
const idle: { busy: boolean; error: string | null } = { busy: false, error: null };
const keyOf = (key: ChannelFileKey) => JSON.stringify([key.roomId, key.messageSeq, key.attachmentId]);
const sameContent = (a: ChannelAttachment, b: ChannelAttachment) => a.size === b.size && a.sha256.toLowerCase() === b.sha256.toLowerCase();
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error));
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
  private sources = new Map<string, Source>();
  private scope: FileScope | null = null;
  private store: FileStore | null = null;
  private sinks = new Map<string, PendingSink>();
  private downloads = new Map<string, Download>();
  private listeners = new Set<() => void>();
  constructor(private command: (command: ChannelCommand) => Promise<void>,
    private sendData: (peer: string, kind: "control" | "chunk", data: string | Uint8Array, allowed: () => boolean) => Promise<void>) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  status = (key: ChannelFileKey) => {
    const download = this.downloads.get(keyOf(key))?.status, source = this.sources.get(keyOf(key))?.status;
    return download?.busy ? download : source?.error ? source : download ?? idle;
  };
  private changed() { for (const listener of this.listeners) listener(); }
  private async module(): Promise<Hosting> { const module = await loadRoomHosting(); await module.initializeRuntime(); return module; }
  limits = async (signal?: AbortSignal): Promise<AttachmentLimits> => {
    const module = await this.module(); signal?.throwIfAborted();
    return attachmentLimitsSchema.parse(JSON.parse(module.attachment_limits()));
  };
  private ensure(): Promise<Runtime> {
    if (!this.sessionId) return Promise.reject(new Error("disconnected"));
    const lifetime = this.lifetime, session = this.sessionId;
    return this.runtime ??= this.module().then(module => {
      lifetime.signal.throwIfAborted();
      const runtime = { module, delivery: new module.FileDelivery(session), lifetime };
      this.invoke(runtime, () => this.project(runtime));
      return runtime;
    });
  }
  private current(runtime: Runtime): boolean { return this.lifetime === runtime.lifetime && !runtime.lifetime.signal.aborted; }
  private project(runtime: Runtime): string { return runtime.delivery.update(JSON.stringify(this.plans), JSON.stringify(this.roomPeers), BigInt(Date.now())); }
  private invoke(runtime: Runtime, work: () => string): void {
    if (!this.current(runtime)) return;
    this.effects(runtime, JSON.parse(work()) as Effect[]);
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
    this.rooms = rooms; this.plans = plans;
    this.roomPeers = pairs.map(pair => [pair.peerId, pair.rooms]);
    for (const [id, source] of this.sources) {
      if (!rooms.some(room => room.id === source.key.roomId && room.authorized)) this.sources.delete(id);
      else if (!this.matchesPlan(source)) this.withdraw(source, true);
    }
    if (opening || rooms.some(room => room.authorized && !previous.some(old => old.id === room.id && old.authorized))) {
      void store.list().then(files => {
        if (this.store !== store) return;
        for (const { key, attachment, file } of files) if (this.rooms.some(room => room.id === key.roomId && room.authorized) && !this.sources.has(keyOf(key))) {
          this.sources.set(keyOf(key), { key, attachment, file, status: idle, retained: true }); this.reofferKey(key);
        }
      }).catch(() => {});
    }
    if (plans.length || this.runtime) void this.ensure().then(runtime => this.invoke(runtime, () => this.project(runtime))).catch(() => {});
    for (const room of rooms) if (room.available && previous.some(old => old.id === room.id && !old.available)) this.resume(room.id);
  }
  private matchesPlan(source: Pick<Source, "key" | "attachment">): boolean {
    const plan = this.plans.find(plan => keyOf({ roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id }) === keyOf(source.key));
    return !plan || sameContent(source.attachment, plan.attachment);
  }
  private withdraw(source: Source, removeStored = source.retained): void {
    const key = source.key;
    if (this.sources.get(keyOf(key)) !== source) return;
    this.sources.delete(keyOf(key));
    void this.command({ type: "file_offer", ...key, sha256: source.attachment.sha256, available: false }).catch(() => {});
    if (removeStored) void this.store?.remove(key).catch(() => {});
  }
  private async retain(key: ChannelFileKey, attachment: ChannelAttachment, file: File): Promise<File | null> {
    const store = this.store;
    if (!store) return null;
    try {
      const limits: FileRetentionLimits = await this.limits();
      if (this.store !== store || !this.matchesPlan({ key, attachment })) return null;
      const retained = await store.retain({ key, attachment, file }, limits);
      if (this.store !== store) return null;
      for (const key of retained.evicted) {
        const source = this.sources.get(keyOf(key));
        if (source?.retained) this.withdraw(source, false);
      }
      return retained.file;
    } catch { return null; } // Optional retention cannot fail a confirmed send/download.
  }
  async retained(roomId: string): Promise<RetainedFile[]> {
    const store = this.store, lifetime = this.lifetime;
    if (!store || !this.rooms.some(room => room.id === roomId && room.authorized)) return [];
    const files = await store.list();
    if (this.store !== store || this.lifetime !== lifetime || lifetime.signal.aborted
      || !this.rooms.some(room => room.id === roomId && room.authorized)) return [];
    const available = new Map(files.filter(file => file.key.roomId === roomId).map(file => [keyOf(file.key), file]));
    for (const { key, attachment, file } of this.sources.values()) {
      if (key.roomId === roomId) available.set(keyOf(key), { key, attachment, file });
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
      const source: Source = { key, attachment, file, status: idle, retained: false };
      this.sources.set(keyOf(key), source); this.reofferKey(key);
      const retained = await this.retain(key, attachment, file);
      if (!current()) return false;
      if (this.sources.get(keyOf(key)) !== source) { saved = false; continue; }
      if (retained) { source.file = retained; source.retained = true; }
      else saved = false;
    }
    return saved;
  }
  resume(roomId?: string): void {
    for (const source of this.sources.values()) if (!roomId || source.key.roomId === roomId) this.reofferKey(source.key);
    for (const plan of this.plans) {
      if (roomId && plan.roomId !== roomId) continue;
      const key = { roomId: plan.roomId, messageSeq: plan.messageSeq, attachmentId: plan.attachment.id };
      const entry = this.sinks.get(keyOf(key));
      const enabled = Boolean(entry?.consumers.size);
      if (enabled !== plan.receiving) void this.command({ type: "file_receive", ...key, enabled }).catch(error => {
        if (entry && this.sinks.get(keyOf(key)) === entry) void entry.ready.then(sink => this.stopSink(key, entry, sink, errorOf(error))).catch(() => {});
      });
    }
  }
  private reofferKey(key: ChannelFileKey) {
    const source = this.sources.get(keyOf(key));
    if (source && !this.matchesPlan(source)) { this.withdraw(source, true); return; }
    if (source && this.rooms.some(room => room.id === key.roomId && room.available && room.authorized)) {
      void this.command({ type: "file_offer", ...key, sha256: source.attachment.sha256, available: true }).then(() => {
        if (this.sources.get(keyOf(key)) === source) { source.status = idle; this.changed(); }
      }).catch(() => { if (this.sources.get(keyOf(key)) === source) { source.status = { busy: false, error: "file_offer_failed" }; this.changed(); } });
    }
  }

  async describe(files: DraftFile[], signal?: AbortSignal): Promise<PreparedFile[]> {
    const lifetime = this.lifetime;
    const module = await this.module(), limits = attachmentLimitsSchema.parse(JSON.parse(module.attachment_limits()));
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (files.length > limits.maxAttachmentsPerMessage || files.some(entry => entry.file.size > limits.maxFileBytes)) throw new Error("invalid_attachments");
    const prepared: PreparedFile[] = [];
    let inlineBytes = 0;
    const mediaTypes = await Promise.all(files.map(async entry => module.attachment_media_type(new Uint8Array(await entry.file.slice(0, 12).arrayBuffer()))));
    let remainingImages = mediaTypes.filter(type => type.startsWith("image/")).length;
    for (const [index, entry] of files.entries()) {
      let hash: AttachmentHash | null = new module.AttachmentHash();
      try {
        for (let offset = 0; offset < entry.file.size; offset += 65536) {
          signal?.throwIfAborted();
          lifetime.signal.throwIfAborted();
          const bytes = new Uint8Array(await entry.file.slice(offset, offset + 65536).arrayBuffer());
          signal?.throwIfAborted(); lifetime.signal.throwIfAborted(); hash.update(bytes);
        }
        const finished = hash; hash = null;
        const sha256 = finished.finish();
        const mediaType = mediaTypes[index];
        signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
        let inlineImage: ImageRendition | undefined;
        if (mediaType.startsWith("image/")) {
          const budget = Math.floor((limits.maxInlineImageBytes - inlineBytes) / remainingImages--);
          inlineImage = await prepareInlineImage(entry.file, mediaType, budget, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
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
      const source: Source = { key, attachment, file: selected.file, status: idle, retained: false };
      this.sources.set(keyOf(key), source); this.reofferKey(key);
      void this.retain(key, attachment, selected.file).then(copy => {
        // The page keeps its live offer even if this saved copy is later evicted.
        if (copy && this.sources.get(keyOf(key)) === source) source.file = copy;
      });
    }
  }
  data(peer: string, kind: "control" | "chunk", data: string | Uint8Array): void {
    void this.ensure().then(runtime => this.invoke(runtime, () => kind === "control" ? runtime.delivery.control(peer, data as string, BigInt(Date.now())) : runtime.delivery.chunk(peer, data as Uint8Array))).catch(() => {});
  }
  peerState(peer: string, available: boolean): void {
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
  download(key: ChannelFileKey, attachment: ChannelAttachment, inlineImage?: ImageRendition): Promise<void> {
    const id = keyOf(key), previous = this.downloads.get(id);
    if (previous?.status.busy) return previous.promise;
    const download: Download = { controller: new AbortController(), promise: Promise.resolve(), status: { busy: true, error: null } };
    this.downloads.set(id, download); this.changed();
    download.promise = this.content(key, attachment, download.controller.signal, inlineImage).then(file => { download.controller.signal.throwIfAborted(); downloadBlob(file, attachment.name); })
      .catch(error => { if (this.downloads.get(id) === download) download.status = { busy: false, error: download.controller.signal.aborted ? null : errorOf(error).message }; throw error; })
      .finally(() => { if (this.downloads.get(id) === download) { download.status = { ...download.status, busy: false }; this.changed(); } });
    return download.promise;
  }
  cancelDownload(key: ChannelFileKey): void { this.downloads.get(keyOf(key))?.controller.abort(); }
  async content(key: ChannelFileKey, attachment: ChannelAttachment, signal: AbortSignal, inlineImage?: ImageRendition): Promise<File> {
    signal.throwIfAborted();
    if (inlineImage?.original) return inlineImageFile(inlineImage, attachment.name);
    const source = this.sources.get(keyOf(key));
    if (source) {
      if (!sameContent(source.attachment, attachment)) { this.withdraw(source, true); throw new Error("attachment_unavailable"); }
      return source.file;
    }
    const id = keyOf(key), runtime = await this.ensure();
    signal.throwIfAborted();
    let entry = this.sinks.get(id);
    if (!entry) {
      const consumers = new Set<symbol>();
      entry = { consumers, ready: this.createSink(runtime, key, attachment, consumers) };
      this.sinks.set(id, entry);
      const creating = entry;
      void entry.ready.catch(() => { if (this.sinks.get(id) === creating) this.sinks.delete(id); });
    }
    const active = entry, consumer = Symbol();
    active.consumers.add(consumer);
    return new Promise<File>((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener("abort", cancel); active.consumers.delete(consumer); };
      const cancel = () => {
        cleanup(); reject(aborted());
        if (!active.consumers.size && this.sinks.get(id) === active) {
          this.sinks.delete(id); this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)));
          void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {});
          void active.ready.then(sink => this.disposeSink(sink, aborted())).catch(() => {});
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      active.ready.then(sink => sink.promise).then(file => { cleanup(); resolve(file); }, error => { cleanup(); reject(error); });
      if (signal.aborted) cancel();
    });
  }
  private async createSink(runtime: Runtime, key: ChannelFileKey, attachment: ChannelAttachment, consumers: Set<symbol>): Promise<Sink> {
    if (!navigator.storage?.getDirectory) throw new Error("file_storage_unavailable");
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("piik-channel-transfers", { create: true });
    const name = crypto.randomUUID(), file = await directory.getFileHandle(name, { create: true });
    let writer: FileSystemWritableFileStream;
    try { writer = await file.createWritable(); }
    catch (error) { await directory.removeEntry(name).catch(() => {}); throw error; }
    let resolve!: (file: File) => void, reject!: (error: Error) => void;
    const promise = new Promise<File>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const sink: Sink = { key, attachment, lifetime: new AbortController(), directory, name, file, writer, complete: false, tail: Promise.resolve(), promise, resolve, reject };
    if (!this.current(runtime) || !consumers.size) { await this.disposeSink(sink, aborted()); throw aborted(); }
    try {
      this.invoke(runtime, () => runtime.delivery.start(JSON.stringify(key)));
      await this.command({ type: "file_receive", ...key, enabled: true });
      return sink;
    } catch (error) {
      if (this.sinks.get(keyOf(key))?.consumers === consumers) this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)));
      await this.disposeSink(sink, errorOf(error)); throw error;
    }
  }
  private effects(runtime: Runtime, effects: Effect[]): void {
    for (const effect of effects) {
      const key = "key" in effect ? effect.key : effect.control.key;
      if (effect.type === "send_control" || effect.type === "send_chunk") {
        const peer = effect.peer, isError = effect.type === "send_control" && effect.control.type === "error";
        const terminal = isError || (effect.type === "send_control" && effect.control.type === "cancel");
        const kind = effect.type === "send_control" ? "control" : "chunk";
        const data = effect.type === "send_control" ? JSON.stringify(effect.control) : new Uint8Array(effect.frame);
        const allowed = () => this.current(runtime)
          && this.rooms.some(room => room.id === key.roomId && room.authorized && room.available)
          && (terminal || this.plans.some(plan => plan.roomId === key.roomId && plan.messageSeq === key.messageSeq
            && plan.attachment.id === key.attachmentId && (plan.upstream === peer || plan.downstream.includes(peer))));
        void this.sendData(peer, kind, data, allowed)
          .catch(error => {
            if (terminal) return;
            this.invoke(runtime, () => runtime.delivery.peer_failed(JSON.stringify(key), peer,
              effect.type === "send_control" ? effect.control.requestId : effect.requestId, errorOf(error).message));
          });
      } else if (effect.type === "read") {
        const source = this.sources.get(keyOf(key));
        const failed = (error: unknown) => {
          if (!this.current(runtime)) return;
          const effects = JSON.parse(runtime.delivery.request_failed(JSON.stringify(key), effect.requestId, errorOf(error).message)) as Effect[];
          if (effects.length && source) this.withdraw(source);
          this.effects(runtime, effects);
        };
        if (!source) { failed(new Error("file_unavailable")); continue; }
        void source.file.slice(effect.offset, effect.offset + effect.length).arrayBuffer().then(bytes => this.invoke(runtime, () => runtime.delivery.read_result(JSON.stringify(key), BigInt(effect.offset), effect.requestId, new Uint8Array(bytes)))).catch(failed);
      } else {
        const entry = this.sinks.get(keyOf(key));
        if (!entry) continue;
        const sinkFailed = (error: unknown) => { if (this.sinks.get(keyOf(key)) === entry) void entry.ready.then(sink => this.stopSink(key, entry, sink, errorOf(error))).catch(() => {}); };
        void entry.ready.then(sink => {
          if (effect.type === "failed") { if (!sink.complete) return this.stopSink(key, entry, sink, new Error(effect.code)); return; }
          sink.tail = sink.tail.then(async () => {
            if (this.sinks.get(keyOf(key)) !== entry) return;
            sink.lifetime.signal.throwIfAborted();
            if (effect.type === "write") {
              const bytes = new Uint8Array(effect.bytes);
              await sink.writer.write({ type: "write", position: effect.offset, data: bytes });
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(keyOf(key)) !== entry) return;
              this.invoke(runtime, () => runtime.delivery.written(JSON.stringify(key), BigInt(effect.offset), bytes.length));
            } else {
              // Complete is emitted only after shared Rust verifies the digest and written ranges.
              await sink.writer.close(); sink.lifetime.signal.throwIfAborted();
              const file = await sink.file.getFile();
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(keyOf(key)) !== entry) return;
              if (file.size !== sink.attachment.size) throw new Error("file_size_mismatch");
              sink.complete = true;
              const retained = await this.retain(key, sink.attachment, file);
              sink.lifetime.signal.throwIfAborted();
              if (!this.current(runtime) || this.sinks.get(keyOf(key)) !== entry) return;
              const readable = retained ?? file;
              this.sources.set(keyOf(key), { key, attachment: sink.attachment, file: readable, status: idle, retained: Boolean(retained) }); this.reofferKey(key);
              void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {}); sink.resolve(readable);
              if (retained) {
                try {
                  await sink.directory.removeEntry(sink.name);
                  if (this.sinks.get(keyOf(key)) === entry) this.sinks.delete(keyOf(key));
                }
                catch { /* The existing temporary owner retries cleanup on reset. */ }
              }
            }
          }).catch(sinkFailed);
        }).catch(sinkFailed);
      }
    }
  }
  private async stopSink(key: ChannelFileKey, entry: PendingSink, sink: Sink, error: Error): Promise<void> {
    if (this.sinks.get(keyOf(key)) !== entry) return;
    this.sinks.delete(keyOf(key));
    if (this.runtime) void this.runtime.then(runtime => this.invoke(runtime, () => runtime.delivery.cancel(JSON.stringify(key)))).catch(() => {});
    void this.command({ type: "file_receive", ...key, enabled: false }).catch(() => {});
    await this.disposeSink(sink, error);
  }
  private async disposeSink(sink: Sink, error: Error): Promise<void> {
    sink.lifetime.abort(); sink.reject(error);
    try { await sink.writer.abort(); } catch { /* A completed writer is already closed. */ }
    try { await sink.directory.removeEntry(sink.name); } catch { /* A failed creation may have no entry. */ }
  }
  reset(): void {
    clearTimeout(this.expiry); this.expiry = undefined;
    this.lifetime.abort();
    if (this.runtime) void this.runtime.then(runtime => runtime.delivery.free()).catch(() => {});
    for (const download of this.downloads.values()) download.controller.abort();
    for (const entry of this.sinks.values()) void entry.ready.then(sink => this.disposeSink(sink, aborted())).catch(() => {});
    this.sources.clear(); this.sinks.clear(); this.downloads.clear(); this.runtime = null; this.plans = []; this.rooms = []; this.roomPeers = []; this.sessionId = null; this.scope = null; this.store = null;
    this.lifetime = new AbortController(); this.changed();
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
}
