import { afterEach, expect, test, vi } from "vitest";
import { inlineImageFile, prepareInlineImage } from "../src/client/channel/image-preview";

afterEach(() => vi.unstubAllGlobals());

test("over-budget animated formats never reach a static decoder", async () => {
  const image = vi.fn(); vi.stubGlobal("Image", image);
  const png = new Uint8Array(40); new DataView(png.buffer).setUint32(8, 8); png.set(new TextEncoder().encode("acTL"), 12);
  const webp = new Uint8Array(40); webp.set(new TextEncoder().encode("VP8X"), 12); webp[20] = 2;
  for (const [bytes, type] of [[png, "image/png"], [webp, "image/webp"], [new Uint8Array(40), "image/gif"]] as const) {
    expect(await prepareInlineImage(new File([bytes], "animated"), type, 20)).toBeUndefined();
  }
  expect(image).not.toHaveBeenCalled();
});

test("unsupported input and cancelled work cannot begin image decoding", async () => {
  const image = vi.fn(); vi.stubGlobal("Image", image);
  expect(await prepareInlineImage(new File(["<svg/>"], "unsafe.svg"), "image/svg+xml", 65536)).toBeUndefined();
  const request = new AbortController(); request.abort();
  await expect(prepareInlineImage(new File(["bytes"], "image.png"), "image/png", 65536, request.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(image).not.toHaveBeenCalled();
});

test("a preview file uses its rendition's format without claiming to be the original", async () => {
  const image = { data: btoa("preview bytes"), mediaType: "image/webp" as const, original: false, width: 2048, height: 1024 };
  const file = inlineImageFile(image, "original.png");
  expect(file.type).toBe("image/webp"); expect(await file.text()).toBe("preview bytes");
  expect(image.original).toBe(false);
});
