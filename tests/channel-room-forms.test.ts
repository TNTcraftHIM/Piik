import { createElement, type KeyboardEvent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ChannelRoomCreateDialog, ChannelRoomSettingsDialog } from "../src/client/channel/components/ChannelRoomControls";
import { ChannelUnlistedRoomEntry } from "../src/client/channel/components/ChannelRoomEntry";
import { protectRoomComposition } from "../src/client/channel/components/room-form-interaction";
import type { ChannelRoom } from "../src/client/channel/protocol";
import type { ChannelController } from "../src/client/channel/types";

vi.mock("../src/client/channel/components/ChannelSettingsDialog", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/client/channel/components/ChannelSettingsDialog")>();
  return { ...actual, ChannelSettingsDialog: ({ children }: { children: ReactNode }) => children };
});

const submitButton = (markup: string) => markup.match(/<button\b[^>]*\btype="submit"[^>]*>/g);

test.each(["Enter", "Escape"])("%s leaves the active composition in charge", key => {
  const preventDefault = vi.fn();
  const dispatch = (isComposing: boolean, keyCode: number) =>
    protectRoomComposition({ key, preventDefault, nativeEvent: { isComposing, keyCode } } as unknown as KeyboardEvent<HTMLFormElement>);
  dispatch(false, key === "Enter" ? 13 : 27);
  expect(preventDefault).not.toHaveBeenCalled();
  dispatch(true, key === "Enter" ? 13 : 27);
  dispatch(false, 229);
  expect(preventDefault).toHaveBeenCalledTimes(2);
});

test("room creation keeps its optional forwarding default and validates the create action", () => {
  const render = (name: string, pending = new Set<string>()) => renderToStaticMarkup(createElement(ChannelRoomCreateDialog, {
    channel: { connection: "connected", pending } as unknown as ChannelController, creationPolicy: "ordinary",
    initialName: name, onClose() {}, onCreated() {},
  }));
  const markup = render("Garden");
  expect(markup).toMatch(/<details[^>]*><summary>[^<]+<\/summary>.*?name="relay-capacity"/);
  expect(markup).not.toContain('name="audioBitrate"');
  expect(submitButton(markup)).toHaveLength(1);
  expect(submitButton(markup)?.[0]).not.toContain("disabled");
  expect(submitButton(render(" "))?.[0]).toContain("disabled");
  expect(submitButton(render("Garden", new Set(["create-room"])))?.[0]).toContain("disabled");
});

test("room settings group identity and network fields into their respective edit forms", () => {
  const room = { id: "garden", name: "Garden", icon: "couch", access: "public", authorized: true,
    canManage: true, available: true, voiceBitrate: 64000, relayCapacity: 2,
    serviceRelay: { enabled: true, available: false } } as ChannelRoom;
  const render = (pending = new Set<string>()) => renderToStaticMarkup(createElement(ChannelRoomSettingsDialog, {
    channel: { connection: "connected", pending, roomOpenFailures: new Map(), messagesByRoom: {}, profiles: new Map() } as unknown as ChannelController,
    room, onClose() {}, async onDelete() {},
  }));
  const forms = render().match(/<form\b.*?<\/form>/g) ?? [];
  expect(forms).toHaveLength(2);
  const [identity, network] = forms;
  expect(identity).toContain('name="access"');
  expect(identity).not.toContain('name="relay-capacity"');
  expect(network).toContain('name="relay-capacity"');
  expect(network).toContain('name="audioBitrate"');
  expect(network).toContain('role="switch"');
  expect(network).not.toContain('name="access"');
  for (const form of forms) {
    expect(submitButton(form)).toHaveLength(1);
    expect(submitButton(form)?.[0]).not.toContain("disabled");
  }
  const pending = submitButton(render(new Set(["room:garden"])));
  expect(pending).toHaveLength(2);
  expect(pending?.every(button => button.includes("disabled"))).toBe(true);
});

test("unlisted admission keeps its form mounted and hidden while the room opens", () => {
  const roomId = "room";
  const render = (pending: Set<string>) => renderToStaticMarkup(createElement(ChannelUnlistedRoomEntry, {
    channel: { connection: "connected", pending } as unknown as ChannelController, roomId, onBack() {},
  }));
  const opening = render(new Set([`enter:${roomId}`]));
  expect(opening).toContain('<form hidden=""');
  expect(opening).toContain('role="status"');
  expect(submitButton(opening)).toHaveLength(1);
  expect(submitButton(opening)?.[0]).toContain("disabled");
  expect(render(new Set())).not.toContain('<form hidden=""');
});
