import { afterEach, expect, it, vi } from "vitest";
import { readRoomPreferences, saveRoomPreferences } from "../src/client/lib/room-preferences";
import { RoomInteractionSession } from "../src/client/lib/room-interactions";
import { FEEDBACK_CLIP_MAX_BYTES } from "../src/client/channel/feedback-clip";

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  return values;
}

it("keeps independent room-tool choices across reads without storing private runtime fields", () => {
  const values = storage();
  expect(readRoomPreferences().previewAutoPause).toBe(true);
  expect(readRoomPreferences().roomLayout).toBeUndefined();
  expect(readRoomPreferences().remoteTouchMode).toBe("direct");
  saveRoomPreferences({ roomLayout: "minimal", pictureFit: "cover", pictureRotation: 270, previewAutoPause: false, keyboardPage: "text", combineKeys: true });
  saveRoomPreferences({ remoteControlMode: "password", remoteReleaseKey: 9, remoteStopKey: 8, remoteTouchMode: "trackpad",
    voiceListeningVolume: 1.5, voiceInput: { deviceId: "", volume: 2, voiceProcessing: true } });
  expect(readRoomPreferences()).toMatchObject({ roomLayout: "minimal", pictureFit: "cover", pictureRotation: 270, previewAutoPause: false, keyboardPage: "text",
    combineKeys: true, remoteControlMode: "password", remoteReleaseKey: 9, remoteStopKey: 8, remoteTouchMode: "trackpad",
    voiceListeningVolume: 1.5, voiceInput: { deviceId: "", volume: 2, voiceProcessing: true } });

  // Storage accepts only the preference contract, even if a caller supplies a
  // room snapshot with credentials, text or actual held input by mistake.
  saveRoomPreferences(Object.assign({ overlayEnabled: true }, {
    password: "private", grant: "private", text: "private", modifiers: ["ControlLeft"], controller: "other-peer",
  }));
  const saved = JSON.parse([...values.values()][0]);
  expect(saved.overlayEnabled).toBe(true);
  expect(saved.remoteControlMode).toBe("password");
  for (const field of ["password", "grant", "text", "modifiers", "controller"]) expect(saved).not.toHaveProperty(field);
  expect([...values.values()][0]).not.toContain("private");
  expect(readRoomPreferences().pictureFit).toBe("cover");
  saveRoomPreferences(JSON.parse('{"remoteTouchMode":"unknown"}'));
  expect(readRoomPreferences().remoteTouchMode).toBe("trackpad");
  values.set("piik:room-preferences:v1", JSON.stringify({ pictureFit: "cover", pictureRotation: 45 }));
  expect(readRoomPreferences()).toMatchObject({ pictureFit: "cover", pictureRotation: 0, remoteTouchMode: "direct" });
  values.set("piik:room-preferences:v1", JSON.stringify({ overlayAppearance: { scale: 1.2, opacity: .7 } }));
  expect(readRoomPreferences().overlayAppearance).toEqual({ scale: 1.2, opacity: .7, speed: 1, colorBySender: false });
});

it("isolates nested preferences across reads and observes external edits after a failed write", () => {
  const values = storage();
  const key = "piik:room-preferences:v1";
  const clip = { name: "short.wav", data: "AAAA" };
  values.set(key, JSON.stringify({ feedbackSound: { enabled: true, volume: .5, clips: { message: clip } } }));
  readRoomPreferences().feedbackSound.clips!.message!.name = "first edit";
  readRoomPreferences().feedbackSound.clips!.message!.name = "second edit";
  expect(readRoomPreferences().feedbackSound.clips?.message).toEqual(clip);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota full"); });
  expect(saveRoomPreferences({ pictureFit: "cover" })).toBe(false);
  expect(readRoomPreferences().pictureFit).toBe("contain");
  values.set(key, JSON.stringify({ pictureFit: "fill" }));
  expect(readRoomPreferences().pictureFit).toBe("fill");
  values.delete(key);
  expect(readRoomPreferences().pictureFit).toBe("contain");
});

