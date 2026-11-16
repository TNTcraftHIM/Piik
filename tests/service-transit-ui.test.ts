import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ServiceTransit } from "../src/client/channel/components/ChannelRoomControls";
import type { ChannelController } from "../src/client/channel/types";
import type { ChannelRoom } from "../src/client/channel/protocol";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => setCopy({ lang: "en" }));
test.each(["zh", "en"] as const)("service permission starts disabled while authority readback is unavailable (%s)", lang => {
  setCopy({ lang });
  const enable = vi.fn();
  const channel = { pending: new Set(), state: null, roomTopology: vi.fn(), updateRoom: enable } as unknown as ChannelController;
  const room = { id: "room", delivery: { bindingId: "binding" } } as ChannelRoom;
  const html = renderToStaticMarkup(createElement(ServiceTransit, { channel, room, disabled: false, run: async work => { await work(); } }));
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain("disabled");
  expect(html).toContain(lang === "zh" ? "允许站点转发" : "Allow site forwarding");
  expect(enable).not.toHaveBeenCalled();
});
