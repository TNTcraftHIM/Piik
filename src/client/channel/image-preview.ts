import type { ImageRendition } from "./protocol";

export function imageBytes(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0));
}

export function inlineImageFile(image: ImageRendition, name: string): File {
  return new File([imageBytes(image.data)], name, { type: image.mediaType });
}

function encoded(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

/** Recognize animation before Canvas, which would otherwise flatten it silently. */
function staticImage(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === "image/jpeg") return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (mediaType === "image/png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset), type = text(offset + 4, 4);
      if (length > bytes.length - offset - 12 || type === "acTL") return false;
      if (type === "IDAT") return true;
      offset += length + 12;
    }
  }
  if (mediaType === "image/webp" && bytes.length >= 16) {
    const type = text(12, 4);
    return type === "VP8 " || type === "VP8L" || type === "VP8X" && bytes.length >= 21 && (bytes[20] & 2) === 0;
  }
  return false;
}

/** A rendition is optional; the unchanged original remains the attachment. */
export async function prepareInlineImage(file: File, mediaType: string, budget: number, signal?: AbortSignal): Promise<ImageRendition | undefined> {
  signal?.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType) || budget < 1) return undefined;
  if (mediaType === "image/gif" && file.size > budget) return undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const original = bytes.length <= budget;
  if (!original && !staticImage(bytes, mediaType)) return undefined;
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  let preparedCanvas: HTMLCanvasElement | undefined;
  try {
    const image = new Image(); image.src = url;
    await image.decode(); signal?.throwIfAborted();
    if (original) return { data: encoded(bytes), mediaType: mediaType as ImageRendition["mediaType"], original: true, width: image.naturalWidth, height: image.naturalHeight };
    const canvas = preparedCanvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const draw = (edge: number) => {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    draw(2048);
    for (const [type, quality, edge] of [["image/png", undefined, 2048], ["image/webp", .9, 2048], ["image/webp", .85, 2048], ["image/webp", .85, 1600]] as const) {
      if (type === "image/png" && mediaType !== "image/png") continue;
      if (edge === 1600) draw(edge);
      signal?.throwIfAborted();
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
      signal?.throwIfAborted();
      if (blob && blob.size <= budget) {
        const output = new Uint8Array(await blob.arrayBuffer()); signal?.throwIfAborted();
        return { data: encoded(output), mediaType: blob.type as ImageRendition["mediaType"], original: false, width: canvas.width, height: canvas.height };
      }
    }
  } catch (error) { if (signal?.aborted) throw error; }
  finally {
    if (preparedCanvas) preparedCanvas.width = preparedCanvas.height = 0;
    URL.revokeObjectURL(url);
  }
  return undefined;
}
