import type { ServerMessage } from "../../shared/protocol";
import type { SignalingClient } from "./signaling";
import type { HostAudio } from "../media/host-audio";
import type { BrowserVideoCodecPreference } from "../webrtc/video-codec";

export interface PreparedPresentation { stream: MediaStream; audio: HostAudio; codec: BrowserVideoCodecPreference }
export function disposePreparedPresentation(prepared: PreparedPresentation) {
  prepared.stream.getTracks().forEach(track => track.stop());
  prepared.audio.sourceStream.getTracks().forEach(track => track.stop());
  prepared.audio.dispose();
}
export interface RoomHandoff {
  signal: SignalingClient;
  state: Extract<ServerMessage, { type: "authenticated" }>;
  prepared: PreparedPresentation | null;
  key: number;
}
let handoff: RoomHandoff | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
export const roomHandoffSnapshot = () => handoff;
export const subscribeRoomHandoff = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function handOffRoom(signal: SignalingClient, state: RoomHandoff["state"], prepared: PreparedPresentation | null) {
  handoff = { signal, state, prepared, key: ++sequence };
  listeners.forEach(listener => listener());
}
