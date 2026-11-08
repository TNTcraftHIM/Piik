import { useEffect, useState } from "react";
import type { InteractionPayload } from "../../shared/protocol";
import { REACTION_IDS } from "../../shared/room-interactions";
import { createOpaqueId } from "../lib/opaque-id";
import { RoomInteractionSession } from "../lib/room-interactions";

/** A local participant and friend exercise the real interaction view, without signaling. */
export function usePreviewInteractions(viewer: boolean, people?: {
  self: { peerId: string; displayName: string }; friend: { peerId: string; displayName: string };
}) {
  const [session, setSession] = useState<RoomInteractionSession | null>(null);
  const selfId = people?.self.peerId ?? (viewer ? "preview-friend" : "preview-host");
  const selfName = people?.self.displayName ?? (viewer ? "Piik friend" : "Piik");
  const friendId = people?.friend.peerId ?? (viewer ? "preview-host" : "preview-friend");
  const friendName = people?.friend.displayName ?? (viewer ? "Piik" : "Piik friend");
  useEffect(() => {
    const sender = { peerId: selfId, role: viewer ? "viewer" as const : "host" as const, displayName: selfName };
    const model = new RoomInteractionSession(message => {
      queueMicrotask(() => {
        if (message.type === "subscribe-room-interactions") model.receive({ type: "room-interactions-ready", serverTime: Date.now() });
        if (message.type === "send-room-interaction") model.receive({ type: "room-interaction", id: createOpaqueId(),
          requestId: message.requestId, occurredAt: Date.now(), sender, payload: message.payload });
      });
      return true;
    }, Date.now, REACTION_IDS);
    model.authenticated(sender.peerId);
    setSession(model);
    return () => model.close();
  }, [viewer, selfId, selfName]);
  const receiveSample = (payload: InteractionPayload) => session?.receive({
    type: "room-interaction", id: createOpaqueId(), requestId: createOpaqueId(), occurredAt: Date.now(),
    sender: { peerId: friendId, role: viewer ? "host" : "viewer", displayName: friendName }, payload,
  });
  return { session, receiveSample };
}
