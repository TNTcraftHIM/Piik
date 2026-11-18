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

export async function prepareInlineImage(file: File, mediaType: string, budget: number, signal?: AbortSignal): Promise<ImageRendition | undefined> {
  signal?.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType) || budget < 1) return undefined;
  const url = URL.createObjectURL(file.slice(0, file.size, mediaType));
  let preparedCanvas: HTMLCanvasElement | undefined;
  try {
    const image = new Image(); image.src = url;
    await image.decode(); signal?.throwIfAborted();
    const canvas = preparedCanvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    for (const edge of [640, 320, 160]) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      signal?.throwIfAborted();
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mediaType === "image/webp" ? "image/png" : "image/webp", .85));
      signal?.throwIfAborted();
      if (blob && blob.size <= budget) {
        const output = new Uint8Array(await blob.arrayBuffer()); signal?.throwIfAborted();
        if (blob.type === mediaType && file.size === output.length) {
          const original = new Uint8Array(await file.arrayBuffer());
          signal?.throwIfAborted();
          if (output.every((byte, index) => byte === original[index])) continue;
        }
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
