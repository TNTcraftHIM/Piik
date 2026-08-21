import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TopologyView } from "../src/client/components/TopologyView.tsx";
import { labelParticipantSnapshot } from "../src/client/lib/viewer-presence.ts";

describe("TopologyView", () => {
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
      createElement(TopologyView, {
        hostPeerId: host?.peerId ?? null,
        hostLabel: host?.label ?? "分享者",
        viewers,
      }),
    );

    expect(html).toContain('aria-label="当前连接拓扑"');
    expect(html).toContain("同名 (123456)");
    expect(html).toContain("同名 (654321)");
    expect(html).toContain("朋友乙");
    expect(html).toContain("朋友丙");
    expect(html).toContain("媒体服务器");
    expect(html).not.toContain("host_private_123456");
    expect(html).not.toContain("viewer_private_root_654321");
    expect(html).not.toContain("viewer_private_child_456789");
    expect(html).not.toContain("viewer_private_sfu_789012");
  });
});
