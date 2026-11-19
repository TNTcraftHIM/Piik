import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test } from "vitest";
import { ServiceTransit } from "../src/client/channel/components/ChannelRoomControls";
import type { ChannelController } from "../src/client/channel/types";
import type { ChannelRoom } from "../src/client/channel/protocol";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => setCopy({ lang: "en" }));
test.each(["zh", "en"] as const)("service permission reflects the manager's confirmed preference (%s)", lang => {
  setCopy({ lang });
  const channel = { pending: new Set() } as unknown as ChannelController;
  const room = { id: "room", available: true, canManage: true, authorized: true } as ChannelRoom;
  const render = (overrides: Partial<ChannelRoom>) => renderToStaticMarkup(createElement(ServiceTransit, {
    channel, room: { ...room, ...overrides }, disabled: false, run: async work => { await work(); },
  }));
  expect(render({})).toBe("");
  const standby = { enabled: true, available: false };
  expect(render({ serviceRelay: standby, canManage: false })).toBe("");
  expect(render({ serviceRelay: standby })).toContain('aria-checked="true"');
  expect(render({ serviceRelay: standby })).toContain('role="status"');
  const available = render({ serviceRelay: { enabled: false, available: true } });
  expect(available).toContain('aria-checked="false"');
  expect(available).not.toContain('role="status"');
});
