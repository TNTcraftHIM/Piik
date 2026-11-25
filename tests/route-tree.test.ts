import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { RouteGraph } from "../src/client/components/living/RouteGraph.tsx";
import { Couch } from "../src/client/components/living/Couch.tsx";
import { participantColor } from "../src/client/components/living/participant-color.ts";
import { routeGraphLayout, topologyLayoutForWidth, type RouteGraphNode, type RouteGraphEdge } from "../src/client/components/living/route-tree-layout.ts";
import { labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";
import { setCopy } from "../src/client/ui/copy.ts";
import { deriveParticipantStatus } from "../src/client/ui/media-status";

afterEach(() => setCopy({ lang: "zh" }));

function accessibleRoutes(html: string): string[] {
  const list = html.split('<ul class="visually-hidden">')[1].split("</ul>")[0];
  return Array.from(list.matchAll(/<li>(.*?)<\/li>/gs), ([, item]) => item.replace(/<[^>]+>/g, ""));
}

it("keeps participant identity and actual Viewer readiness in their descriptions", () => {
  setCopy({ lang: "en" });
  const render = (view: "host" | "viewer") => renderToStaticMarkup(createElement(Couch, {
    view,
    host: { key: "host", name: "Host name", you: view === "host" },
    entries: [{
      key: "viewer", name: "Viewer name",
      status: deriveParticipantStatus({ mediaReady: false, upstream: { kind: "none" } }, true), you: view === "viewer",
    }],
  }));
  const hostView = render("host");
  expect(hostView).toContain('aria-label="Host name, Host, you"');
  expect(hostView).toContain('class="lr-pawn-led" data-tone="busy"');
  const viewerView = render("viewer");
  expect(viewerView).toContain('aria-label="Host name, Host"');
  expect(viewerView).toContain('aria-label="Viewer name, you, Routing"');
  expect(viewerView).not.toContain('class="lr-pawn-led"');
  expect(viewerView).toContain('is-waiting');
});

it.each([
  ["zh", "房主", "你"],
  ["en", "Host", "you"],
] as const)("does not repeat the default Host name or invent presence in %s", (lang, name, self) => {
  setCopy({ lang });
  const html = renderToStaticMarkup(createElement(Couch, {
    view: "host", host: { key: "host", name, you: true }, entries: [],
  }));
  const comma = lang === "zh" ? "，" : ", ";
  expect(html).toContain(`aria-label="${name}${comma}${self}"`);
  expect(html).not.toContain(`${name}${comma}${name}`);
  expect(html).not.toMatch(/Offline|离线|has-comic|tabindex="0"/);
});

describe("topology labels and layout", () => {
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
});

describe("RouteGraph", () => {
  it("lays out the selected parent while retaining both real candidate edges", () => {
    const nodes = [
      { id: "source", label: "Source" }, { id: "relay", label: "Relay" },
      { id: "viewer", label: "Viewer" }, { id: "helper", label: "Viewer App" },
    ];
    const edges = [
      { from: "helper", to: "viewer", selected: false, ready: true, presentation: true },
      { from: "source", to: "helper", selected: false, ready: false },
      { from: "source", to: "relay", selected: true, ready: true },
      { from: "relay", to: "viewer", selected: true, ready: true },
    ];
    const layout = routeGraphLayout(nodes, "source", edges, 640);
    expect(layout.points.get("viewer")!.x).toBeGreaterThan(layout.points.get("relay")!.x);
    expect(layout.points.get("helper")!.x).toBe(layout.points.get("relay")!.x);
    const html = renderToStaticMarkup(createElement(RouteGraph, { nodes, rootId: "source", edges }));
    expect(html.match(/class="lr-route-edge /g)).toHaveLength(4);
    expect(html).toContain('class="lr-route-edge is-p2p is-pending is-presentation"');
    expect(html.match(/class="lr-route-edge is-p2p"/g)).toHaveLength(2);
    const viewerRoutes = accessibleRoutes(html).find(item => item.startsWith("Viewer ←"));
    expect(viewerRoutes).toContain("← Relay ·");
    expect(viewerRoutes).toContain("← Viewer App ·");
    expect(html).not.toContain("SFU");
  });

  it("keeps distinct endpoint controls with their stable participant identity color", () => {
    const nodes = [{ id: "source", label: "Source", host: true },
      { id: "app", label: "Friend App", identity: "friend-user" },
      { id: "page", label: "Friend Browser", identity: "friend-user", you: true }];
    const edges = [{ from: "source", to: "app", selected: true, ready: true },
      { from: "app", to: "page", selected: true, ready: true, presentation: true }];
    const html = renderToStaticMarkup(createElement(RouteGraph, { nodes, rootId: "source", edges,
      selectedId: "page", selectableIds: ["app", "page"], onSelect: () => undefined }));
    expect(html.match(/class="lr-person"/g)).toHaveLength(3);
    expect(html.split(participantColor("friend-user"))).toHaveLength(3);
    expect(html.match(/class="lr-route-hit"/g)).toHaveLength(2);
    expect(html).toContain('class="lr-route-node is-selected"');
    expect(html).toContain('class="lr-route-you"');
    expect(html).toContain('class="lr-route-edge is-p2p is-presentation"');
  });

  it("keeps a deep graph and its pending alternative inside the narrow outline", () => {
    const nodes: RouteGraphNode[] = Array.from({ length: 21 }, (_, index) => ({ id: `${index}`, label: `Person ${index}` }));
    const edges: RouteGraphEdge[] = nodes.slice(1).map((node, index) => ({ from: `${index}`, to: node.id, selected: true, ready: true }));
    nodes.push({ id: "helper", label: "New App" });
    edges.push({ from: "0", to: "helper", selected: false, ready: false },
      { from: "helper", to: "20", selected: false, ready: false, presentation: true });
    const layout = routeGraphLayout(nodes, "0", edges, 260);
    expect(layout.outline).toBe(true);
    expect(layout.width).toBe(260);
    expect(new Set([...layout.points.values()].map(point => point.y)).size).toBe(nodes.length);
    expect([...layout.points.values()].every(point => point.x >= 0 && point.x + 40 < layout.width)).toBe(true);
    const html = renderToStaticMarkup(createElement(RouteGraph, { nodes, rootId: "0", edges }));
    expect(html.match(/class="lr-route-edge /g)).toHaveLength(edges.length);
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("shares the solid SFU rail only between ready branches without widening the panel", () => {
    const nodes = [{ id: "host", label: "Host", host: true }, { id: "sfu", label: "SFU", kind: "sfu" as const },
      { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
    const edges: RouteGraphEdge[] = [{ from: "host", to: "sfu", selected: true, ready: true, route: "sfu" },
      ...["a", "b", "c"].map(to => ({ from: "sfu", to, selected: true, ready: false, route: "sfu" as const }))];
    const render = () => renderToStaticMarkup(createElement(RouteGraph, { nodes, rootId: "host", edges }));
    const pending = render();
    expect(pending.match(/class="lr-route-edge is-sfu"/g)).toHaveLength(1);
    expect(pending.match(/class="lr-route-edge is-sfu is-pending"/g)).toHaveLength(3);
    edges[1].ready = edges[2].ready = true;
    const html = render();
    expect(html).toContain('viewBox="0 0 640 ');
    expect(html.match(/class="lr-route-sfu"/g)).toHaveLength(1);
    expect(html.match(/class="lr-route-edge is-sfu"/g)).toHaveLength(5);
    expect(html.match(/d="M [^"]+ Q [^"]+" class="lr-route-edge is-sfu is-pending"/g)).toHaveLength(1);
  });
});
