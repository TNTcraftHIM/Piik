import type { MediaRouteUpstream, RoomVoiceState } from "../../shared/protocol";

interface Participant {
  peerId?: string;
  upstream: MediaRouteUpstream;
  mediaReady?: boolean;
}

// Picture readiness stays a picture fact. A committed voice facet can keep the
// room route connected before sharing starts and after it ends.
export function participantConnection(participant: Participant, voice?: RoomVoiceState | null) {
  if (participant.mediaReady) return { upstream: participant.upstream, ready: true, medium: "picture" as const };
  const member = voice?.enabled ? voice.members.find(member => member.peerId === participant.peerId && member.connected) : undefined;
  if (member?.joined && member.upstream.kind !== "none") {
    return { upstream: member.upstream, ready: true, medium: "voice" as const };
  }
  return { upstream: participant.upstream, ready: false,
    medium: participant.upstream.kind !== "none" ? "picture" as const : member?.joined ? "voice" as const : null };
}
