import { useEffect, useState, useSyncExternalStore } from "react";
import { ChannelSession } from "./session";
import type { ChannelController } from "./types";

declare global {
  interface Window { __channelGate?: { session: ChannelSession; snapshot: () => ReturnType<ChannelSession["getSnapshot"]> } }
}

export function useChannel(): ChannelController {
  const [session] = useState(() => new ChannelSession());
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
    browse: session.browse, sendMessage: session.sendMessage, renameSelf: session.renameSelf,
    createRoom: session.createRoom, setRoles: session.setRoles, startScreen: session.startScreen,
    stopScreen: session.stopScreen, watch: session.watch, unwatch: session.unwatch,
    joinVoice: session.joinVoice, leaveVoice: session.leaveVoice, setMuted: session.setMuted,
    setDeafened: session.setDeafened, clearError: session.clearError, reconnect: session.reconnect,
  };
}
