import { useEffect, useState, useSyncExternalStore } from "react";
import { ChannelSession } from "./session";
import type { ChannelController } from "./types";

declare global {
  interface Window { __channelGate?: { session: ChannelSession; snapshot: () => ReturnType<ChannelSession["getSnapshot"]> } }
}

export function useChannel(onInvitation?: (roomId: string) => void): ChannelController {
  const [session] = useState(() => new ChannelSession());
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    const accept = () => { void session.acceptRoomInvitation().then(room => { if (room) onInvitation?.(room); }).catch(() => {}); };
    window.addEventListener("hashchange", accept);
    return () => window.removeEventListener("hashchange", accept);
  }, [session, onInvitation]);
  useEffect(() => {
    session.start();
    const close = () => session.close();
    window.addEventListener("pagehide", close);
    if (import.meta.env.DEV) window.__channelGate = { session, snapshot: session.getSnapshot };
    return () => {
      window.removeEventListener("pagehide", close);
      if (window.__channelGate?.session === session) delete window.__channelGate;
      session.close();
    };
  }, [session]);
  return { ...view,
    activateApp: session.activateApp,
    browse: session.browse, sendMessage: session.sendMessage, renameSelf: session.renameSelf, updateDomain: session.updateDomain,
    setMessageReaction: session.setMessageReaction,
    createRoom: session.createRoom, updateRoom: session.updateRoom, enterRoom: session.enterRoom,
    createRoomInvite: session.createRoomInvite, revokeRoomAccess: session.revokeRoomAccess,
    attachments: session.attachments, loadHistory: session.loadHistory, loadLatestHistory: session.loadLatestHistory,
    setRoles: session.setRoles, startScreen: session.startScreen,
    nativeSources: session.nativeSources, startNativeScreen: session.startNativeScreen,
    nativeCaptureRequest: session.nativeCaptureRequest,
    stopScreen: session.stopScreen, watch: session.watch, unwatch: session.unwatch, screenPresentation: session.screenPresentation,
    inputPolicy: session.inputPolicy, inputDecide: session.inputDecide, inputSimultaneous: session.inputSimultaneous, inputShortcut: session.inputShortcut,
    joinVoice: session.joinVoice, leaveVoice: session.leaveVoice, setMuted: session.setMuted,
    setInputVolume: session.setInputVolume, setListeningVolume: session.setListeningVolume,
    setDeafened: session.setDeafened, clearError: session.clearError, reconnect: session.reconnect,
  };
}
