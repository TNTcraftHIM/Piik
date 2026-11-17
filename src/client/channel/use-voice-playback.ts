import { useEffect, useReducer, useState } from "react";
import { listeningVoicePublications } from "./presentation";
import type { ChannelPublication, ChannelSnapshot } from "./protocol";

/** A page's room publications borrow one microphone; other endpoints remain distinct. */
export function voicePlaybackPublications(state: ChannelSnapshot | null, sessionId: string | null,
  streams: ReadonlyMap<string, MediaStream>, previous: readonly string[] = []): ChannelPublication[] {
  if (!state) return [];
  const selected = new Map<string, ChannelPublication>();
  for (const publication of listeningVoicePublications(state, sessionId, streams)) {
    if (publication.paused || !state.voice.some(voice => voice.roomId === publication.roomId
      && voice.sessionId === publication.sessionId && !voice.muted)) continue;
    const track = streams.get(publication.id)?.getAudioTracks()[0];
    if (!track || track.readyState !== "live" || track.muted || !track.enabled) continue;
    if (!selected.has(publication.sessionId) || previous.includes(publication.id)) selected.set(publication.sessionId, publication);
  }
  return [...selected.values()];
}

/** Retain the current audible publication without choosing or changing any route. */
export function useVoicePlayback(state: ChannelSnapshot | null, sessionId: string | null, streams: ReadonlyMap<string, MediaStream>) {
  const [previous, setPrevious] = useState<readonly string[]>([]);
  const [trackRevision, changed] = useReducer(value => value + 1, 0);
  const publications = voicePlaybackPublications(state, sessionId, streams, previous);
  const selected = publications.map(publication => publication.id);
  if (selected.length !== previous.length || selected.some((id, index) => previous[index] !== id)) setPrevious(selected);
  useEffect(() => {
    const candidates = new Set(listeningVoicePublications(state, sessionId, streams).map(publication => streams.get(publication.id)!));
    const tracks = new Set([...candidates].flatMap(stream => stream.getAudioTracks()));
    for (const stream of candidates) {
      stream.addEventListener("addtrack", changed); stream.addEventListener("removetrack", changed);
    }
    for (const track of tracks) for (const event of ["mute", "unmute", "ended"]) track.addEventListener(event, changed);
    return () => {
      for (const stream of candidates) {
        stream.removeEventListener("addtrack", changed); stream.removeEventListener("removetrack", changed);
      }
      for (const track of tracks) for (const event of ["mute", "unmute", "ended"]) track.removeEventListener(event, changed);
    };
  }, [state?.voice, state?.publications, state?.subscriptions, sessionId, streams, trackRevision]);
  return publications;
}