it("keeps layout undecided until an explicit choice, independently of other preferences", () => {
  const values = storage();
  expect(saveRoomPreferences({ feedbackSound: { enabled: true, volume: .5 } })).toBe(true);
  expect(readRoomPreferences().roomLayout).toBeUndefined();
  expect(JSON.parse(values.get("piik:room-preferences:v1")!)).not.toHaveProperty("roomLayout");
  for (const layout of ["full", "minimal"] as const) {
    expect(saveRoomPreferences({ roomLayout: layout })).toBe(true);
    expect(saveRoomPreferences({ overlayEnabled: true })).toBe(true);
    expect(readRoomPreferences().roomLayout).toBe(layout);
    expect(JSON.parse(values.get("piik:room-preferences:v1")!).roomLayout).toBe(layout);
  }
});

it.each(["workspace", "quick"])("retires the %s layout while retaining independent preferences", retired => {
  const values = storage();
  const key = "piik:room-preferences:v1";
  const retained = { roomListFolded: true, pictureFit: "cover", voiceListeningVolume: .6 };
  values.set(key, JSON.stringify({ interfaceLayout: retired, sharingView: true, ...retained }));
  expect(readRoomPreferences()).toMatchObject(retained);
  expect(readRoomPreferences().roomLayout).toBeUndefined();
  expect(saveRoomPreferences({ roomLayout: "minimal" })).toBe(true);
  const written = JSON.parse(values.get(key)!);
  expect(written).toMatchObject({ ...retained, roomLayout: "minimal" });
  expect(written).not.toHaveProperty("interfaceLayout");
  expect(written).not.toHaveProperty("sharingView");
});

it("adds stick defaults to existing preferences and persists only normalized positions", () => {
  const values = storage();
  const previous = { roomLayout: "minimal", pictureFit: "cover", remoteTouchMode: "trackpad" };
  values.set("piik:room-preferences:v1", JSON.stringify(previous));
  expect(readRoomPreferences()).toMatchObject({
    ...previous, virtualSticksEnabled: true, stickPositions: {}, touchOnlySticks: false,
  });

  const sticks = {
    virtualSticksEnabled: false,
    stickPositions: { left: { x: 0, y: .25 }, right: { x: 1, y: .75 } },
    touchOnlySticks: true,
  };
  expect(saveRoomPreferences(sticks)).toBe(true);
  expect(saveRoomPreferences({ stickPositions: { left: { x: 1.1, y: 0 } } })).toBe(false);
  expect(saveRoomPreferences({ stickPositions: { right: { x: 1, y: -.1 } } })).toBe(false);
  expect(readRoomPreferences()).toMatchObject({ ...previous, ...sticks });
});

it("rejects malformed saved data and invalid patches while retaining useful defaults", () => {
  const values = storage();
  const defaults = readRoomPreferences();
  saveRoomPreferences({ remoteControlMode: "room" });
  const [key] = [...values.keys()];
  saveRoomPreferences(JSON.parse('{"remoteControlMode":"off"}'));
  expect(readRoomPreferences().remoteControlMode).toBe("room");
  for (const raw of ["{", "null", JSON.stringify({ overlayAppearance: { scale: 100, opacity: 0 } }), JSON.stringify({ remoteTouchMode: "unknown" })]) {
    values.set(key, raw);
    expect(readRoomPreferences()).toEqual(defaults);
  }
});

it("restores overlay choices in a new room without restoring messages or room authority", () => {
  storage();
  const first = new RoomInteractionSession(() => true);
  first.setOverlayEnabled(true);
  first.setOverlayAppearance({ scale: 100, opacity: -1, speed: .8, colorBySender: true });
  first.close();
  const next = new RoomInteractionSession(() => true);
  expect(next.getSnapshot()).toMatchObject({ overlayEnabled: true, overlayAppearance: { scale: 1.3, opacity: .4, speed: .8, colorBySender: true },
    ready: false, peerId: null, messages: [], overlayMessages: [], reactions: [], pending: null });
  next.close();
});

