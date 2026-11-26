import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { VoiceOverlay, type OverlayMode } from "./voice-overlay";
import { FloatingPanel, type PanelWindowControl } from "../../components/living/FloatingPanel";
import { Tooltip } from "../../components/living/Tooltip";
import { Cap } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { panelWindowAPI, SurfaceDocument } from "../../ui/panel-window";
import "./channel-room-tool.css";

export interface RoomToolSurface { open: boolean; document: Document | null; mode?: OverlayMode }
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
export function ChannelRoomTool({ title, voiceRoomName, caption, home, surface, onSurfaceChange, couch, conversation, voice, actions, preferPanel = false, entryHome }: {
  title: string; voiceRoomName?: string; home: Slots; surface: RoomToolSurface; onSurfaceChange: (surface: RoomToolSurface) => void;
  caption?: string;
  couch: ReactNode; conversation: ReactNode; voice: ReactNode;
  actions?: ReactNode;
  preferPanel?: boolean;
  /** Where the tool's opening control is shown when a layout places it away from the couch. */
  entryHome?: HTMLElement | null;
}) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [targets] = useState(() => ({ couch: target(), conversation: target(), voice: target() }));
  const panel = useRef<PanelWindowControl>(null);
  const mode = surface.mode ?? "panel";
  const setMode = (next: OverlayMode) => onSurfaceChange({ ...surface, mode: next });
  const [overlayTarget, setOverlayTarget] = useState<HTMLDivElement | null>(null);
  const [readyDocument, setReadyDocument] = useState<Document | null>(null);
  const detached = Boolean(surface.document && surface.document !== document);
  const windowAvailable = panelWindowAPI(typeof window === "undefined" ? null : window);
  const inline = (surface.open && !detached) || preferPanel || !windowAvailable;
  const [available, setAvailable] = useState(!!window.piikVoiceOverlay);
  const requested = useRef(false);
  useLayoutEffect(() => {
    const refresh = () => setAvailable(!!window.piikVoiceOverlay);
    refresh(); window.addEventListener("piik-overlay-available", refresh);
    return () => window.removeEventListener("piik-overlay-available", refresh);
  }, []);
  const overlay = mode !== "panel";
  const panelOpen = surface.open && !overlay;
  const presentation = (next: OverlayMode): boolean => {
    if (!detached || readyDocument !== surface.document || !readyDocument?.defaultView?.piikSetVoiceOverlay?.(next)) return false;
    setMode(next);
    return true;
  };
  const pinRequested = () => {
    if (requested.current && presentation("pinned")) requested.current = false;
  };
  const showOverlay = async () => {
    requested.current = true;
    if (detached) pinRequested();
    else if (!await panel.current?.open()) requested.current = false;
  };
  useLayoutEffect(pinRequested, [readyDocument, surface.document]);
  useLayoutEffect(() => {
    const child = readyDocument?.defaultView;
    if (mode !== "editing" || !child) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
        child.document.querySelector('[popover="auto"]:popover-open, dialog:modal')) return;
      if (presentation("pinned")) event.preventDefault();
    };
    child.addEventListener("keydown", escape, true);
    return () => child.removeEventListener("keydown", escape, true);
  }, [mode, readyDocument, surface]);
  const label = overlay ? t("channel.roomTool.roomPanel") : panelOpen ? preferPanel && !detached ? t("channel.roomTool.closeRoomPanel") : t("channel.roomTool.returnRoomToPage")
    : inline ? t("channel.roomTool.roomPanel")
    : t("channel.roomTool.popOutRoom");
  // A stable home ref can point to a new layout slot; an open tool keeps its content.
  const place = (open: boolean, owner: Document | null) => {
    const destination = open ? { couch: couchSlot, conversation: conversationSlot, voice: voiceSlot } : home;
    for (const part of parts) move(targets[part], part === "couch" && preferPanel && owner === document ? home.couch.current : destination[part].current);
  };
  useLayoutEffect(() => {
    place(panelOpen, surface.document);
  });
  useEffect(() => () => { for (const part of parts) targets[part].remove(); }, [targets]);
  const entry = <div className="c3-room-tool-entry"><small>{caption ?? title}</small>
      <Tooltip kind={panelOpen ? "hint-pip-exit" : inline || overlay ? "hint-chat-open" : "hint-window-detach"} text={label}>
        <button ref={trigger} type="button" className={`lr-btn is-dense is-quiet${panelOpen ? " is-on" : ""}`} aria-label={label}
          aria-haspopup="dialog" aria-expanded={panelOpen} popoverTarget={detached ? undefined : id}>
          <Glyph name={preferPanel ? "chat" : panelOpen ? "pipExit" : "pip"} size={18} />
          {preferPanel && <Cap k={{ text: t("channel.roomTool.interact") }} />}
        </button>
      </Tooltip>
      {actions}
    </div>;
  return <>
    {entryHome === undefined ? entry : entryHome && createPortal(entry, entryHome)}
    <FloatingPanel onDetachedTrigger={overlay ? () => presentation("panel") : undefined} onNativeReady={setReadyDocument} closeOnReturn={overlay}
      windowControl={panel} id={id} trigger={trigger} title={overlay ? voiceRoomName ?? title : title}
      directWindow={!preferPanel} detachable={preferPanel} detachedAction="return" className={`c3-room-tool${overlay ? " is-voice-overlay" : ""}`}
      onOpenChange={(open, owner) => {
        // Placement-dependent children must render against their new ancestry.
        if (owner === document) { requested.current = false; setReadyDocument(null); }
        place(open && !overlay, owner);
        onSurfaceChange({ open, document: owner, mode: open && owner !== document ? mode : "panel" });
      }}>
      <div ref={couchSlot} className="c3-room-slot" />
      <div ref={conversationSlot} className="c3-room-slot" />
      <div ref={voiceSlot} className="c3-room-slot" />
      <div ref={setOverlayTarget} className="c3-room-slot" />
    </FloatingPanel>
    <SurfaceDocument.Provider value={panelOpen && (!preferPanel || detached) ? surface.document : null}>
      {createPortal(couch, targets.couch)}
    </SurfaceDocument.Provider>
    <SurfaceDocument.Provider value={panelOpen ? surface.document : null}>
      {createPortal(conversation, targets.conversation)}
      <VoiceOverlay.Provider value={available && windowAvailable ? { mode, target: overlay && detached ? overlayTarget : null,
        show: () => void showOverlay(), edit: () => presentation(mode === "editing" ? "pinned" : "editing"), close: () => panel.current?.close() } : null}>
        {createPortal(voice, targets.voice)}
      </VoiceOverlay.Provider>
    </SurfaceDocument.Provider>
  </>;
}
