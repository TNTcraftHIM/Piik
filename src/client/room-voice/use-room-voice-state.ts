import { useSyncExternalStore } from "react";
import type { RoomVoiceSession } from "./session";

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function useRoomVoiceState(session?: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null) {
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot, noSnapshot);
  return snapshot?.connected ? snapshot.room : null;
}
