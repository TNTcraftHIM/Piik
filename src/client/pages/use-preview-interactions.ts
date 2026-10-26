import { RoomControlSession } from "../lib/room-control";
import type { RoomControlState } from "../../shared/protocol";
import { useEffect, useState } from "react";
import type { InteractionPayload } from "../../shared/protocol";
import { REACTION_IDS } from "../../shared/room-interactions";
import { createOpaqueId } from "../lib/opaque-id";
import { RoomInteractionSession } from "../lib/room-interactions";

/** A local participant and friend exercise the real interaction view, without signaling. */
export function usePreviewInteractions(viewer: boolean) {
  const [control, setControl] = useState<RoomControlSession | null>(null);
  const [session, setSession] = useState<RoomInteractionSession | null>(null);
  useEffect(() => {
    const sender = viewer
      ? { peerId: "preview-friend", role: "viewer" as const, displayName: "Piik friend" }
      : { peerId: "preview-host", role: "host" as const, displayName: "Piik" };
    const model = new RoomInteractionSession(message => {
      queueMicrotask(() => {
        if (message.type === "subscribe-room-interactions") model.receive({ type: "room-interactions-ready", serverTime: Date.now() });
        if (message.type === "send-room-interaction") model.receive({ type: "room-interaction", id: createOpaqueId(),
          requestId: message.requestId, occurredAt: Date.now(), sender, payload: message.payload });
      });
      return true;
    }, Date.now, REACTION_IDS);
    const controlState: RoomControlState = { type: "room-control-state", codeEntryPolicy: "open", viewerPasswordEnabled: false, ownerPeerId: "preview-host", presenterPeerId: "preview-host", shareGeneration: null,
      members: [{ peerId: "preview-host", sharingAllowed: true, supported: true }, { peerId: "preview-friend", sharingAllowed: false, supported: true }],
      transfer: viewer ? { id: "preview-transfer", fromPeerId: "preview-host", targetPeerId: "preview-friend" } : null };
    const controls = new RoomControlSession("9527", message => {
      if (message.type === "room-control-command") queueMicrotask(() => {
        const command = message.command;
        if (command.action === "grant-sharing") controlState.members = controlState.members.map(member => member.peerId === command.peerId ? { ...member, sharingAllowed: command.allowed } : member);
        if (command.action === "transfer-owner") controlState.transfer = { id: "preview-transfer", fromPeerId: "preview-host", targetPeerId: command.peerId };
        if (command.action === "cancel-transfer" || command.action === "decline-transfer") controlState.transfer = null;
        controls.receive({ ...controlState });
      });
      return true;
    });
    controls.accept = async () => { controlState.ownerPeerId = sender.peerId; controlState.transfer = null; controls.receive({ ...controlState }); };
    controls.authenticated(sender.peerId); controls.receive(controlState); setControl(controls);
    model.authenticated(sender.peerId);
    setSession(model);
    return () => model.close();
  }, [viewer]);
  const receiveSample = (payload: InteractionPayload) => session?.receive({
    type: "room-interaction", id: createOpaqueId(), requestId: createOpaqueId(), occurredAt: Date.now(),
    sender: viewer ? { peerId: "preview-host", role: "host", displayName: "Piik" }
      : { peerId: "preview-friend", role: "viewer", displayName: "Piik friend" }, payload,
  });
  return { session, control, receiveSample };
}
