import { afterEach, expect, test, vi } from "vitest";
import { inlineImageFile, prepareInlineImage } from "../src/client/channel/image-preview";

afterEach(() => vi.unstubAllGlobals());

test("byte-identical and over-budget encodings stay out of history", async () => {
  const file = new File(["abc"], "small.webp", { type: "image/webp" });
  let rendition: Blob = file;
  vi.stubGlobal("Image", class { naturalWidth = 1; naturalHeight = 1; async decode() {} });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ drawImage() {} }),
    toBlob: (callback: BlobCallback) => callback(rendition) }) });
  expect(await prepareInlineImage(file, file.type, 1024)).toBeUndefined();
  rendition = new Blob(["xyz"], { type: "image/png" });
  expect(await prepareInlineImage(file, file.type, rendition.size)).toMatchObject({ data: btoa("xyz"), mediaType: "image/png" });
  expect(await prepareInlineImage(file, file.type, rendition.size - 1)).toBeUndefined();
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
