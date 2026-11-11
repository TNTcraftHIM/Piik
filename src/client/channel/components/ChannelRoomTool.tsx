import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FloatingPanel } from "../../components/living/FloatingPanel";
import { Tooltip } from "../../components/living/Tooltip";
import { Cap } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { panelWindowAPI, SurfaceDocument } from "../../ui/panel-window";
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
export function ChannelRoomTool({ title, caption, home, surface, onSurfaceChange, couch, conversation, voice, preferPanel = false }: {
  title: string; home: Slots; surface: RoomToolSurface; onSurfaceChange: (surface: RoomToolSurface) => void;
  caption?: string;
  couch: ReactNode; conversation: ReactNode; voice: ReactNode;
  preferPanel?: boolean;
}) {
  const { lang, vis } = useCopy();
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [targets] = useState(() => ({ couch: target(), conversation: target(), voice: target() }));
  const detached = Boolean(surface.document && surface.document !== document);
  const windowAvailable = panelWindowAPI(typeof window === "undefined" ? null : window);
  const inline = (surface.open && !detached) || preferPanel || !windowAvailable;
  const label = surface.open ? preferPanel && !detached ? (lang === "zh" ? "收起交流面板" : "Close room panel") : (lang === "zh" ? "收回房间小窗" : "Return room to page")
    : inline ? (lang === "zh" ? "房间交流面板" : "Room panel")
    : (lang === "zh" ? "弹出房间小窗" : "Pop out room");
  // A stable home ref can point to a new layout slot; an open tool keeps its content.
  useLayoutEffect(() => {
    if (!surface.open) for (const part of parts) move(targets[part], home[part].current);
  });
  useEffect(() => () => { for (const part of parts) targets[part].remove(); }, [targets]);
  return <>
    <div className="c3-room-tool-entry"><small>{caption ?? title}</small>
      <Tooltip kind={surface.open ? "hint-pip-exit" : inline ? "hint-chat-open" : "hint-window-detach"} text={vis ? undefined : label}>
        <button ref={trigger} type="button" className={`lr-btn is-dense is-quiet${surface.open ? " is-on" : ""}`} aria-label={label}
          aria-haspopup="dialog" aria-pressed={surface.open} aria-expanded={surface.open} popoverTarget={detached ? undefined : id}>
          <Glyph name={preferPanel ? "chat" : surface.open ? "pipExit" : "pip"} size={18} />
          {preferPanel && <Cap k={{ text: lang === "zh" ? "互动" : "Interact" }} />}
        </button>
      </Tooltip>
    </div>
    <FloatingPanel id={id} trigger={trigger} title={title} icon="couch" directWindow={!preferPanel} detachable={preferPanel} className="c3-room-tool"
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
