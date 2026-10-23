import { useEffect, useState, useSyncExternalStore } from "react";
import type { RoomVoiceSession, RoomVoiceSnapshot } from "./session";
import type { VoiceConnectionMetric } from "./browser-endpoint";

const noSubscription = () => () => {};
const noSnapshot = () => null;

export function useRoomVoiceSnapshot(session?: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null) {
  return useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? noSnapshot, noSnapshot);
}

export function useRoomVoiceState(session?: Pick<RoomVoiceSession, "subscribe" | "getSnapshot"> | null) {
  const snapshot = useRoomVoiceSnapshot(session);
  return snapshot?.connected ? snapshot.room : null;
}

export function useRoomVoiceMetrics(session: Pick<RoomVoiceSession, "endpoint"> | null | undefined, enabled: boolean, room: RoomVoiceSnapshot["room"]): readonly VoiceConnectionMetric[] {
  const [sample, setSample] = useState<{ session: typeof session; metrics: readonly VoiceConnectionMetric[] } | null>(null);
  useEffect(() => {
    setSample(null);
    if (!session || !enabled) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const collect = async () => {
      try {
        const metrics = await session.endpoint.connectionMetrics();
        if (current) setSample({ session, metrics });
      } catch {
        if (current) setSample(null);
      } finally {
        if (current) timer = setTimeout(() => void collect(), 1_000);
      }
    };
    void collect();
    return () => { current = false; clearTimeout(timer); };
  }, [session, enabled]);
  return enabled && room?.enabled && sample && sample.session === session
    ? sample.metrics.filter(item => room.connections.some(connection => !connection.pending && connection.connectionId === item.connectionId))
    : [];
}
