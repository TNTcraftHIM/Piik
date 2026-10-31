import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FloatingPanel } from "../../components/living/FloatingPanel";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { SurfaceDocument } from "../../ui/panel-window";
import "./channel-room-tool.css";

export interface RoomToolSurface { open: boolean; document: Document | null }
type Slots = { couch: RefObject<HTMLDivElement | null>; conversation: RefObject<HTMLDivElement | null>; voice: RefObject<HTMLDivElement | null> };
const parts = ["couch", "conversation", "voice"] as const;
function target() { const node = document.createElement("div"); node.style.display = "contents"; return node; }
function move(node: HTMLElement, parent: HTMLElement | null) {
  if (!parent || node.parentElement === parent) return;
  if (node.isConnected && parent.isConnected && node.ownerDocument === parent.ownerDocument && "moveBefore" in parent) {
    parent.moveBefore(node, null);
  } else parent.append(node);
}

/** Three page slots share one room tool without remounting their content. */
export function ChannelRoomTool({ title, home, surface, onSurfaceChange, couch, conversation, voice }: {
  title: string; home: Slots; surface: RoomToolSurface; onSurfaceChange: (surface: RoomToolSurface) => void;
  couch: ReactNode; conversation: ReactNode; voice: ReactNode;
}) {
  const { lang, vis } = useCopy();
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [targets] = useState(() => ({ couch: target(), conversation: target(), voice: target() }));
  const detached = Boolean(surface.document && surface.document !== document);
  const label = lang === "zh" ? "房间小窗" : "Room mini window";
  // The page's later slots must finish attaching before the first placement.
  useEffect(() => {
    for (const part of parts) move(targets[part], home[part].current);
    return () => { for (const part of parts) targets[part].remove(); };
  }, [targets, home.couch, home.conversation, home.voice]);
  return <>
    <Tooltip kind={detached ? "hint-window-detach" : "hint-chat-open"} disabled={surface.open} text={vis ? undefined : label}>
      <button ref={trigger} type="button" className="lr-btn is-compact is-quiet" aria-label={label}
        aria-haspopup="dialog" aria-expanded={surface.open} popoverTarget={detached ? undefined : id}
        onClick={detached ? () => surface.document?.defaultView?.focus() : undefined}>
        <Glyph name="couch" size={19} />{!vis && <span className="lr-cap">{lang === "zh" ? "小窗" : "Mini window"}</span>}
      </button>
    </Tooltip>
    <FloatingPanel id={id} trigger={trigger} title={title} icon="couch" detachable className="c3-room-tool"
      onOpenChange={(open, owner) => {
        const destination = open ? { couch: couchSlot, conversation: conversationSlot, voice: voiceSlot } : home;
        // Placement-dependent children must render against their new ancestry.
        for (const part of parts) move(targets[part], destination[part].current);
        onSurfaceChange({ open, document: owner });
      }}>
      <div ref={couchSlot} className="c3-room-slot" />
      <div ref={conversationSlot} className="c3-room-slot" />
      <div ref={voiceSlot} className="c3-room-slot" />
    </FloatingPanel>
    <SurfaceDocument.Provider value={surface.open ? surface.document : null}>
      {createPortal(couch, targets.couch)}
      {createPortal(conversation, targets.conversation)}
      {createPortal(voice, targets.voice)}
    </SurfaceDocument.Provider>
  </>;
}
