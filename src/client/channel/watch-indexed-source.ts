import {mediaFragmentBytes} from "../../shared/media-resource";
import { createFile, DataStream, FullBox, MP4BoxBuffer, type ISOFile, type Movie } from "mp4box";
import { NATIVE_PAGE_METADATA_PREFIX_BYTES, NATIVE_PAGE_READ_BYTES, nativePageIndexedTrackRecipeSchema,
  nativePageIndexedSelectionSchema, type NativePageIndexedCandidate, type NativePageIndexedTrackRecipe,
  type NativePageIndexedSelection } from "../native/wire";

export interface IndexedMetadataRead {
  (choiceId: string, offset: number, length: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; totalSize: number | null; mimeType: string }>;
}
export interface IndexedTrackInspection {
  candidate: NativePageIndexedCandidate;
  metadata: {
    kind: "video" | "audio"; codec: string; duration: number; firstPTS: number; timescale: number;
    width?: number; height?: number; channels?: number; sampleRate?: number; language: string;
  };
  recipe: NativePageIndexedTrackRecipe;
}
function requireValue(value: unknown, code = "watch_indexed_unsupported"): asserts value {
  if (!value) throw new Error(code);
}
const safe = (value: number) => Number.isSafeInteger(value) && value >= 0;
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

/** GPAC writes the original boxes. Rebuilding trex would change untouched fragments' defaults. */
function normalizedIndexedInit(parser: ISOFile): Uint8Array {
  // RFC 8216 §3.3: the generated init describes the admitted ISO6-compatible fMP4 layout.
  if (!parser.ftyp.compatible_brands.includes("iso6")) parser.ftyp.compatible_brands.push("iso6");
  parser.moov.mvhd.duration = 0;
  for (const track of parser.moov.traks) track.tkhd.duration = 0;
  const stream = new DataStream();
  parser.ftyp.write(stream); parser.moov.write(stream);
  return new Uint8Array(stream.buffer);
}

