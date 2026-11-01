import { loadRoomHosting, type AttachmentHash } from "./hosting";
import type { ChannelAttachment, ChannelMessage, MessageReactions } from "./protocol";
import type { FileEntry } from "@zip.js/zip.js";

export type BackupHistoryRow = ChannelMessage & { nonce: string; reactions: MessageReactions };
export interface RetainedBackupFile { messageSeq: number; attachment: ChannelAttachment }
export type BackupMetadata =
  | { kind: "domain"; version: 1; state: Record<string, unknown>; ownerKey: string; inviteKey: string }
  | { kind: "room"; version: 1; domainId: string; policy: Record<string, unknown> & { id: string; creatorId: string };
      ownCredential?: { userId: string; credential: string }; retainedFiles: RetainedBackupFile[] };
export interface BackupVisitor {
  metadata(value: BackupMetadata): void | Promise<void>;
  row(value: BackupHistoryRow): void | Promise<void>;
  content(digest: string, file: File): void | Promise<void>;
}

type Runtime = Awaited<ReturnType<typeof loadRoomHosting>>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const manifest = "manifest.json", history = "history.ndjson";
const zipOptions = { useWebWorkers: false, compressionMethod: 0, level: 0 } as const;

async function runtime(): Promise<Runtime> {
  const module = await loadRoomHosting();
  await module.initializeFiles();
  return module;
}

function inventory(metadata: BackupMetadata): Map<string, RetainedBackupFile> {
  return new Map(metadata.kind === "room"
    ? metadata.retainedFiles.map(file => [file.attachment.sha256.toLowerCase(), file]) : []);
}

/** Only the Core-validated manifest and complete rows/files reach the caller's staging owner. */
export async function readBackup(blob: Blob, visitor: BackupVisitor): Promise<BackupMetadata> {
  const [module, zip] = await Promise.all([runtime(), import("@zip.js/zip.js/lib/zip-core-native.js")]);
  const reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false });
  try {
    const limit = module.backup_record_bytes();
    const limits = JSON.parse(module.attachment_limits()) as { maxRetainedFiles: number };
    const entries = new Map<string, FileEntry>();
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.directory || entry.encrypted || entry.compressionMethod !== 0) throw new Error("unsupported_backup_entry");
      if (entries.has(entry.filename) || entries.size >= limits.maxRetainedFiles + 2) throw new Error("invalid_backup_entries");
      entries.set(entry.filename, entry);
    }
    const entry = entries.get(manifest);
    if (!entry) throw new Error("invalid_backup_entries");
    const metadata = JSON.parse(module.backup_metadata(await readRecord(entry, limit))) as BackupMetadata;
    const files = inventory(metadata);
    const expected = new Set([manifest, ...(metadata.kind === "room" ? [history] : []), ...Array.from(files.keys(), hash => `content/${hash}`)]);
    if (entries.size !== expected.size || Array.from(entries.keys()).some(name => !expected.has(name))) throw new Error("invalid_backup_entries");
    await visitor.metadata(metadata);
    if (metadata.kind === "room") {
      const importer = new module.BackupHistoryImport(JSON.stringify(metadata));
      try {
        await readHistory(entries.get(history)!, limit, line => visitor.row(JSON.parse(importer.accept(line)) as BackupHistoryRow));
        importer.finish();
      } finally { importer.free(); }
      for (const [hash, retained] of files) {
        const descriptor = retained.attachment;
        const content = entries.get(`content/${hash}`)!;
        if (content.uncompressedSize !== descriptor.size) throw new Error("backup_content_mismatch");
        const output = new zip.BlobWriter(descriptor.mediaType);
        const check = verifiedContent(module, descriptor);
        try {
          await Promise.all([content.getData(check.stream.writable, { useWebWorkers: false, checkSignature: true }),
            check.stream.readable.pipeTo(output.writable)]);
          await visitor.content(hash, new File([await output.getData()], descriptor.name, { type: descriptor.mediaType }));
        } finally { check.free(); }
      }
    }
    return metadata;
  } finally { await reader.close(); }
}

