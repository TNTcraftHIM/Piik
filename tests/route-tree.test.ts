import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { RouteTree } from "../src/client/components/living/RouteTree.tsx";
import { topologyLayoutForViewport } from "../src/client/components/living/route-tree-layout.ts";
import { labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";
import { setCopy } from "../src/client/ui/copy.ts";

afterEach(() => setCopy({ lang: "zh", vis: false }));

describe("RouteTree", () => {
  it("uses real-size narrow coordinates without compressing deep trees", () => {
    const narrow = topologyLayoutForViewport(true);
    const desktop = topologyLayoutForViewport(false);

    expect(narrow).toEqual({
      baseWidth: 260,
      hostX: 54,
      columnGap: 130,
      rightLabelReserve: 65,
      maxVisibleLabelCodePoints: 10,
    });
    expect(
      narrow.hostX + narrow.columnGap + narrow.rightLabelReserve,
    ).toBeLessThanOrEqual(narrow.baseWidth);
    expect(
      narrow.hostX + narrow.columnGap * 3 + narrow.rightLabelReserve,
    ).toBeGreaterThan(narrow.baseWidth);
    expect(desktop.baseWidth).toBe(640);
    expect(desktop.columnGap).toBe(220);
  });

  it("disambiguates names without exposing complete peer IDs", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_private_123456",
        displayName: "Same",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_private_root_654321",
        displayName: "Same",
        upstream: { kind: "peer", peerId: "host_private_123456" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer_private_child_456789",
        displayName: "Friend A",
        upstream: { kind: "peer", peerId: "viewer_private_root_654321" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer_private_sfu_789012",
        displayName: "Friend B",
        upstream: { kind: "sfu" },
        mediaReady: true,
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
      }),
    );

    expect(html).toContain("Same (123456)");
    expect(html).toContain("Same (654321)");
    expect(html).toContain("Friend A");
    expect(html).toContain("Friend B");
    expect(html).not.toContain("host_private_123456");
    expect(html).not.toContain("viewer_private_root_654321");
    expect(html).not.toContain("viewer_private_child_456789");
    expect(html).not.toContain("viewer_private_sfu_789012");
  });

  it("compacts long visible labels while preserving duplicate suffixes", () => {
    const longChinese = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯";
    const longEnglish = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_private_111111",
        displayName: longChinese,
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_private_123456",
        displayName: longEnglish,
        upstream: { kind: "peer", peerId: "host_private_111111" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer_private_654321",
        displayName: longEnglish,
        upstream: { kind: "peer", peerId: "host_private_111111" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer_private_999999",
        displayName: `${longChinese}尾`,
        upstream: { kind: "peer", peerId: "host_private_111111" },
        mediaReady: true,
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
      }),
    );
    const visibleLabels = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      (match) => match[1]!,
    );
    const firstDuplicate = visibleLabels.find((label) =>
      label.endsWith(" (123456)"),
    );
    const secondDuplicate = visibleLabels.find((label) =>
      label.endsWith(" (654321)"),
    );

    expect(firstDuplicate).toBeDefined();
    expect(secondDuplicate).toBeDefined();
    expect(Array.from(firstDuplicate!).length).toBeLessThanOrEqual(16);
    expect(Array.from(secondDuplicate!).length).toBeLessThanOrEqual(16);
    expect(visibleLabels.some((label) => label.endsWith("…"))).toBe(true);
    expect(html).toContain(`${longEnglish} (123456)`);
    expect(html).toContain(`${longEnglish} (654321)`);
    expect(html).toContain(`${longChinese}尾`);
    expect(html).not.toContain("viewer_private_123456");
    expect(html).not.toContain("viewer_private_654321");
  });

  it("keeps participant data labels visible in visual mode", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_abc12345",
        displayName: "Alice",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_def67890",
        displayName: "Bob",
        upstream: { kind: "peer", peerId: "host_abc12345" },
        mediaReady: true,
      },
    ]);
    setCopy({ lang: "en", vis: true });

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
      }),
    );

    expect(html).toContain(">Alice</text>");
    expect(html).toContain(">Bob</text>");
    expect(html).not.toContain("<title");
  });

  it("fits a one-Viewer topology inside a narrow container", () => {
    const hostName = "这是一个合法的二十四字中文分享者显示名称甲乙丙丁";
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host_mobile",
        displayName: hostName,
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer_mobile",
        displayName: "Mobile Viewer",
        upstream: { kind: "peer", peerId: "host_mobile" },
        mediaReady: true,
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
      }),
    );
    const visibleLabels = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      (match) => match[1]!,
    );

    expect(html).toContain('viewBox="0 0 640 ');
    expect(html).toContain('style="width:100%;max-width:880px"');
    expect(html).not.toContain("min-width:640px");
    expect(html).toContain('tabindex="0"');
    expect(visibleLabels).toContain("这是一个合法的二十四字中文分享…");
    expect(html).toContain(hostName);
  });

  it("distinguishes ready, recovering, pending, and selected viewers", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host",
        displayName: "Host",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "ready",
        displayName: "Ready",
        upstream: { kind: "peer", peerId: "host" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "recovering",
        displayName: "Recovering",
        upstream: { kind: "peer", peerId: "host" },
      },
      {
        role: "viewer",
        peerId: "pending",
        displayName: "Pending",
        upstream: { kind: "none" },
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
        selectedPeerId: "recovering",
      }),
    );

    expect(html).toContain('class="lr-route-edge is-p2p"');
    expect(html).toContain('class="lr-route-edge is-p2p is-recovering"');
    expect(html).toContain('class="lr-route-edge is-pending"');
    expect(html).toContain(
      'class="lr-route-node is-recovering is-selected"',
    );
    expect(html).toContain("Recovering");
    expect(html).toContain("← Host");
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
        mediaReady: true as const,
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
    expect(html).toContain(`style="width:${width}px;max-width:none"`);
    expect(
      new Set(
        [...html.matchAll(/translate\(([\d.]+),/g)].map((match) => match[1]),
      ).size,
    ).toBeGreaterThanOrEqual(6);
  });
});
