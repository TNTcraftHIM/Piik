import type { RoomVoiceState } from "../../shared/protocol";
import type { PawnVoice } from "../components/living/Pawn";
import type { CopyKey } from "../ui/copy";
import type { GlyphName } from "../ui/icons";

/** One reading of the room's member snapshot for the couch and voice roster. */
export function describeVoiceParticipant(member?: RoomVoiceState["members"][number]): {
  appearance?: PawnVoice; label: CopyKey; icon: GlyphName;
} {
  if (!member?.connected) return { label: "voice.offline", icon: "wifiOff" };
  if (!member.joined) return { label: "voice.outside", icon: "door" };
  const microphone = Boolean(member.publicationId);
  return { appearance: { microphone, deafened: member.deafened },
    label: microphone ? "voice.microphoneActive" : "voice.microphoneInactive",
    icon: microphone ? "microphone" : "microphoneOff" };
}