it("keeps room tools working when Browser storage is unavailable", () => {
  vi.stubGlobal("window", { get localStorage() { throw new Error("storage denied"); } });
  expect(readRoomPreferences()).toMatchObject({ pictureFit: "contain", remoteControlMode: "ask", remoteTouchMode: "direct" });
  expect(() => saveRoomPreferences({ keyboardPage: "symbols" })).not.toThrow();
  const session = new RoomInteractionSession(() => true);
  session.setOverlayEnabled(true);
  session.setOverlayAppearance({ scale: 1.2, opacity: .5 });
  expect(session.getSnapshot()).toMatchObject({ overlayEnabled: true, overlayAppearance: { scale: 1.2, opacity: .5 } });
  session.close();
});

it("keeps bounded custom sounds with their preferences and reports a failed persistent write", () => {
  storage();
  const clip = { name: "short.wav", data: Buffer.alloc(FEEDBACK_CLIP_MAX_BYTES).toString("base64") };
  expect(saveRoomPreferences({ feedbackSound: { enabled: true, volume: .6, clips: { message: clip } } })).toBe(true);
  saveRoomPreferences({ pictureFit: "cover" });
  expect(readRoomPreferences().feedbackSound).toEqual({ enabled: true, volume: .6, clips: { message: clip } });
  expect(saveRoomPreferences({ feedbackSound: { enabled: true, volume: .6,
    clips: { message: { ...clip, data: Buffer.alloc(FEEDBACK_CLIP_MAX_BYTES + 1).toString("base64") } } } })).toBe(false);
  expect(readRoomPreferences().feedbackSound.clips?.message).toEqual(clip);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota full"); });
  expect(saveRoomPreferences({ feedbackSound: { enabled: true, volume: .6, clips: {} } })).toBe(false);
  expect(readRoomPreferences().feedbackSound.clips?.message).toEqual(clip);
});


it("adds the microphone mode to stored preferences that predate it, as open microphone", () => {
  const values = storage();
  const key = "piik:room-preferences:v1";
  const previous = { voiceInput: { deviceId: "saved", volume: .8, voiceProcessing: false }, voiceListeningVolume: 1.4, pictureFit: "cover" };
  values.set(key, JSON.stringify(previous));
  expect(readRoomPreferences()).toMatchObject({ ...previous, voiceTransmission: { mode: "open", activationThreshold: -40 } });
  expect(saveRoomPreferences({ voiceTransmission: { mode: "activity", activationThreshold: -52 } })).toBe(true);
  expect(readRoomPreferences()).toMatchObject({ ...previous, voiceTransmission: { mode: "activity", activationThreshold: -52 } });
  // A value this version cannot use falls back on its own, keeping the other choices.
  values.set(key, JSON.stringify({ ...previous, voiceTransmission: { mode: "whisper", activationThreshold: -52 } }));
  expect(readRoomPreferences()).toMatchObject({ ...previous, voiceTransmission: { mode: "open", activationThreshold: -40 } });
});

it("keeps voice shortcuts stored before the talk binding existed, and stores it once chosen", () => {
  const values = storage();
  const key = "piik:room-preferences:v1";
  const microphone = { key: "Q", ctrl: true, alt: false, shift: true, meta: false };
  values.set(key, JSON.stringify({ voiceShortcuts: { microphone, listening: null } }));
  expect(readRoomPreferences().voiceShortcuts).toEqual({ microphone, listening: null });
  expect(saveRoomPreferences({ voiceShortcuts: { microphone, listening: null, talk: { ...microphone, key: "T" } } })).toBe(true);
  expect(readRoomPreferences().voiceShortcuts.talk).toEqual({ ...microphone, key: "T" });
  expect(saveRoomPreferences({ voiceShortcuts: { microphone, listening: null, talk: null } })).toBe(true);
  expect(readRoomPreferences().voiceShortcuts.talk).toBeNull();
});

it("persists the total screen buffer target independently, including zero and automatic", () => {
  storage();
  expect(readRoomPreferences().screenBufferTargetMs).toBeNull();
  for (const target of [300, 0, 4000, null]) {
    expect(saveRoomPreferences({ screenBufferTargetMs: target })).toBe(true);
    expect(readRoomPreferences().screenBufferTargetMs).toBe(target);
  }
  expect(saveRoomPreferences({ screenBufferTargetMs: 4001 })).toBe(false);
  expect(readRoomPreferences().screenBufferTargetMs).toBeNull();
});
