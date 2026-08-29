import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { Couch } from "../src/client/components/living/Couch.tsx";
import {
  BrandLoader,
  BrandMark,
} from "../src/client/components/living/BrandMark.tsx";
import { Comic } from "../src/client/components/living/Comic.tsx";
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

  it("uses one static brand shape and an aria-hidden animated loading variant", () => {
    const mark = renderToStaticMarkup(createElement(BrandMark, { size: 32 }));
    const loader = renderToStaticMarkup(createElement(BrandLoader));

    expect(mark).toContain('class="lr-brand-mark"');
    expect(mark).toContain("lr-brand-eye-wink");
    expect(mark).not.toContain("is-animated");
    expect(loader).toContain('class="lr-brand-loader"');
    expect(loader).toContain("lr-brand-mark is-animated");
    expect(loader).toContain('aria-hidden="true"');
  });

  it("uses the animated brand for transient stage states", () => {
    const html = renderToStaticMarkup(
      createElement(StageOverlay, {
        icon: "loader",
        transition: true,
        message: "Allocating media route",
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("lr-brand-loader");
    expect(html).not.toContain("lr-tv-big");
  });

  it("ends the exhausted-route comic with a failed fallback", () => {
    const html = renderToStaticMarkup(
      createElement(Comic, { kind: "route-failed", size: 320 }),
    );

    expect(html).toContain("vls-rf-fallback-x");
    expect(html).toContain("vls-rf-fallback");
    expect(html).toContain("vlsRfFailurePulse");
    expect(html).toContain("vlsRfFailureX");
    expect(html).not.toContain("vls-rf-green");
    expect(html).not.toContain("vls-rf-star");
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
    expect(html).toContain('aria-label="Viewers 1"');
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

  it("keeps every crowded and relay Viewer name visible in visual mode", () => {
    setCopy({ lang: "en", vis: true });
    const html = renderToStaticMarkup(
      createElement(Couch, {
        entries: Array.from({ length: 12 }, (_, index) => ({
          key: `viewer-${index}`,
          name:
            index === 11
              ? "Relay Viewer With A Full Name"
              : `Viewer ${index}`,
          connected: true,
          child: index === 11,
        })),
      }),
    );

    expect(html).toContain("lr-pawns is-crowded");
    expect(html).toContain(
      '<span class="lr-pawn-name is-mini">Relay Viewer With A Full Name</span>',
    );
    expect(html).not.toContain("max-width:72px");
  });
});
