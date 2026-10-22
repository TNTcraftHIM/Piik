import { afterEach, expect, it, vi } from "vitest";
import { readRoomPreferences, saveRoomPreferences } from "../src/client/lib/room-preferences";
import { RoomInteractionSession } from "../src/client/lib/room-interactions";

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
  saveRoomPreferences({ pictureFit: "cover", pictureRotation: 270, routePreference: "p2p", keyboardPage: "text", combineKeys: true });
  saveRoomPreferences({ remoteControlMode: "password", remoteReleaseKey: 9, remoteStopKey: 8,
    voiceListeningVolume: 1.5, voiceInput: { deviceId: "", volume: 2, voiceProcessing: true } });
  expect(readRoomPreferences()).toMatchObject({ pictureFit: "cover", pictureRotation: 270, routePreference: "p2p", keyboardPage: "text",
    combineKeys: true, remoteControlMode: "password", remoteReleaseKey: 9, remoteStopKey: 8,
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
  values.set("piik:room-preferences:v1", JSON.stringify({ pictureFit: "cover", pictureRotation: 45 }));
  expect(readRoomPreferences()).toMatchObject({ pictureFit: "cover", pictureRotation: 0 });
  values.set("piik:room-preferences:v1", JSON.stringify({ overlayAppearance: { scale: 1.2, opacity: .7 } }));
  expect(readRoomPreferences().overlayAppearance).toEqual({ scale: 1.2, opacity: .7, speed: 1, colorBySender: false });
});

it("rejects malformed saved data and invalid patches while retaining useful defaults", () => {
  const values = storage();
  const defaults = readRoomPreferences();
  saveRoomPreferences({ remoteControlMode: "room" });
  const [key] = [...values.keys()];
  saveRoomPreferences(JSON.parse('{"remoteControlMode":"off"}'));
  expect(readRoomPreferences().remoteControlMode).toBe("room");
  for (const raw of ["{", "null", JSON.stringify({ overlayAppearance: { scale: 100, opacity: 0 } })]) {
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
  expect(readRoomPreferences()).toMatchObject({ pictureFit: "contain", routePreference: "auto", remoteControlMode: "ask" });
  expect(() => saveRoomPreferences({ keyboardPage: "symbols" })).not.toThrow();
  const session = new RoomInteractionSession(() => true);
  session.setOverlayEnabled(true);
  session.setOverlayAppearance({ scale: 1.2, opacity: .5 });
  expect(session.getSnapshot()).toMatchObject({ overlayEnabled: true, overlayAppearance: { scale: 1.2, opacity: .5 } });
  session.close();
});
