import { useSyncExternalStore } from "react";
import type { RoomVoiceSession } from "./session";

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function useRoomVoiceSnapshot(session?: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null) {
  return useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot, noSnapshot);
}

export function useRoomVoiceState(session?: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null) {
  const snapshot = useRoomVoiceSnapshot(session);
  return snapshot?.connected ? snapshot.room : null;
}
