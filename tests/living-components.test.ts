import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { Couch } from "../src/client/components/living/Couch.tsx";
import { participantColor } from "../src/client/components/living/participant-color.ts";
import {
  BrandLoader,
  BrandMark,
} from "../src/client/components/living/BrandMark.tsx";
import { Comic } from "../src/client/components/living/Comic.tsx";
import { ComicTooltip } from "../src/client/components/living/ComicTooltip.tsx";
import { HintComic } from "../src/client/components/living/hints/index.tsx";
import { RoomAdmissionBadge } from "../src/client/components/living/RoomChip.tsx";
import { StageOverlay } from "../src/client/components/living/Stage.tsx";
import { ViewerOverview } from "../src/client/components/living/ViewerOverview.tsx";
import { Btn, NameTag } from "../src/client/components/living/primitives.tsx";
import { EMPTY_METRICS } from "../src/client/types.ts";
import { setCopy, t } from "../src/client/ui/copy.ts";

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

  it("shows the Host as a stable couch participant without counting it as a Viewer", () => {
    const hostKey = "host-stable-identity";
    const html = renderToStaticMarkup(
      createElement(Couch, {
        host: { key: hostKey, name: "Host", you: true },
        entries: [],
      }),
    );

    expect(html).toContain("lr-pawn is-host is-static is-you");
    expect(html).toContain(participantColor(hostKey));
    expect(html).toContain("Host · 分享者");
    expect(html).toContain('aria-label="分享者 · 观看者"');
    expect(html).toContain('aria-label="观看者 0"');
    expect(html).not.toContain("lr-couch-empty");
  });

  it("lets the Host pawn own the existing connection-details control", () => {
    const html = renderToStaticMarkup(
      createElement(Couch, {
        host: {
          key: "host-interactive",
          name: "Host",
          selected: true,
          controls: "host-details-panel host-viewer-overview",
          onSelect: () => undefined,
        },
        entries: [
          { key: "viewer-after-host", name: "Viewer", connected: true },
        ],
      }),
    );

    expect(html).toContain("lr-pawn is-host is-selected");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(
      'aria-controls="host-details-panel host-viewer-overview"',
    );
    expect(html.indexOf("Host")).toBeLessThan(html.indexOf("Viewer"));
  });

  it("keeps the current display name visible in visual mode", () => {
    setCopy({ lang: "en", vis: true });
    const identity = "viewer-name-tag";
    const html = renderToStaticMarkup(
      createElement(NameTag, { name: "TNT", identity }),
    );

    expect(html).toContain(">TNT<");
    expect(html).toContain(participantColor(identity));
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

  it("keeps a hint-wrapped disabled control explainable by keyboard", () => {
    setCopy({ lang: "en", vis: true });
    const html = renderToStaticMarkup(
      createElement(
        ComicTooltip,
        {
          kind: "hint-join-go",
          children: createElement(Btn, {
            icon: "refresh",
            title: "viewer.reconnect",
            disabled: true,
          }),
        },
      ),
    );

    expect(html).toContain('class="lr-comic-tip-wrap is-disabled-trigger"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`aria-label="${t("en", "viewer.reconnect")}"`);
  });

  it("animates the private-room hint around its door and lock", () => {
    const html = renderToStaticMarkup(
      createElement(HintComic, { kind: "hint-policy-private", size: 240 }),
    );

    expect(html).toContain("vls-priv-door");
    expect(html).toContain("vls-priv-lock");
    expect(html).toContain("vls-priv-card");
    expect(html).toContain("vlsPrivDoor");
    expect(html).toContain("vlsPrivLock");
  });

  it.each([
    ["open", false, "host.policy.currentOpen", true],
    ["private", true, "host.policy.currentPassword", true],
    ["private", false, "host.policy.currentInvite", false],
  ] as const)(
    "renders %s/%s admission from one policy fact",
    (policy, passwordEnabled, labelKey, good) => {
      setCopy({ lang: "en", vis: true });
      const html = renderToStaticMarkup(
        createElement(RoomAdmissionBadge, { policy, passwordEnabled }),
      );

      expect(html).toContain(
        `<span class="visually-hidden">${t("en", labelKey)}</span>`,
      );
      expect(html).toContain("lr-comic-tip-wrap");
      expect(html).toContain("visually-hidden");
      expect(html.includes("lr-pill is-good")).toBe(good);
    },
  );

  it("uses distinct native quality-limit comics", () => {
    const bandwidth = renderToStaticMarkup(
      createElement(Comic, { kind: "bandwidth-limited", size: 320 }),
    );
    const encoder = renderToStaticMarkup(
      createElement(Comic, { kind: "encoder-limited", size: 320 }),
    );

    expect(bandwidth).toContain("vls-bw-throat");
    expect(bandwidth).toContain("vlsBwSmall");
    expect(encoder).toContain("vls-en-drop");
    expect(encoder).toContain("vlsEnHeat");
  });

  it("keeps the Host-offline comic free of the waiting-room moon", () => {
    const html = renderToStaticMarkup(
      createElement(Comic, { kind: "host-offline", theme: "stage" }),
    );

    expect(html).not.toContain("M229 39.5a8.5");
  });

  it("draws the waiting moon as one open crescent instead of nested circles", () => {
    const html = renderToStaticMarkup(
      createElement(Comic, { kind: "waiting-for-host", theme: "stage" }),
    );

    expect(html).toContain(
      "M0 -8.5A8.5 8.5 0 1 0 0 8.5A6.2 8.5 0 0 1 0 -8.5Z",
    );
    expect(html).not.toContain("M229 39.5a8.5");
    expect(html).not.toContain('fill-rule="evenodd"');
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
        })),
      }),
    );

    expect(html).toContain("lr-pawns is-crowded");
    expect(html).toContain(
      '<span class="lr-pawn-name">Relay Viewer With A Full Name</span>',
    );
    expect(html).toContain('title="Relay Viewer With A Full Name"');
    expect(html).not.toContain("max-width:72px");
  });

  it("derives every participant color only from the peer identity", () => {
    const peerId = "viewer-stable-identity";
    const color = participantColor(peerId);
    const html = renderToStaticMarkup(
      createElement(Couch, {
        entries: [
          {
            key: peerId,
            name: "Self",
            connected: true,
            you: true,
          },
        ],
      }),
    );

    expect(participantColor(peerId)).toBe(color);
    expect(html).toContain(color);
    expect(html).not.toContain("var(--you)");
  });

  it("shows all Viewer primary metrics in one compact selectable overview", () => {
    const html = renderToStaticMarkup(
      createElement(ViewerOverview, {
        entries: [
          {
            key: "viewer-a",
            name: "Alice",
            connected: true,
            statusLabel: "Connected",
            route: "p2p",
            metrics: {
              ...EMPTY_METRICS,
              resolution: "1920x1080",
              framesPerSecond: 59.8,
              bitrateKbps: 5120,
              packetLossPercent: 0.4,
              rttMs: 18,
            },
          },
          {
            key: "viewer-b",
            name: "Bob",
            connected: false,
            statusLabel: "Routing",
            route: null,
            metrics: null,
          },
        ],
        selectedKey: "viewer-a",
        onSelect: () => undefined,
      }),
    );

    expect(html).toContain("lr-viewer-overview-row is-selected");
    expect(html).toContain("Alice");
    expect(html).toContain("1920x1080");
    expect(html).toContain("59.8");
    expect(html).toContain("5120");
    expect(html).toContain("18 ms");
    expect(html).toContain("Bob");
  });

  it("uses route glyphs without visible route text in visual mode", () => {
    setCopy({ lang: "en", vis: true });
    const html = renderToStaticMarkup(
      createElement(ViewerOverview, {
        entries: [
          {
            key: "viewer-p2p",
            name: "Alice",
            connected: true,
            statusLabel: "Connected",
            route: "p2p",
            metrics: null,
          },
        ],
        selectedKey: null,
        onSelect: () => undefined,
      }),
    );

    expect(html).not.toContain("<b>P2P</b>");
    expect(html).toContain(t("en", "state.route.p2p"));
  });
});
