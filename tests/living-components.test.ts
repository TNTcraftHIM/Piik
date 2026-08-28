import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { Couch } from "../src/client/components/living/Couch.tsx";
import { ComicTooltip } from "../src/client/components/living/ComicTooltip.tsx";
import { StageOverlay } from "../src/client/components/living/Stage.tsx";
import { NameTag } from "../src/client/components/living/primitives.tsx";
import { setCopy } from "../src/client/ui/copy.ts";

describe("living-room presentation", () => {
  afterEach(() => setCopy({ lang: "zh", vis: false }));

  it("keeps visual-only stage status available to assistive technology", () => {
    setCopy({ lang: "en", vis: true });
    const html = renderToStaticMarkup(
      createElement(StageOverlay, {
        icon: "refresh",
        message: "Media connection recovering",
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Media connection recovering"');
    expect(html).not.toContain("lr-tv-msg");
  });

  it("announces the supplied state for a Viewer without committed media", () => {
    setCopy({ lang: "en", vis: false });
    const html = renderToStaticMarkup(
      createElement(Couch, {
        entries: [
          {
            key: "viewer-1",
            name: "TNT",
            connected: false,
            statusLabel: "Recovering",
          },
        ],
      }),
    );

    expect(html).toContain("TNT · Recovering");
    expect(html).toContain("lr-pawn-led is-wait");
  });

  it("keeps the current display name visible in visual mode", () => {
    setCopy({ lang: "en", vis: true });
    const html = renderToStaticMarkup(
      createElement(NameTag, { name: "TNT" }),
    );

    expect(html).toContain(">TNT<");
    expect(html).not.toContain("visually-hidden");
  });

  it("leaves hidden tooltip artwork out of the initial markup", () => {
    const html = renderToStaticMarkup(
      createElement(
        ComicTooltip,
        {
          kind: "hint-share-start",
          children: createElement("button", { type: "button" }, "Share"),
        },
      ),
    );

    expect(html).toContain("lr-comic-tip");
    expect(html).toContain(">Share</button>");
    expect(html).not.toContain('viewBox="0 0 320 96"');
  });
});