async function readRecord(entry: FileEntry, limit: number): Promise<string> {
  if (entry.uncompressedSize > limit) throw new Error("backup_record_too_large");
  const bytes = new Uint8Array(limit);
  let size = 0;
  await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
    if (size + chunk.length > limit) throw new Error("backup_record_too_large");
    bytes.set(chunk, size); size += chunk.length;
  } }), { useWebWorkers: false, checkSignature: true });
  return decoder.decode(bytes.subarray(0, size));
}

async function readHistory(entry: FileEntry, limit: number, accept: (line: string) => void | Promise<void>): Promise<void> {
  const bytes = new Uint8Array(limit + 2);
  let size = 0;
  const row = async () => {
    const length = size > 0 && bytes[size - 1] === 13 ? size - 1 : size;
    if (length > limit) throw new Error("backup_record_too_large");
    await accept(decoder.decode(bytes.subarray(0, length))); size = 0;
  };
  await entry.getData(new WritableStream<Uint8Array>({ async write(chunk) {
    let start = 0;
    for (let index = 0; index <= chunk.length; index++) {
      if (index !== chunk.length && chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index);
      if (size + part.length > bytes.length) throw new Error("backup_record_too_large");
      bytes.set(part, size); size += part.length;
      if (index !== chunk.length) await row();
      start = index + 1;
    }
  }, async close() { if (size) await row(); } }), { useWebWorkers: false, checkSignature: true });
}

function verifiedContent(module: Runtime, descriptor: ChannelAttachment) {
  let hash: AttachmentHash | null = new module.AttachmentHash();
  let size = 0;
  return {
    stream: new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        size += bytes.length;
        if (size > descriptor.size) throw new Error("backup_content_mismatch");
        hash!.update(bytes); controller.enqueue(bytes);
      },
      flush() {
        const finished = hash!; hash = null;
        if (finished.finish().toLowerCase() !== descriptor.sha256.toLowerCase() || size !== descriptor.size) throw new Error("backup_content_mismatch");
      },
    }),
    free() { hash?.free(); hash = null; },
  };
}

/** The caller supplies a stable snapshot; no live storage or file authority is changed here. */
export async function writeBackup(metadata: BackupMetadata, rows?: AsyncIterable<BackupHistoryRow>, open?: (file: RetainedBackupFile) => Promise<Blob>): Promise<Blob> {
  const [module, zip] = await Promise.all([runtime(), import("@zip.js/zip.js/lib/zip-core-native.js")]);
  const canonical = module.backup_metadata(JSON.stringify(metadata));
  metadata = JSON.parse(canonical) as BackupMetadata;
  const limit = module.backup_record_bytes();
  const manifestBytes = encoder.encode(canonical);
  if (manifestBytes.length > limit) throw new Error("backup_record_too_large");
  const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), zipOptions);
  try {
    await writer.add(manifest, new zip.Uint8ArrayReader(manifestBytes));
    if (metadata.kind === "room") {
      if (!rows) throw new Error("invalid_backup_history");
      const importer = new module.BackupHistoryImport(canonical);
      const iterator = rows[Symbol.asyncIterator]();
      try {
        await writer.add(history, new ReadableStream<Uint8Array>({ async pull(controller) {
          const next = await iterator.next();
          if (next.done) { importer.finish(); controller.close(); }
          else {
            const bytes = encoder.encode(`${importer.accept(JSON.stringify(next.value))}\n`);
            if (bytes.length > limit + 1) throw new Error("backup_record_too_large");
            controller.enqueue(bytes);
          }
        }, async cancel() { await iterator.return?.(); } }));
      } finally { importer.free(); await iterator.return?.(); }
      for (const [hash, retained] of inventory(metadata)) {
        if (!open) throw new Error("backup_content_mismatch");
        const blob = await open(retained);
        if (blob.size !== retained.attachment.size) throw new Error("backup_content_mismatch");
        const check = verifiedContent(module, retained.attachment);
        try { await writer.add(`content/${hash}`, blob.stream().pipeThrough(check.stream)); }
        finally { check.free(); }
      }
    }
    return await writer.close();
  } catch (error) { await writer.close().catch(() => {}); throw error; }
}
