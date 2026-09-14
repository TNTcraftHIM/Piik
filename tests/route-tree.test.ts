import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { RouteTree } from "../src/client/components/living/RouteTree.tsx";
import { Couch } from "../src/client/components/living/Couch.tsx";
import { participantColor } from "../src/client/components/living/participant-color.ts";
import { topologyLayoutForWidth } from "../src/client/components/living/route-tree-layout.ts";
import { labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";
import { setCopy } from "../src/client/ui/copy.ts";
import { deriveParticipantStatus } from "../src/client/ui/media-status";

afterEach(() => setCopy({ lang: "zh", vis: false }));

it("keeps participant identity and actual Viewer readiness in their descriptions", () => {
  setCopy({ lang: "en", vis: true });
  const render = (view: "host" | "viewer") => renderToStaticMarkup(createElement(Couch, {
    view,
    host: { key: "host", name: "Host name", you: view === "host" },
    entries: [{
      key: "viewer", name: "Viewer name",
      status: deriveParticipantStatus({ mediaReady: false, upstream: { kind: "none" } }, true), you: view === "viewer",
    }],
  }));
  const hostView = render("host");
  expect(hostView).toContain('aria-label="Host name · Host · you"');
  expect(hostView).toContain('class="lr-pawn-led" data-tone="busy"');
  const viewerView = render("viewer");
  expect(viewerView).toContain('aria-label="Host name · Host"');
  expect(viewerView).toContain('aria-label="Viewer name · you · Routing"');
  expect(viewerView).not.toContain('class="lr-pawn-led"');
  expect(viewerView).toContain('is-waiting');
  setCopy({ vis: false });
  const textMode = render("viewer");
  expect(textMode).toContain('aria-label="Host name · Host"');
  expect(textMode).toContain('aria-label="Viewer name · you · Routing"');
});

it.each([
  ["zh", "房主", "你"],
  ["en", "Host", "you"],
] as const)("does not repeat the default Host name or invent presence in %s", (lang, name, self) => {
  setCopy({ lang, vis: false });
  const html = renderToStaticMarkup(createElement(Couch, {
    view: "host", host: { key: "host", name, you: true }, entries: [],
  }));
  expect(html).toContain(`aria-label="${name} · ${self}"`);
  expect(html).not.toContain(`${name} · ${name}`);
  expect(html).not.toMatch(/Offline|离线|has-comic|tabindex="0"/);
});

describe("RouteTree", () => {
  it("sorts every Viewer by stable peer identity", () => {
    const { viewers } = labelParticipantSnapshot([
      {
        role: "viewer",
        peerId: "viewer-z",
        displayName: "Z",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer-a",
        displayName: "A",
        upstream: { kind: "none" },
      },
    ]);

    expect(viewers.map((viewer) => viewer.peerId)).toEqual([
      "viewer-a",
      "viewer-z",
    ]);
  });

  it("uses real-size narrow coordinates without compressing deep trees", () => {
    const narrow = topologyLayoutForWidth(260);
    const desktop = topologyLayoutForWidth(640);

    expect(narrow).toEqual({
      baseWidth: 260,
      hostX: 65,
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
    expect(desktop.hostX).toBe(210);
    expect(desktop.columnGap).toBe(220);
    expect(desktop.rightLabelReserve).toBe(210);
  });

  it("derives symmetric topology insets at every responsive width", () => {
    for (const width of [260, 390, 520, 640]) {
      const layout = topologyLayoutForWidth(width);
      expect(layout.hostX).toBe(layout.rightLabelReserve);
      expect(
        layout.hostX * 2 + layout.columnGap,
      ).toBe(layout.baseWidth);
    }
  });

  it("keeps topology geometry continuous across the former viewport breakpoint", () => {
    const atBreakpoint = topologyLayoutForWidth(640);
    const afterBreakpoint = topologyLayoutForWidth(641);

    expect(afterBreakpoint).toEqual(atBreakpoint);
    expect(topologyLayoutForWidth(390).baseWidth).toBe(390);
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
    const visibleLabels = [...html.matchAll(/<span class="lr-route-label[^>]*>([^<]*)<\/span>/g)].map(
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

    expect(html).toContain(">Alice</span>");
    expect(html).toContain(">Bob</span>");
    expect(html).not.toContain("<title");
  });

  it("preserves emoji nicknames that resemble a default role label", () => {
    const hostPeerId = "host-abc123";
    const viewerPeerId = "viewer-def456";
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: hostPeerId,
        displayName: "🎮 (abc123)",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: viewerPeerId,
        displayName: "👤 (def456)",
        upstream: { kind: "peer", peerId: hostPeerId },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer-custom789",
        displayName: "👤-custom",
        upstream: { kind: "peer", peerId: hostPeerId },
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

    expect(html).toContain(">🎮 (abc123)</span>");
    expect(html).toContain(">👤 (def456)</span>");
    expect(html).toContain(">👤-custom</span>");
    expect(html).not.toContain(">abc123</span>");
    expect(html).not.toContain(">def456</span>");
    expect(html).toContain("scale(0.82)");
  });

  it("uses the Host identity color in the topology", () => {
    const hostPeerId = "host-color-identity";
    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId,
        hostLabel: "Host",
        viewers: [],
      }),
    );

    expect(html).toContain(participantColor(hostPeerId));
    expect(html).not.toContain('fill="var(--couch)"');
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
    const visibleLabels = [...html.matchAll(/<span class="lr-route-label[^>]*>([^<]*)<\/span>/g)].map(
      (match) => match[1]!,
    );

    expect(html).toContain('viewBox="0 0 640 ');
    expect(html).toContain('style="width:100%;max-width:880px"');
    expect(html).not.toContain("min-width:640px");
    expect(html).toContain('tabindex="0"');
    expect(visibleLabels).toContain("这是一个合法的二十四字中文分享…");
    expect(html).toContain(hostName);
  });

  it("distinguishes ready, pending, and selected viewers", () => {
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
        peerId: "awaiting-media",
        displayName: "Awaiting media",
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
        selectedPeerId: "awaiting-media",
      }),
    );

    expect(html).toContain('class="lr-route-edge is-p2p"');
    expect(html).toContain('class="lr-route-edge is-p2p is-pending"');
    expect(html).toContain('class="lr-route-edge is-pending"');
    expect(html).toContain(
      'class="lr-route-node is-pending is-selected"',
    );
    expect(html).toContain(
      'class="lr-route-selection" x="1" y="2" width="38" height="46" rx="8"',
    );
    expect(html).toContain("Awaiting media");
    expect(html).toContain("← Host");
  });

  it("exposes only authorized topology nodes as detail controls", () => {
    const { host, viewers } = labelParticipantSnapshot([
      {
        role: "host",
        peerId: "host",
        displayName: "Host",
        upstream: { kind: "none" },
      },
      {
        role: "viewer",
        peerId: "viewer-a",
        displayName: "Alice",
        upstream: { kind: "peer", peerId: "host" },
        mediaReady: true,
      },
      {
        role: "viewer",
        peerId: "viewer-b",
        displayName: "Bob",
        upstream: { kind: "peer", peerId: "host" },
        mediaReady: true,
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(RouteTree, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "Host",
        viewers,
        selectablePeerIds: ["viewer-b"],
        onSelectPeer: () => undefined,
      }),
    );

    expect(html.match(/class="lr-route-hit"/g)).toHaveLength(1);
    expect(html).toContain('<button class="lr-route-hit" type="button"');
    expect(html).toContain('aria-label="Bob · 显示连接详情"');
    expect(html).not.toContain('aria-label="Alice · 显示连接详情"');
  });

  it("keeps truncated Host, unselectable and pending names in visible tooltip targets", () => {
    const name = "这是一个需要完整查看而不是只能读省略号的参与者名字";
    const html = renderToStaticMarkup(createElement(RouteTree, {
      hostPeerId: "host", hostLabel: `${name}房主`,
      viewers: labelParticipantSnapshot([
        { role: "viewer", peerId: "ready", displayName: `${name}观众`, upstream: { kind: "peer", peerId: "host" }, mediaReady: true },
        { role: "viewer", peerId: "pending", displayName: `${name}等待`, upstream: { kind: "none" } },
      ]).viewers,
      selectablePeerIds: ["pending"], onSelectPeer: () => undefined,
    }));
    const targets = [...html.matchAll(/<foreignObject[^>]*>(.*?)<\/foreignObject>/g)].map(match => match[1]!);
    expect(targets).toHaveLength(3);
    for (const [index, suffix] of ["房主", "观众", "等待"].entries()) {
      // The hidden topology list retains every full identity before client
      // layout measures clipping; generic static spans must not be named.
      expect(html).toContain(`${name}${suffix}`);
      if (index === 2) expect(targets[index]).toContain(`aria-label="${name}${suffix} · 显示连接详情"`);
      else expect(targets[index]).not.toContain("aria-label=");
      expect(targets[index]).toMatch(/class="lr-route-label lr-route-name[^>]*>[^<]*…<\/span>/);
      expect(targets[index]).toContain('popover="manual"');
      expect(targets[index]).not.toContain("data-comic-motion");
    }
    expect(targets[0]).not.toContain("<button");
    expect(targets[1]).not.toContain("<button");
    expect(targets[2]).toContain('<button class="lr-route-hit"');
    expect(targets[2]).toContain('class="lr-route-label lr-route-name is-pending"');
  });

  it("keeps every person and parent edge in a full-room relay chain within the panel", () => {
    const participants = [
      {
        role: "host" as const,
        peerId: "host",
        displayName: "Host",
        upstream: { kind: "none" as const },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
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

    expect(width).toBe(640);
    expect(html).toContain('class="lr-route is-outline"');
    expect(html).not.toContain("max-width:none");
    expect(html.match(/class="lr-route-edge is-p2p"/g)).toHaveLength(20);
    expect(html.match(/class="lr-person"/g)).toHaveLength(21);
    const points = [...html.matchAll(/class="lr-route-node[^\"]*" transform="translate\(([\d.]+), ([\d.]+)\)/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(new Set(points.map((point) => point.y)).size).toBe(21);
    expect(points.every((point) => point.x >= 0 && point.x + 40 < width)).toBe(true);
    for (let index = 0; index < 20; index++) {
      expect(html).toContain(`Viewer ${index} ← ${index === 0 ? "Host" : `Viewer ${index - 1}`}`);
    }
  });
});
