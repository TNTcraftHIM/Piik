import { identityImageSchema } from "./protocol";

export const isIdentityImage = (icon: string): boolean => icon.startsWith("data:");

/** Native decoding/encoding strips the original file into one small square image. */
export async function prepareIdentityImage(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("invalid_identity_image");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    for (const edge of [128, 96, 64]) {
      canvas.width = canvas.height = Math.min(edge, side);
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
        side, side, 0, 0, canvas.width, canvas.height);
      // Canvas supplies PNG when this platform cannot encode WebP.
      const result = identityImageSchema.safeParse(canvas.toDataURL("image/webp", .85));
      if (result.success) return result.data;
    }
    throw new Error("identity_image_too_large");
  } finally { URL.revokeObjectURL(url); }
}
