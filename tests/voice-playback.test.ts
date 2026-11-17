import { expect, test } from "vitest";
import { voicePlaybackPublications } from "../src/client/channel/use-voice-playback";
import { listeningVoicePublications } from "../src/client/channel/presentation";
import type { ChannelPublication, ChannelSnapshot } from "../src/client/channel/protocol";

function fixture() {
  const publications: ChannelPublication[] = ["a", "b"].map(roomId => ({ id: `voice-${roomId}`, kind: "voice",
    roomId, sessionId: "speaker", userId: "friend", audience: [], paused: false }));
  const state = { publications, voice: ["a", "b"].flatMap(roomId => [
    { roomId, sessionId: "listener", muted: true, deafened: false },
    { roomId, sessionId: "speaker", muted: false, deafened: true },
  ]), subscriptions: publications.map(publication => publication.id) } as ChannelSnapshot;
  const tracks = new Map(publications.map(publication => [publication.id,
    { id: `${publication.id}-track`, readyState: "live", muted: false, enabled: true } as MediaStreamTrack]));
  const streams = new Map(publications.map(publication => [publication.id,
    { getAudioTracks: () => [tracks.get(publication.id)!] } as MediaStream]));
  const ids = (previous: readonly string[] = []) => voicePlaybackPublications(state, "listener", streams, previous).map(publication => publication.id);
  return { state, tracks, streams, ids };
}

test("one listening output follows a source endpoint while each room keeps its voice controls", () => {
  const { state, streams, ids } = fixture();
  expect(listeningVoicePublications(state, "listener", streams).map(publication => publication.id)).toEqual(["voice-a", "voice-b"]);
  // Our muted microphone and the sender's deafened listening do not silence their speech.
  expect(ids()).toEqual(["voice-a"]);
  state.publications.push({ ...state.publications[0], id: "other-endpoint", sessionId: "another-speaker" });
  state.voice.push({ roomId: "a", sessionId: "another-speaker", muted: false, deafened: false });
  state.subscriptions.push("other-endpoint"); streams.set("other-endpoint", streams.get("voice-b")!);
  expect(ids()).toEqual(["voice-a", "other-endpoint"]); // Same user, different microphone owner.
  expect(state.subscriptions).toEqual(["voice-a", "voice-b", "other-endpoint"]);
});

test("an eligible output stays selected across reordering and a sibling becoming available", () => {
  const { state, tracks, ids } = fixture();
  expect(ids(["voice-b"])).toEqual(["voice-b"]);
  state.publications.reverse();
  expect(ids(["voice-a"])).toEqual(["voice-a"]);
  Object.defineProperty(tracks.get("voice-a"), "muted", { configurable: true, value: true });
  expect(ids(["voice-a"])).toEqual(["voice-b"]);
  Object.defineProperty(tracks.get("voice-a"), "muted", { value: false });
  expect(ids(["voice-b"])).toEqual(["voice-b"]);
});

test("sender room mute, listener room deafen and leave exclude only that room's output", () => {
  const { state, ids } = fixture();
  state.voice.find(voice => voice.sessionId === "speaker" && voice.roomId === "a")!.muted = true;
  expect(ids(["voice-a"])).toEqual(["voice-b"]);
  state.voice.find(voice => voice.sessionId === "speaker" && voice.roomId === "a")!.muted = false;
  state.voice.find(voice => voice.sessionId === "listener" && voice.roomId === "a")!.deafened = true;
  expect(ids(["voice-a"])).toEqual(["voice-b"]);
  state.voice = state.voice.filter(voice => voice.sessionId !== "listener" || voice.roomId !== "b");
  expect(ids(["voice-b"])).toEqual([]);
  expect(state.subscriptions).toEqual(["voice-a", "voice-b"]);
});

test("selection requires the current live audio track rather than a retained or unready binding", () => {
  const { state, streams, tracks, ids } = fixture();
  const unready = { getAudioTracks: () => [{ readyState: "live", muted: true, enabled: true }] } as MediaStream;
  streams.set("voice-a", unready);
  expect(ids(["voice-a"])).toEqual(["voice-b"]);
  Object.defineProperty(tracks.get("voice-b"), "readyState", { value: "ended" });
  expect(ids(["voice-b"])).toEqual([]);
  streams.set("voice-a", { getAudioTracks: () => [] } as unknown as MediaStream);
  expect(ids()).toEqual([]);
  streams.set("voice-a", { getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true }] } as MediaStream);
  state.publications[0].paused = true;
  expect(ids()).toEqual([]);
  state.publications[0].paused = false;
  expect(ids()).toEqual(["voice-a"]);
});
