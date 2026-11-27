import { useCallback, useEffect, useRef, useState } from "react";
import { rememberRoom } from "./navigation";

type RoomPane = "room" | "rooms" | "people" | "chat";
type SidePane = Exclude<RoomPane, "room">;

function closeLayer(element: HTMLElement) {
  if (element instanceof HTMLDialogElement) {
    if (element.dispatchEvent(new Event("cancel", { cancelable: true }))) element.close();
  } else element.hidePopover();
}

function paneFromHistory(): RoomPane {
  const pane = typeof history !== "undefined" && history.state?.piikRoomPane;
  return pane === "rooms" || pane === "people" || pane === "chat" ? pane : "room";
}

function rememberPane(pane: SidePane) {
  const entry = { ...history.state, piikRoomPane: pane };
  if (paneFromHistory() === "room") history.pushState(entry, "");
  else history.replaceState(entry, "");
}

/** User-opened panes share one history entry above the room. */
export function useRoomPane() {
  const [pane, display] = useState(paneFromHistory);
  const closing = useRef<{ roomId?: string; pane?: SidePane } | null>(null);
  const layers = useRef<HTMLElement[]>([]);
  const returning = useRef(false);
  const hasLayerEntry = useRef(false);
  const topLayer = () => layers.current.findLast(element => element.isConnected && element.matches(":modal, :popover-open"));
  const syncLayer = useCallback(() => {
    if (returning.current || closing.current) return;
    if (topLayer()) {
      if (!history.state?.piikRoomLayer) {
        history.pushState({ ...history.state, piikRoomLayer: true }, "");
      }
      hasLayerEntry.current = true;
    } else if (hasLayerEntry.current && history.state?.piikRoomLayer) {
      returning.current = true;
      history.back();
    }
  }, []);
  const track = useCallback((element: HTMLElement) => {
    layers.current.push(element);
    syncLayer();
    return () => {
      layers.current = layers.current.filter(layer => layer !== element);
      // A picker may hand the same entry to its dialog in this render.
      queueMicrotask(syncLayer);
    };
  }, [syncLayer]);
  useEffect(() => {
    const restore = () => {
      if (hasLayerEntry.current && !history.state?.piikRoomLayer && !returning.current && !closing.current) {
        const top = topLayer();
        if (top) closeLayer(top);
      }
      hasLayerEntry.current = !!history.state?.piikRoomLayer;
      returning.current = false;
      const destination = closing.current;
      closing.current = null;
      if (destination?.roomId !== undefined) rememberRoom(destination.roomId);
      if (destination?.pane) rememberPane(destination.pane);
      display(paneFromHistory());
      syncLayer();
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [syncLayer]);

  const navigate = useCallback((next: RoomPane, roomId?: string) => {
    const previous = paneFromHistory();
    if (closing.current) {
      if (roomId !== undefined) closing.current.roomId = roomId;
      return;
    }
    if (previous !== next || next === "room" && roomId !== undefined && history.state?.piikRoomLayer) {
      try {
        if (next === "room") {
          closing.current = { roomId };
          const depth = Number(previous !== "room") + Number(!!history.state?.piikRoomLayer);
          history.go(-depth);
          return;
        }
        if (history.state?.piikRoomLayer) {
          // Finish retiring the overlay's entry before recording the new pane.
          closing.current = { pane: next };
          for (const layer of layers.current.toReversed()) {
            if (layer.isConnected && layer.matches(":modal, :popover-open")) closeLayer(layer);
          }
          if (!returning.current) history.back();
          return;
        }
        rememberPane(next);
      } catch {
        closing.current = null;
      }
    }
    display(next);
  }, []);

  return { pane, navigate, track };
}
