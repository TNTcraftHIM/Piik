import { useEffect, useMemo, useState } from "react";
import { RoomVoiceControls, RoomVoicePanel, type RoomVoiceView } from "../room-voice/RoomVoicePanel";
import type { RoomVoiceSnapshot } from "../room-voice/session";
import type { RoomVoiceCommand } from "../../shared/protocol";

const names = new Map([["preview-host", "Piik"], ["preview-friend", "Piik friend"]]);
function initialState(viewer: boolean): RoomVoiceSnapshot {
  return { peerId: viewer ? "preview-friend" : "preview-host", role: viewer ? "viewer" : "host", connected: true,
    microphone: false, capturePending: false, deafened: false, autoplayBlocked: false, error: null, muted: new Set(),
    room: { type: "room-voice-state", revision: 1, hostPeerId: "preview-host", publications: [], connections: [], unavailable: [],
      members: [
        { peerId: "preview-host", connected: true, requested: true, listen: true, speak: true },
        { peerId: "preview-friend", connected: true, requested: true, listen: viewer, speak: viewer },
      ] },
  };
}

// The catalogue stages the real view without opening a microphone or transport.
export function useRoomVoicePreview(viewer: boolean) {
  const [state, setState] = useState(() => initialState(viewer));
  useEffect(() => setState(initialState(viewer)), [viewer]);
  const session = useMemo<RoomVoiceView>(() => {
    const snapshot: RoomVoiceSnapshot = { ...state, room: state.room && { ...state.room,
      members: state.room.members.map(member => member.peerId === state.peerId
        ? { ...member, publicationId: state.microphone ? "preview-publication" : undefined } : member),
    } };
    const command = (command: RoomVoiceCommand) => {
      setState(current => ({ ...current, microphone: command.action === "leave" ? false : current.microphone,
        room: current.room && { ...current.room, members: current.room.members.map(member => {
          if (member.peerId !== (command.action === "permission" ? command.peerId : current.peerId)) return member;
          if (command.action === "permission") return { ...member, listen: command.listen, speak: command.speak, requested: command.listen };
          if (command.action === "join" || command.action === "leave") {
            const joined = command.action === "join";
            return { ...member, requested: joined, listen: joined, speak: joined };
          }
          return member;
        }) },
      }));
      return true;
    };
    return {
      subscribe: () => () => {}, getSnapshot: () => snapshot, command, resumeAudio: () => {},
      startMicrophone: async () => { setState(current => ({ ...current, microphone: true })); },
      stopMicrophone: () => setState(current => ({ ...current, microphone: false })),
      deafen: deafened => setState(current => ({ ...current, deafened, microphone: deafened ? false : current.microphone })),
      muteVoice: peerId => setState(current => {
        const muted = new Set(current.muted);
        if (muted.has(peerId)) muted.delete(peerId); else muted.add(peerId);
        return { ...current, muted };
      }),
    };
  }, [state]);
  return { controls: <RoomVoiceControls session={session} />, content: <RoomVoicePanel session={session} names={names} /> };
}
