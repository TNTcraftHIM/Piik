import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { RoomForm } from "../src/client/channel/components/ChannelRoomControls";
import { ChannelUnlistedRoomEntry } from "../src/client/channel/components/ChannelRoomEntry";
import { protectRoomComposition } from "../src/client/channel/components/room-form-interaction";
import { roomDraft } from "../src/client/channel/room-creation";
import type { ChannelController } from "../src/client/channel/types";

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

test("creation and edits give native form submission a single action with the same pending state", () => {
  const props = {
    inviteOnly: false, disabled: false, busy: false, value: { ...roomDraft(), name: "Garden" },
    imageBusy: false, onImageBusyChange() {}, onChange() {}, async onSave() {}, onCancel() {},
  };
  const render = (busy: boolean, name = props.value.name) =>
    renderToStaticMarkup(createElement(RoomForm, { ...props, busy, value: { ...props.value, name } }));
  const ready = submitButton(render(false));
  expect(ready).toHaveLength(1);
  expect(ready?.[0]).not.toContain("disabled");
  expect(submitButton(render(true))?.[0]).toContain("disabled");
  expect(submitButton(render(false, " "))?.[0]).toContain("disabled");
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
