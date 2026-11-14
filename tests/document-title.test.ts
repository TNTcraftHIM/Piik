import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getTitleFrames } from "../src/client/ui/copy";
import { composeDocumentTitle, useDocumentTitle } from "../src/client/ui/document-title";

afterEach(() => vi.restoreAllMocks());

function Title({ parts, variations }: { parts: string[]; variations: readonly string[] }) {
  return useDocumentTitle(parts, variations, "preview");
}

it.each(["zh", "en"] as const)("keeps %s room, actual status and warning beside the first decoration", lang => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const frames = getTitleFrames(lang, "hostActive");
  const parts = ["9527", frames.label, "⚠"];
  const title = renderToStaticMarkup(createElement(Title, { parts, variations: frames.variations }));
  expect(title).toBe(renderToStaticMarkup(composeDocumentTitle(...parts, frames.variations[0])));
});

it.each(["paused", "viewerUnavailable", "viewerReady", "hostEnded"] as const)(
  "keeps %s literal", state => {
    const frames = getTitleFrames("en", state);
    const title = renderToStaticMarkup(createElement(Title, { parts: ["9527", frames.label], variations: frames.variations }));
    expect(title).toBe(composeDocumentTitle("9527", frames.label));
  },
);