/** Each candidate has its own GPAC namespace; track ID 1 in two files is valid. */
export async function inspectIndexedTrack(candidate: NativePageIndexedCandidate, read: IndexedMetadataRead,
  signal: AbortSignal): Promise<IndexedTrackInspection> {
  const parser = createFile(false);
  let info: Movie | undefined, parseError = false;
  parser.onReady = value => { info = value; };
  parser.onError = () => { parseError = true; };
  try {
    const prefix = Math.min(candidate.totalSize, NATIVE_PAGE_METADATA_PREFIX_BYTES);
    for (let offset = 0; offset < prefix;) {
      signal.throwIfAborted();
      const length = Math.min(NATIVE_PAGE_READ_BYTES, prefix - offset);
      const result = await read(candidate.id, offset, length, signal);
      signal.throwIfAborted();
      requireValue(result.totalSize === candidate.totalSize && result.bytes.length === length, "watch_media_changed");
      parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(result.bytes.slice().buffer, offset));
      requireValue(!parseError, "watch_mp4_parse_failed");
      offset += length;
      if (parser.ftyp && parser.moov && parser.sidx && parser.moofs.length) break;
    }
    requireValue(info?.isFragmented && parser.ftyp && parser.moov && parser.sidx && parser.moofs.length);
    requireValue(parser.getBoxes("moov", false).length === 1 && parser.getBoxes("sidx", false).length === 1 && info.tracks.length === 1);
    const track = info.tracks[0], trak = parser.moov.traks[0], stbl = trak.mdia.minf.stbl;
    requireValue(track.type === "video" || track.type === "audio");
    requireValue(stbl.stsd && stbl.stts && stbl.stsc && (stbl.stsz || stbl.stz2) && (stbl.stco || stbl.co64));
    requireValue(stbl.stsd.entries.length === 1 && parser.moov.mvex?.trexs.length === 1);
    requireValue(parser.moov.mvex.trexs[0].track_id === track.id);
    requireValue(!(stbl.stsz?.sample_count || stbl.stz2?.sample_sizes.length || stbl.stts.sample_counts.length
      || stbl.stsc.first_chunk.length || stbl.stco?.chunk_offsets.length || stbl.co64?.chunk_offsets.length));
    requireValue(!parser.getBox("sinf") && !parser.getBox("schm") && !parser.getBox("tenc")
      && !parser.getBox("pssh") && !parser.getBox("senc")
      && !["encv", "enca"].includes(stbl.stsd.entries[0].type), "watch_media_encryption_unsupported");
    const dref = parser.getBox("dref"); requireValue(dref);
    const references = dref.entries;
    requireValue(references.length === 1 && references[0].type === "url "
      && references[0] instanceof FullBox && references[0].flags === 1);
    requireValue(stbl.stsd.entries[0].data_reference_index === 1);
    const edits = trak.edts?.elst?.entries ?? [];
    const mediaEdit = edits[0]?.media_time === -1 ? 1 : 0;
    requireValue(!edits.length || edits.length === mediaEdit + 1 && edits[mediaEdit].media_time >= 0);
    requireValue(edits.every(edit => safe(edit.segment_duration) && Number.isSafeInteger(edit.media_time)
      && edit.media_rate_integer === 1 && edit.media_rate_fraction === 0));

    const index = parser.sidx;
    requireValue(index.reference_ID === track.id && index.timescale > 0);
    requireValue(index.version === 0 || index.version === 1);
    requireValue(safe(index.earliest_presentation_time) && safe(index.first_offset) && index.references.length > 0);
    const indexStart = index.start, moovStart = parser.moov.start;
    requireValue(indexStart !== undefined && moovStart !== undefined && safe(indexStart) && safe(moovStart));
    const mediaOffset = indexStart + index.size + index.first_offset;
    requireValue(safe(mediaOffset) && mediaOffset >= moovStart + parser.moov.size);
    let end = mediaOffset, durationTicks = 0;
    const segments: [number, number][] = index.references.map(reference => {
      requireValue(reference.reference_type === 0 && reference.starts_with_SAP === 1
        && [0, 1, 2].includes(reference.SAP_type) && reference.SAP_delta_time === 0);
      requireValue(safe(reference.referenced_size) && reference.referenced_size > 0
        && safe(reference.subsegment_duration) && reference.subsegment_duration > 0);
      requireValue(reference.referenced_size <= mediaFragmentBytes(), "watch_resource_limit");
      end += reference.referenced_size; durationTicks += reference.subsegment_duration;
      requireValue(safe(end) && end <= candidate.totalSize && safe(durationTicks));
      return [reference.referenced_size, reference.subsegment_duration];
    });
    // Check a real first fragment, not merely the presence of a parseable index.
    const moof = parser.moofs[0], firstEnd = mediaOffset + segments[0][0], moofStart = moof.start;
    requireValue(moofStart !== undefined && moofStart >= mediaOffset && moofStart + moof.size < firstEnd && moof.trafs.length === 1);
    const traf = moof.trafs[0];
    requireValue(traf.tfhd.track_id === track.id && traf.tfdt && safe(traf.tfdt.baseMediaDecodeTime));
    requireValue((traf.tfhd.flags & 0x020000) || !(traf.tfhd.flags & 1));
    requireValue(traf.truns.length > 0 && (traf.truns[0].flags & 1));
    const firstSample = parser.getTrackSamplesInfo(track.id)[0];
    requireValue(firstSample?.is_sync && firstSample.offset >= moofStart + moof.size
      && firstSample.offset + firstSample.size <= firstEnd);

    const init = normalizedIndexedInit(parser);
    requireValue(init.length <= NATIVE_PAGE_METADATA_PREFIX_BYTES, "watch_resource_limit");
    const checked = nativePageIndexedTrackRecipeSchema.safeParse({ choiceId: candidate.id, totalSize: candidate.totalSize,
      codec: track.codec, timescale: index.timescale, mediaOffset, initBase64: encode(init), segments });
    requireValue(checked.success);
    return { candidate, recipe: checked.data, metadata: { kind: track.type, codec: track.codec,
      duration: durationTicks / index.timescale, firstPTS: index.earliest_presentation_time,
      timescale: index.timescale, language: track.language,
      ...(track.video && { width: track.video.width, height: track.video.height }),
      ...(track.audio && { channels: track.audio.channel_count, sampleRate: track.audio.sample_rate }) } };
  } finally { parser.stop(); }
}

/** The user chooses these two roles; metadata duration never selects a pairing. */
export function indexedMediaSelection(video: IndexedTrackInspection, audio?: IndexedTrackInspection): NativePageIndexedSelection {
  requireValue(video.metadata.kind === "video" && (!audio || audio.metadata.kind === "audio"));
  return nativePageIndexedSelectionSchema.parse({ video: video.recipe, ...(audio && { audio: audio.recipe }) });
}
