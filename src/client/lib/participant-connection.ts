import type { MediaRouteUpstream, RoomVoiceState } from "../../shared/protocol";

interface Participant {
  peerId?: string;
  upstream: MediaRouteUpstream;
  mediaReady?: boolean;
}

// Picture readiness stays a picture fact. A committed voice facet can keep the
// room route connected before sharing starts and after it ends.
export function participantConnection(participant: Participant, pictureActive: boolean, voice?: RoomVoiceState | null) {
  if (participant.mediaReady) return { upstream: participant.upstream, ready: true, medium: "picture" as const };
  const member = voice?.enabled ? voice.members.find(member => member.peerId === participant.peerId && member.connected) : undefined;
  if (member && member.upstream.kind !== "none") {
    return { upstream: member.upstream, ready: true, medium: "voice" as const };
  }
  // An unready assignment is not media demand after its picture has stopped.
  const upstream: MediaRouteUpstream = pictureActive ? participant.upstream : { kind: "none" };
  return { upstream, ready: false,
    medium: pictureActive ? "picture" as const : member?.joined ? "voice" as const : null };
}
