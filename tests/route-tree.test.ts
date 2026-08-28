import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteTree } from "../src/client/components/living/RouteTree.tsx";
import { labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";
import { setCopy } from "../src/client/ui/copy.ts";

setCopy({ lang: "zh", vis: false });

describe("RouteTree", () => {
  it("disambiguates Host and Viewer names without exposing unique peer IDs", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_private_123456",
        displayName: "同名",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_private_root_654321",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "host_private_123456" },
      },
      {
        role: "viewer",
        peerId: "viewer_private_child_456789",
        displayName: "朋友乙",
        upstream: { kind: "peer", peerId: "viewer_private_root_654321" },
      },
      {
        role: "viewer",
        peerId: "viewer_private_sfu_789012",
        displayName: "朋友丙",
        upstream: { kind: "sfu" },
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "分享者",
        viewers,
        selfPeerId: null,
      }),
    );

    expect(html).toContain("同名 (123456)");
    expect(html).toContain("同名 (654321)");
    expect(html).toContain("朋友乙");
    expect(html).toContain("朋友丙");
    expect(html).toContain("媒体服务器");
    expect(html).toContain("分享者");
    expect(html).not.toContain("host_private_123456");
    expect(html).not.toContain("viewer_private_root_654321");
    expect(html).not.toContain("viewer_private_child_456789");
    expect(html).not.toContain("viewer_private_sfu_789012");
  });

  it("keeps the tree text-free in visual mode", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_abc12345",
        displayName: "阿舟",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_def67890",
        displayName: "阿茶",
        upstream: { kind: "peer", peerId: "host_abc12345" },
      },
    ]);
    setCopy({ vis: true });
    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "分享者",
        viewers,
        selfPeerId: null,
      }),
    );
    expect(html).not.toContain("<text");
    // Accessible names ride on aria-label: <title> doubles as a native hover
    // tooltip, which leaks localized UI text into the zero-text mode.
    expect(html).not.toContain("<title");
    expect(html).toContain('aria-label="阿茶"');
    setCopy({ vis: false });
  });

  it("gives every reachable depth its own horizontal column", () => {
    const participants = [
      {
        role: "host" as const,
        peerId: "host",
        displayName: "Host",
        upstream: { kind: "none" as const },
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        role: "viewer" as const,
        peerId: `viewer-${index}`,
        displayName: `Viewer ${index}`,
        upstream: {
          kind: "peer" as const,
          peerId: index === 0 ? "host" : `viewer-${index - 1}`,
        },
      })),
    ];
    const { host, viewers } = labelParticipantSnapshot(participants);
    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
      }),
    );
    const width = Number(html.match(/viewBox="0 0 (\d+) /)?.[1]);

    expect(width).toBeGreaterThan(640);
    expect(new Set([...html.matchAll(/translate\((\d+),/g)].map((match) => match[1])).size).toBeGreaterThanOrEqual(6);
  });
});
