import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceShortcuts } from "../src/client/channel/use-voice-shortcuts";
import {
  releasesVoiceShortcut, voiceShortcutDefaults, voiceShortcutsWithDefaults, type VoiceShortcutBinding,
} from "../src/client/channel/voice-shortcut-binding";

afterEach(() => vi.unstubAllGlobals());

const chord = (key: string): VoiceShortcutBinding => ({ key, ctrl: true, alt: false, shift: true, meta: false });

describe("voice shortcut bindings", () => {
  it("adds the talk default to stored bindings unless another action already holds its chord", () => {
    expect(voiceShortcutsWithDefaults(false, {})).toEqual(voiceShortcutDefaults(false));
    expect(voiceShortcutsWithDefaults(false, { microphone: chord("Q"), listening: null })).toEqual({
      microphone: chord("Q"), listening: null, talk: chord("V") });
    expect(voiceShortcutsWithDefaults(false, { microphone: chord("M"), listening: chord("V") }).talk).toBeNull();
    expect(voiceShortcutsWithDefaults(true, { talk: null }).talk).toBeNull();
  });

  it("ends a held chord when its key or one of its modifiers comes up", () => {
    expect(releasesVoiceShortcut(chord("V"), { key: "v" })).toBe(true);
    expect(releasesVoiceShortcut(chord("V"), { key: "Shift" })).toBe(true);
    expect(releasesVoiceShortcut(chord("V"), { key: "Control" })).toBe(true);
    expect(releasesVoiceShortcut(chord("V"), { key: "Alt" })).toBe(false);
    expect(releasesVoiceShortcut(chord("V"), { key: "M" })).toBe(false);
  });
});

function page() {
  const view = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
  const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: view, hidden: false, hasFocus: () => true, activeElement: null });
  Object.assign(view, { document: doc });
  vi.stubGlobal("window", view); vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { view, doc };
}

const editor = { nodeType: 1, isContentEditable: false, closest: (selector: string) => selector.includes("textarea") };

function key(type: "keydown" | "keyup", value: string, { repeat = false, path = [] as unknown[] } = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    key: value, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat,
    isComposing: false, keyCode: 0, getModifierState: () => false, composedPath: () => path,
  });
}

async function dock(props: { room?: string; talk?: (pressed: boolean) => void }) {
  const { view, doc } = page();
  const toggle = vi.fn(() => true);
  let shortcuts!: ReturnType<typeof useVoiceShortcuts>;
  function Dock({ room = "room", talk }: { room?: string; talk?: (pressed: boolean) => void }) {
    shortcuts = useVoiceShortcuts(room, toggle, undefined, talk);
    return null;
  }
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument: doc }) as unknown as HTMLElement);
  await act(async () => root.render(createElement(Dock, props)));
  const press = async (event: Event) => { await act(async () => { doc.dispatchEvent(event); }); return event; };
  return { view, doc, toggle, press, current: () => shortcuts,
    render: (next: typeof props) => act(async () => root.render(createElement(Dock, next))),
    unmount: () => act(async () => root.unmount()) };
}

describe("push-to-talk shortcut", () => {
  it("holds from key down to key up and ignores repeats", async () => {
    const talk = vi.fn();
    const { press, toggle, current, unmount } = await dock({ talk });
    try {
      expect((await press(key("keydown", "V"))).defaultPrevented).toBe(true);
      expect(talk.mock.calls).toEqual([[true]]);
      expect(current().talking).toBe(true);
      await press(key("keydown", "V", { repeat: true }));
      await press(key("keyup", "M"));
      expect(talk.mock.calls).toEqual([[true]]);
      await press(key("keyup", "v"));
      expect(talk.mock.calls).toEqual([[true], [false]]);
      expect(current().talking).toBe(false);
      await press(key("keyup", "v"));
      expect(talk).toHaveBeenCalledTimes(2);

      // Letting go of a modifier first also releases.
      await press(key("keydown", "V"));
      await press(key("keyup", "Shift"));
      expect(talk.mock.calls.slice(2)).toEqual([[true], [false]]);
      // The toggles keep their own path.
      await press(key("keydown", "M"));
      expect(toggle).toHaveBeenCalledWith("microphone");
      expect(talk).toHaveBeenCalledTimes(4);
    } finally { await unmount(); }
  });

  it.each([
    ["the window loses focus", ({ view }: { view: EventTarget }) => view.dispatchEvent(new Event("blur"))],
    ["the page becomes hidden", ({ doc }: { doc: EventTarget & { hidden: boolean } }) => { doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange")); }],
    ["the page is frozen", ({ doc }: { doc: EventTarget }) => doc.dispatchEvent(new Event("freeze"))],
  ])("releases when %s, so a lost key-up cannot leave the microphone open", async (_case, lose) => {
    const talk = vi.fn();
    const fixture = await dock({ talk });
    try {
      await fixture.press(key("keydown", "V"));
      await act(async () => { lose(fixture); });
      expect(talk.mock.calls).toEqual([[true], [false]]);
      expect(fixture.current().talking).toBe(false);
    } finally { await fixture.unmount(); }
  });

  it("ignores the chord while an editor has the keyboard, but still releases there", async () => {
    const talk = vi.fn();
    const { press, unmount } = await dock({ talk });
    try {
      expect((await press(key("keydown", "V", { path: [editor] }))).defaultPrevented).toBe(false);
      expect(talk).not.toHaveBeenCalled();
      await press(key("keydown", "V"));
      await press(key("keyup", "V", { path: [editor] }));
      expect(talk.mock.calls).toEqual([[true], [false]]);
    } finally { await unmount(); }
  });

  it("does nothing outside push to talk, and releases when the mode or the room changes while held", async () => {
    const talk = vi.fn();
    const fixture = await dock({});
    try {
      expect((await fixture.press(key("keydown", "V"))).defaultPrevented).toBe(false);
      expect(fixture.current().talking).toBe(false);

      await fixture.render({ talk });
      await fixture.press(key("keydown", "V"));
      expect(fixture.current().talking).toBe(true);
      await fixture.render({});
      expect(fixture.current().talking).toBe(false);

      await fixture.render({ talk });
      await fixture.press(key("keydown", "V"));
      await fixture.render({ talk, room: "other" });
      expect(talk.mock.calls).toEqual([[true], [true], [false]]);
      expect(fixture.current().talking).toBe(false);
    } finally { await fixture.unmount(); }
  });
});
