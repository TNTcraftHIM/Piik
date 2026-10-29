import { useEffect, useState } from "react";
import type { InteractionPayload } from "../../shared/protocol";
import { REACTION_IDS } from "../../shared/room-interactions";
import { createOpaqueId } from "../lib/opaque-id";
import { RoomInteractionSession } from "../lib/room-interactions";

/** A local participant and friend exercise the real interaction view, without signaling. */
export function usePreviewInteractions(viewer: boolean) {
  const [session, setSession] = useState<RoomInteractionSession | null>(null);
  useEffect(() => {
    const sender = viewer
      ? { peerId: "preview-friend", role: "viewer" as const, displayName: "Silip friend" }
      : { peerId: "preview-host", role: "host" as const, displayName: "Silip" };
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
  }, [viewer]);
  const receiveSample = (payload: InteractionPayload) => session?.receive({
    type: "room-interaction", id: createOpaqueId(), requestId: createOpaqueId(), occurredAt: Date.now(),
    sender: viewer ? { peerId: "preview-host", role: "host", displayName: "Silip" }
      : { peerId: "preview-friend", role: "viewer", displayName: "Silip friend" }, payload,
  });
  return { session, receiveSample };
}
