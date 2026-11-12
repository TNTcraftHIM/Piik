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
    const accept = () => {
      const room = new URLSearchParams(location.hash.slice(1)).get("room");
      if (room) onInvitation?.(room);
      void session.acceptInvitation().catch(() => {});
    };
    window.addEventListener("hashchange", accept);
    return () => window.removeEventListener("hashchange", accept);
  }, [session, onInvitation]);
  useEffect(() => {
    session.start();
    const close = () => session.close();
    const returned = () => { if (document.visibilityState === "visible") void session.resumeApp(); };
    window.addEventListener("pagehide", close);
    window.addEventListener("focus", returned);
    window.addEventListener("storage", session.refreshReadMarkers);
    document.addEventListener("visibilitychange", returned);
    if (import.meta.env.DEV) window.__channelGate = { session, snapshot: session.getSnapshot };
    return () => {
      window.removeEventListener("pagehide", close);
      window.removeEventListener("focus", returned);
      window.removeEventListener("storage", session.refreshReadMarkers);
      document.removeEventListener("visibilitychange", returned);
      if (window.__channelGate?.session === session) delete window.__channelGate;
      session.close();
    };
  }, [session]);
  return { ...view,
    queryProfiles: session.queryProfiles, loadProfiles: session.loadProfiles,
    setFeedbackSound: session.setFeedbackSound, previewFeedbackSound: session.previewFeedbackSound,
    setFeedbackClip: session.setFeedbackClip,
    setQuality: session.setQuality,
    setVideoCodecMode: session.setVideoCodecMode,
    screenQuality: session.screenQuality, setScreenQuality: session.setScreenQuality,
    screenCodecMode: session.screenCodecMode,
    setScreenPaused: session.setScreenPaused,
    setScreenTitle: session.setScreenTitle,
    sourceAudio: session.sourceAudio, setSourceAudio: session.setSourceAudio,
    sourceMicrophone: session.sourceMicrophone, setSourceMicrophone: session.setSourceMicrophone,
    sourceMicrophones: session.sourceMicrophones,
    activateApp: session.activateApp,
    browse: session.browse, sendMessage: session.sendMessage, updateProfile: session.updateProfile, updateDomain: session.updateDomain,
    markRead: session.markRead, loadMessage: session.loadMessage,
    roomTopology: session.roomTopology, connectionMetrics: session.connectionMetrics, appConnectionMetrics: session.appConnectionMetrics,
    exportDomainBackup: session.exportDomainBackup, restoreDomainBackup: session.restoreDomainBackup,
    createRoom: session.createRoom, updateRoom: session.updateRoom, deleteRoom: session.deleteRoom, enterRoom: session.enterRoom,
    setRoomVoiceBitrate: session.setRoomVoiceBitrate,
    setRelayOverride: session.setRelayOverride,
    roomBackupAvailable: session.roomBackupAvailable, exportRoomBackup: session.exportRoomBackup, restoreRoomBackup: session.restoreRoomBackup,
    exportRoomCopy: session.exportRoomCopy, inspectRoomCopy: session.inspectRoomCopy, importRoomCopy: session.importRoomCopy,
    createRoomInvite: session.createRoomInvite, getRoomInvite: session.getRoomInvite, revokeRoomAccess: session.revokeRoomAccess,
    attachments: session.attachments, loadHistory: session.loadHistory, loadLatestHistory: session.loadLatestHistory,
    startScreen: session.startScreen, cameraPreviews: session.cameraPreviews,
    nativeSources: session.nativeSources, nativePreview: session.nativePreview, startNativeScreen: session.startNativeScreen,
    nativeCaptureRequest: session.nativeCaptureRequest,
    nativeCaptureSelection: session.nativeCaptureSelection,
    cancelScreenSelection: session.cancelScreenSelection,
    stopScreen: session.stopScreen, watch: session.watch, unwatch: session.unwatch, screenPresentation: session.screenPresentation,
    inputPolicy: session.inputPolicy, inputDecide: session.inputDecide, inputSimultaneous: session.inputSimultaneous, inputShortcut: session.inputShortcut,
    joinVoice: session.joinVoice, leaveVoice: session.leaveVoice, setMuted: session.setMuted, canUnmute: session.canUnmute,
    voiceActivity: session.voiceActivity,
    setInputVolume: session.setInputVolume, setListeningVolume: session.setListeningVolume,
    microphones: session.microphones, configureVoiceInput: session.configureVoiceInput,
    setVoiceVolume: session.setVoiceVolume, setVoiceMuted: session.setVoiceMuted,
    setDeafened: session.setDeafened, clearError: session.clearError, reconnect: session.reconnect,
  };
}
