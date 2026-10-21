import { useEffect, useMemo, useState } from "react";
import { RoomVoiceControls, RoomVoicePanel, RoomVoiceSettings, type RoomVoiceView } from "../room-voice/RoomVoicePanel";
import type { RoomVoiceSnapshot } from "../room-voice/session";
import type { RoomVoiceCommand } from "../../shared/protocol";

const names = new Map([["preview-host", "Piik"], ["preview-friend", "Piik friend"]]);
function initialState(viewer: boolean): RoomVoiceSnapshot {
  return { peerId: viewer ? "preview-friend" : "preview-host", role: viewer ? "viewer" : "host", connected: true,
    microphone: false, capturePending: false, deafened: false, autoplayBlocked: false, error: null, muted: new Set(),
    input: { deviceId: "", volume: 1, voiceProcessing: true },
    room: { type: "room-voice-state", revision: 1, enabled: true, hostPeerId: "preview-host", publications: [], connections: [], unavailable: [],
      members: [
        { peerId: "preview-host", connected: true, joined: true, upstream: { kind: "none" } },
        { peerId: "preview-friend", connected: true, joined: viewer, upstream: viewer ? { kind: "peer", peerId: "preview-host" } : { kind: "none" } },
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
      if (command.action === "join" || command.action === "leave") {
        const joined = command.action === "join";
        setState(current => ({ ...current, microphone: joined && current.microphone,
          room: current.room && { ...current.room,
            enabled: current.role === "host" ? joined : current.room.enabled,
            members: current.room.members.map(member => member.peerId === current.peerId || current.role === "host" && !joined
              ? { ...member, joined, publicationId: undefined } : member),
          },
        }));
      }
      return true;
    };
    return {
      subscribe: () => () => {}, getSnapshot: () => snapshot, command, resumeAudio: () => {},
      startMicrophone: async () => { setState(current => ({ ...current, microphone: true })); },
      stopMicrophone: () => setState(current => ({ ...current, microphone: false })),
      deafen: deafened => setState(current => ({ ...current, deafened })),
      configureInput: async patch => { setState(current => ({ ...current, input: { ...current.input, ...patch } })); },
      setVolume: volume => setState(current => ({ ...current, input: { ...current.input, volume } })),
      activity: async () => new Map([[state.peerId, state.microphone ? .12 : 0]]),
      microphones: async () => [{ id: "headset", label: "USB Headset" }, { id: "desk", label: "Desk Microphone" }],
      muteVoice: peerId => setState(current => {
        const muted = new Set(current.muted);
        if (muted.has(peerId)) muted.delete(peerId); else muted.add(peerId);
        return { ...current, muted };
      }),
    };
  }, [state]);
  return { controls: <RoomVoiceControls session={session} />,
    settings: <RoomVoiceSettings session={session} />,
    content: (onSelect: (peerId: string, trigger: HTMLButtonElement) => void, onSettings: () => void) =>
      <RoomVoicePanel session={session} names={names} onSelectParticipant={onSelect} onSettings={onSettings} /> };
}
