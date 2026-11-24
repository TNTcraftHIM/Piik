import { expect, test } from "vitest";
import { isDocumentActive } from "../src/client/ui/document-active";

function page(hidden: boolean, focused: boolean, piikNativeActive?: boolean): Document {
  return { hidden, hasFocus: () => focused, defaultView: { piikNativeActive } } as Document;
}

test("ordinary browser activity follows visibility and focus", () => {
  expect(isDocumentActive(page(false, true))).toBe(true);
  expect(isDocumentActive(page(true, true))).toBe(false);
  expect(isDocumentActive(page(false, false))).toBe(false);
});

test("a foreground conversation popup and its inactive opener have independent activity", () => {
  const opener = page(false, true, false);
  const popup = page(false, true, true);
  expect(isDocumentActive(opener)).toBe(false);
  expect(isDocumentActive(popup)).toBe(true);
});
