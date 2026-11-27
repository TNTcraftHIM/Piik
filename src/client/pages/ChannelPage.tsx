import { memberName } from "../channel/member-name";
import { canWatchInBrowser, originalWatchURL } from "../channel/watch-embed-source";
import { roomAvailabilityGroups, useRoomOrder } from "../channel/room-order";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HeaderControls, LedStrip } from "../components/living/Header";
import { StageTv } from "../components/living/Stage";
import { BrandMark } from "../components/living/BrandMark";
import { Btn, Cap } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { joinItems, useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { channelErrorPresentation } from "../components/error-presentation";
import { diagnoseChannelFact } from "../ui/diagnosis";
import { rememberRoom, selectedRoom } from "../channel/navigation";
import { useRoomPane } from "../channel/use-room-pane";
import { useSurfaceDocument } from "../ui/panel-window";
import { LayerHistory } from "../ui/layer-history";
import { composeDocumentTitle, usePageTitle } from "../ui/document-title";
import { ChannelAudio } from "../channel/components/ChannelMedia";
import { ChannelStage, type WaitingStageSource, type WatchStageSource } from "../channel/components/ChannelStage";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { ChannelSettingsDialog, ChannelSettingsError } from "../channel/components/ChannelSettingsDialog";
import { useKeyedSettingsAction, useSettingsAction } from "../ui/use-settings-action";
import { WatchEmbedPreview } from "../channel/components/WatchEmbedPreview";
import { ChannelShareControl, WatchSourceDialog } from "../channel/components/ChannelShareControl";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import { ChannelProfileEditor } from "../channel/components/ChannelProfileEditor";
import { PlaybackDeviceSelect } from "../channel/components/PlaybackDeviceSelect";
import { ChannelFeedbackSounds } from "../channel/components/ChannelFeedbackSounds";
import { ChannelForwardingSettings } from "../channel/components/ChannelForwardingSettings";
import { ChannelInterfaceControl, ChannelInterfaceSuggestion } from "../channel/components/ChannelInterfaceControl";
import { ChannelRoomCreateDialog, ChannelRoomSettingsDialog, RoomHostingNote, roomAccessNoteKey, roomHostingNoteKey } from "../channel/components/ChannelRoomControls";
import { RoomCreationInterrupted, roomCreationPolicyFor, readSimpleShareRoom, rememberSimpleShareRoom, roomDraft, roomSettings, simpleShareRoom, simpleShareRoomKey } from "../channel/room-creation";
import { ChannelRoomEntry, ChannelUnlistedRoomEntry } from "../channel/components/ChannelRoomEntry";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelSiteSettings } from "../channel/components/ChannelSiteSettings";
import { ChannelHostMediaCleanup } from "../channel/components/ChannelHostMediaCleanup";
import { ChannelRoomListItem } from "../channel/components/ChannelRoomListItem";
import { ChannelRoomInvitation } from "../channel/components/ChannelRoomInvitation";
import { ChannelSiteEntry } from "../channel/components/ChannelSiteEntry";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelCouch } from "../channel/components/ChannelCouch";
import { ChannelRoomTool, type RoomToolSurface } from "../channel/components/ChannelRoomTool";
import { ChannelConnections } from "../channel/components/ChannelConnections";
import { ChannelDiagnosisHelp } from "../components/ChannelDiagnosisHelp";
import { roomHasUnread, roomPeople, roomSessionViewing, viewingAppearance, screenAudience, screenDeliveryFailed, screenTitle, userProfile, watchAudience } from "../channel/presentation";
import { useVoicePlayback, type VoiceRendering } from "../channel/use-voice-playback";
import { VoicePlaybackContext } from "../media/viewer-audio";
import { resolveVoiceDockControls } from "../channel/voice-dock-controls";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import { useClientNavigationTarget } from "../channel/client-navigation";
import { readRoomPreferences, saveRoomPreferences, type RoomLayout } from "../lib/room-preferences";
import { useElementWidth } from "../lib/use-element-width";
import type { ChannelController } from "../channel/types";
import { canReceivePeerWatch } from "../channel/watch-media";
import "../channel/bootstrap";
import "./channel-living.css";

type Companion = "chat" | "people" | "none";

export function ChannelPage() {
  const [selected, setSelected] = useState(selectedRoom);
  // Capture incoming hashes before the session's admission listener can consume them.
  const targetURL = useClientNavigationTarget(selected);
  const [layout, setLayout] = useState(() => readRoomPreferences("roomLayout"));
  const changeLayout = useCallback((value: RoomLayout) => {
    setLayout(value); saveRoomPreferences({ roomLayout: value });
  }, []);
  const onSelect = useCallback((id: string) => { rememberRoom(id); setSelected(id); }, []);
  const channel = useChannel();
  return <ChannelRoomPage channel={channel} selected={selected} onSelect={onSelect} layout={layout ?? "full"} offerLayout={layout === undefined} onLayoutChange={changeLayout}
    appControl={<AppConnectionButton discovery={channelAppDiscovery} available={channel.connection === 'connected'} connected={channel.appConnected} connectedPort={channel.appPort} targetURL={targetURL}
      onConnected={(health, signal) => channel.activateApp(health, signal)} />} />;
}

/** Session and App connection owners supply data; this view keeps one set of room slots. */
export function ChannelRoomPage({ channel, selected, onSelect, appControl, layout, offerLayout = false, onLayoutChange, previewOptions }: {
  channel: ChannelController; selected: string; onSelect(id: string): void; appControl: ReactNode;
  layout: RoomLayout; offerLayout?: boolean;
  onLayoutChange(value: RoomLayout): void;
  previewOptions?: ReactNode;
}) {
  const { t, lang } = useCopy();
  const [pickerRoom, setPickerRoom] = useState<string | null>(null);
  const [appWatchId, setAppWatchId] = useState<string | null>(null);
  const [watchRoomId, setWatchRoomId] = useState<string | null>(null);
  const preparingShare = useRef<object | null>(null);
  const { pane: mobilePane, navigate: setMobilePane, track } = useRoomPane();
  const selectRoom = useCallback((id: string) => {
    preparingShare.current = null; setPickerRoom(null);
    onSelect(id); setSourceView(null); setMobilePane("room", id);
  }, [onSelect, setMobilePane]);
  useEffect(() => {
    const navigate = () => selectRoom(selectedRoom());
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [selectRoom]);
  useEffect(() => {
    const open = (event: Event) => {
      const roomId = (event as CustomEvent<string>).detail;
      selectRoom(roomId);
      setWatchRoomId(roomId);
    };
    window.addEventListener("piik-watch-source-picker", open);
    return () => window.removeEventListener("piik-watch-source-picker", open);
  }, [selectRoom]);
  useEffect(() => { preparingShare.current = null; }, [selected]);
  useEffect(() => { if (pickerRoom && pickerRoom !== selected) setPickerRoom(null); }, [selected, pickerRoom]);
  useEffect(() => {
    if (watchRoomId && watchRoomId !== selected && !channel.sourceSelectionCommitting(watchRoomId)) {
      void channel.cancelScreenSelection(watchRoomId).catch(() => {});
      setWatchRoomId(null);
    }
  }, [selected, watchRoomId, channel.cancelScreenSelection]);
  useEffect(() => () => { preparingShare.current = null; }, []);
  const { state, self, sessionId, connection, pending, streams } = channel;
  const roomRemoval = useSettingsAction(true, JSON.stringify([state?.channel.id, sessionId]));
  const [removalRoom, setRemovalRoom] = useState<{ id: string; name: string } | null>(null);
  const roomRemovalPending = !!removalRoom && pending.has(`delete:${removalRoom.id}`);
  const creationPolicy = state && self ? roomCreationPolicyFor(state.channel, self.id) : "owner_only";
  const canCreateRoom = creationPolicy !== "owner_only";
  const ownerDocument = useSurfaceDocument();
  const [workspaceElement, workspaceWidth] = useElementWidth(ownerDocument?.documentElement.clientWidth);
  useLayoutEffect(() => {
    if (!ownerDocument) return;
    const root = ownerDocument.documentElement;
    root.setAttribute("data-living-room", "");
    return () => root.removeAttribute("data-living-room");
  }, [ownerDocument]);
  const phone = workspaceWidth <= 600;
  // Where chat's toggle stands: with people in the room's heading, except on a phone whose heading is one line.
  // Its heading has no room there, and its conversation opens just above my bar. The narrowest phones wrap the
  // heading to a second line, which has the room again.
  const chatInBar = phone && workspaceWidth > 370;
  const minimal = layout === "minimal";
  const bar = phone || minimal;
  const [roomListFolded, setRoomListFolded] = useState(() => readRoomPreferences("roomListFolded"));
  const [companionChoice, setCompanionChoice] = useState<Companion>();
  const [toolTriggerHome, setToolTriggerHome] = useState<HTMLDivElement | null>(null);
  const [stageLayoutHome, setStageLayoutHome] = useState<HTMLDivElement | null>(null);
  const siteHome = useRef<HTMLButtonElement>(null);
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);
  const [newRoom, setNewRoom] = useState<string | RoomCreationInterrupted | null>(null);
  const closeRoomSettings = useCallback(() => setManagedRoomId(null), []);
  const previousDrawer = useRef<typeof mobilePane>("room");
  const [toolSurface, setToolSurface] = useState<RoomToolSurface>({ open: false, document: null });
  useLayoutEffect(() => { setToolSurface({ open: false, document: null }); }, [state?.channel.id, sessionId]);
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [sourceView, setView] = useState<{
    focus: { roomId: string; focusedId: string | null } | null;
    snapshot: ChannelController["state"]; sessionId: string | null;
    waitingWatches: ChannelController["waitingWatchPages"];
    waiting: Array<Omit<WaitingStageSource, "onClose" | "hidden"> & { roomId: string }>;
  }>({ focus: null, snapshot: state, sessionId, waitingWatches: channel.waitingWatchPages, waiting: [] });
  function setSourceView(focus: typeof sourceView.focus) { setView(previous => ({ ...previous, focus })); }
  function closeWaiting(id: string) {
    if (channel.watchPlayers.has(id) || channel.waitingWatchPages?.has(id)) watchAction(id, report => channel.leaveWatch(id, report));
    else if (state?.publications.some(p => p.id === id && p.kind === "screen") && channel.pending.has(`watch:${id}`)) run(channel.unwatch(id));
    setView(previous => ({ ...previous, waiting: previous.waiting.filter(source => source.id !== id) }));
  }
  if (sourceView.snapshot !== state || sourceView.sessionId !== sessionId || sourceView.waitingWatches !== channel.waitingWatchPages) {
    const old = sourceView.snapshot;
    // Until this viewer joins a successor, the room names the source it last joined, so the
    // replacement of a pending successor names the same predecessor as that successor did.
    const successorOf = (roomId: string, id: string) => {
      const prior = [...old?.watchActivities ?? [], ...old?.publications.filter(p => p.kind === "screen") ?? []].find(s => s.id === id)?.predecessor?.id;
      const names = (live: { id: string; roomId: string; predecessor?: { id: string } }) => live.id !== id && live.roomId === roomId
        && !!live.predecessor && (live.predecessor.id === id || live.predecessor.id === prior);
      return state?.watchActivities.find(names) ?? state?.publications.find(p => p.kind === "screen" && names(p));
    };
    const sameSession = old && state && old.channel.id === state.channel.id && sourceView.sessionId === sessionId;
    const waiting = sameSession ? sourceView.waiting.filter(source =>
      state.channel.rooms.some(room => room.id === source.roomId && room.authorized)
      && !(state.publications.some(live => live.id === source.id && live.roomId === source.roomId) && state.subscriptions.includes(source.id))
      && !(state.watchActivities.some(live => live.id === source.id && live.roomId === source.roomId) && (state.watchSubscriptions.some(sub => sub.id === source.id) || channel.waitingWatchPages?.has(source.id)))) : [];
    if (sameSession) {
      const viewed = [...old.publications.filter(p => p.kind === "screen").filter(p => old.subscriptions.includes(p.id)),
        ...old.watchActivities.filter(w => sourceView.waitingWatches?.has(w.id) || old.watchSubscriptions.some(s => s.id === w.id))];
      for (const source of viewed) {
        const room = state.channel.rooms.find(r => r.id === source.roomId && r.authorized);
        if (!room || source.sessionId === sessionId || [...state.publications, ...state.watchActivities].some(live => live.id === source.id)) continue;
        const next = successorOf(room.id, source.id);
        if (next && (channel.waitingWatchPages?.has(next.id) || state.watchSubscriptions.some(sub => sub.id === next.id) || state.subscriptions.includes(next.id))) continue;
        waiting.push({ kind: "waiting", id: next?.id ?? source.id, userId: source.userId, roomId: room.id, roomName: room.name,
          name: memberName(source.userId, old.users.find(u => u.id === source.userId)?.name),
          title: "playback" in source ? watchTitle(source.source.url) : screenTitle(source, t),
          avatar: userProfile(old, channel.profiles, source.userId)?.avatar ?? undefined });
      }
    }
    const focus = sourceView.focus;
    const successor = focus?.focusedId && successorOf(focus.roomId, focus.focusedId);
    setView({ ...sourceView, focus: successor ? { roomId: successor.roomId, focusedId: successor.id } : sourceView.focus, snapshot: state, sessionId, waitingWatches: channel.waitingWatchPages, waiting });
  }
  const previousOwnedScreens = useRef<ReadonlySet<string>>(new Set(channel.ownedScreens));
  const [voiceFocus, setVoiceFocus] = useState("");
  const voiceActivity = resolveVoiceDockControls(channel, voiceFocus).activity;
  const voiceRoomName = state?.channel.rooms.find(room => room.id === voiceActivity?.roomId)?.name ?? voiceActivity?.roomId;
  const { rooms, move: moveRoom } = useRoomOrder(state?.channel.rooms ?? [], state?.channel.id, self?.id);
  const roomGroups = roomAvailabilityGroups(rooms);
  const canOrderRooms = roomGroups.some(group => group.rooms.length > 1);
  const [orderingRooms, setOrderingRooms] = useState(false);
  const [draggedRoom, setDraggedRoom] = useState<{ id: string; available: boolean } | null>(null);
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  useEffect(() => { setOrderingRooms(false); setDraggedRoom(null); setOrderAnnouncement(""); }, [state?.channel.id, self?.id]);
  const activeDrag = draggedRoom && rooms.some(room => room.id === draggedRoom.id && room.available === draggedRoom.available) ? draggedRoom : null;
  useEffect(() => { if (!activeDrag && draggedRoom) setDraggedRoom(null); }, [activeDrag, draggedRoom]);
  const reorderRoom = (available: boolean, source: string, target: string) => {
    const moved = moveRoom(available, source, target);
    const name = rooms.find(value => value.id === source)?.name;
    if (moved && name) setOrderAnnouncement(t("room.order.moved", { name, position: String(moved.position), total: String(moved.total) }));
  };
  const room = rooms.find(value => value.id === selected);
  const siteName = state?.channel.name;
  usePageTitle(composeDocumentTitle(room?.name, siteName === "Piik" ? null : siteName));
  const roomId = room?.id ?? "";
  const overview = !room;
  const unlistedRoom = Boolean(state && selected && !room);
  const knownSelection = useRef<{ siteId: string; roomId: string } | null>(null);
  useEffect(() => {
    if (!state) return;
    const previous = knownSelection.current;
    knownSelection.current = room ? { siteId: state.channel.id, roomId: room.id } : null;
    if (!room && previous?.siteId === state.channel.id && previous.roomId === selected) selectRoom("");
  }, [state?.channel.id, room?.id, selected, selectRoom]);
  const managedRoom = rooms.find(value => value.id === managedRoomId && (value.authorized || value.canManage));
  useLayoutEffect(() => {
    if (!state || !managedRoomId || managedRoom) return;
    setManagedRoomId(null);
    const home = siteHome.current;
    // Native dialog focus restoration cannot reach a room control that has disappeared.
    if (home && home.ownerDocument.activeElement === home.ownerDocument.body) home.focus();
  }, [state?.channel.id, managedRoomId, managedRoom?.id]);
  const connected = connection === "connected";
  const chooseInitialLayout = (value: RoomLayout) => {
    onLayoutChange(value);
    requestAnimationFrame(() => (document.getElementById("c3-first-action")
      ?? document.getElementById("c3-first-room-heading"))?.focus());
  };
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const simpleShareKey = simpleShareRoomKey(state?.channel.id, self?.id);
  const rememberedShareRoom = minimal && canCreateRoom && self
    ? simpleShareRoom(rooms, self.id, readSimpleShareRoom(simpleShareKey)) : undefined;
  const rememberedRoomOffline = rememberedShareRoom?.available === false;
  const quickStartLabel = rememberedRoomOffline ? "channel.previewPage.openRoom" : "channel.previewPage.startSharing";
  // The quick-start button shows its own failure; another site retires it.
  const quickStart = useSettingsAction(true, simpleShareKey ?? state?.channel.id);
  const prepareShare = async () => {
    if (!canCreateRoom || preparingShare.current || pending.has("create-room")) return;
    quickStart.clearError();
    if (rememberedShareRoom) {
      selectRoom(rememberedShareRoom.id);
      if (rememberedShareRoom.available && !sharesIn(rememberedShareRoom.id)) setPickerRoom(rememberedShareRoom.id);
      return;
    }
    const operation = preparingShare.current = {};
    await quickStart.run(async () => {
      try {
        const id = await channel.createRoom(roomSettings({ ...roomDraft(), name: t("channel.previewPage.screenSharing") }, creationPolicy === "invite_only"), false);
        rememberSimpleShareRoom(simpleShareKey, id);
        if (preparingShare.current !== operation) return;
        selectRoom(id); setPickerRoom(id);
      } catch (error) {
        if (error instanceof RoomCreationInterrupted && error.committed && error.roomId) rememberSimpleShareRoom(simpleShareKey, error.roomId);
        if (preparingShare.current !== operation) return;
        if (!(error instanceof RoomCreationInterrupted)) throw error;
        setNewRoom(error);
      }
    });
    if (preparingShare.current === operation) preparingShare.current = null;
  };
  const publications = state?.publications ?? [];
  const screens = publications.filter(value => value.kind === "screen");
  const mine = screens.filter(value => channel.ownedScreens.has(value.id));
  const watched = screens.filter(value => !channel.ownedScreens.has(value.id) && state?.subscriptions.includes(value.id));
  const selectedInputs = new Set(state?.pairs.flatMap(pair => pair.incoming.filter(flow => flow.selected).map(flow => flow.publicationId)));
  const activeScreens = [...mine, ...watched];
  const watches = state?.watchActivities ?? [];
  const ownsWatch = (id: string) => watches.some(activity => activity.id === id && activity.sessionId === sessionId);
  const activeWatches = watches.filter(activity => ownsWatch(activity.id) || channel.waitingWatchPages?.has(activity.id) || state?.watchSubscriptions.some(value => value.id === activity.id));
  const sharesIn = (id: string) => mine.some(source => source.roomId === id) || activeWatches.some(source => source.roomId === id && ownsWatch(source.id));
  const activeSources = [...activeScreens, ...activeWatches, ...sourceView.waiting.filter(source => !channel.waitingWatchPages?.has(source.id))];
  const visibleScreens = activeSources.filter(source => source.roomId === roomId);
  const otherScreens = activeSources.filter(source => source.roomId !== roomId);
  const focusedScreen = sourceView.focus?.roomId === roomId ? sourceView.focus.focusedId : null;
  const theaterMode = useTheaterMode();
  const theaterVisible = theaterMode[0] && visibleScreens.some(source => source.id === focusedScreen);
  const showSource = (sourceRoom: string, focusedId: string | null) => {
    onSelect(sourceRoom); setSourceView({ roomId: sourceRoom, focusedId }); setMobilePane("room", sourceRoom);
  };
  useEffect(() => {
    const owned = [...mine, ...watches.filter(activity => activity.sessionId === sessionId)];
    const added = owned.find(source => source.roomId === roomId && !previousOwnedScreens.current.has(source.id));
    previousOwnedScreens.current = new Set(owned.map(source => source.id));
    if (added) setSourceView({ roomId: added.roomId, focusedId: added.id });
  }, [roomId, mine.map(source => source.id).join(","), watches.map(source => source.id).join(",")]);
  const hasPictures = visibleScreens.length > 0;
  const chatHasToggle = hasPictures || minimal;
  const roomListForced = bar || workspaceWidth < 900 || (hasPictures && workspaceWidth < 1560);
  const roomListRail = !bar && (roomListFolded || roomListForced);
  const roomListOpen = roomListForced && mobilePane === "rooms";
  const roomListCompact = roomListRail && !roomListOpen;
  const toggleRoomList = () => {
    if (roomListForced) {
      setMobilePane(roomListOpen ? "room" : "rooms");
      return;
    }
    const next = !roomListFolded;
    setRoomListFolded(next);
    saveRoomPreferences({ roomListFolded: next });
  };
  useEffect(() => {
    if ((!roomListForced && mobilePane === "rooms") || (phone && mobilePane === "chat" && !chatHasToggle)) setMobilePane("room");
    else if (!phone && (mobilePane === "people" || mobilePane === "chat")) {
      setCompanionChoice(mobilePane);
      setMobilePane("room");
    } else if (phone && mobilePane === "room" && (companionChoice === "people" || (companionChoice === "chat" && chatHasToggle))) {
      setMobilePane(companionChoice);
      setCompanionChoice("none");
    }
  }, [roomListForced, phone, mobilePane, companionChoice, chatHasToggle, setMobilePane]);

  const defaultCompanion = !minimal && (!hasPictures || (phone ? visibleScreens.length === 1 : workspaceWidth >= 1080)) ? "chat" : "none";
  const baseCompanion = companionChoice ?? defaultCompanion;
  const companionPane = phone && (mobilePane === "people" || mobilePane === "chat") ? mobilePane : baseCompanion;
  const roomToolOpen = toolSurface.open && (!toolSurface.mode || toolSurface.mode === "panel");
  const companionVisible = !overview && !roomToolOpen && !(phone && roomListOpen) && companionPane !== "none";
  const inlineChatOpen = companionVisible && companionPane === "chat";
  const chatAside = inlineChatOpen && chatHasToggle;
  const chatPanel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = chatPanel.current;
    if (!phone || !chatAside || !panel) return;
    // The phone chat shares a row with free height. Retain that height while it slides out of the grid.
    const rememberHeight = () => panel.style.setProperty("--chat-panel-height", panel.offsetHeight + "px");
    rememberHeight();
    const observer = new ResizeObserver(rememberHeight);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [phone, chatAside]);
  const mainChatOpen = !chatHasToggle && !overview && !roomToolOpen && !(phone && roomListOpen);
  const toggleCompanion = (kind: Exclude<Companion, "none">) => {
    if (!phone) setCompanionChoice(companionPane === kind ? "none" : kind);
    else if (mobilePane !== "room" && (mobilePane === kind || baseCompanion === kind)) setMobilePane("room");
    else if (mobilePane === "room" && companionPane === kind) setCompanionChoice("none");
    else setMobilePane(kind);
  };
  const visibleCompanion = companionVisible && (companionPane === "people" || chatAside) ? companionPane : "none";
  const peopleCoverRoom = phone && visibleCompanion === "people";
  const conversationHidden = room?.authorized === false || (!roomToolOpen && (theaterVisible || peopleCoverRoom || !(mainChatOpen || chatAside)));
  const setConversationPopout = channel.setConversationPopout;
  useLayoutEffect(() => {
    const popout = roomToolOpen && !conversationHidden && toolSurface.document !== document ? toolSurface.document : null;
    setConversationPopout(roomId, popout);
    return () => setConversationPopout(roomId, null);
  }, [roomId, conversationHidden, roomToolOpen, toolSurface.document, setConversationPopout]);
  const chatInPanel = hasPictures || !!room?.authorized;
  const mainConversationHome = useCallback((node: HTMLDivElement | null) => { if (!chatInPanel) conversationSlot.current = node; }, [chatInPanel]);
  const sideConversationHome = useCallback((node: HTMLDivElement | null) => { if (chatInPanel) conversationSlot.current = node; }, [chatInPanel]);
  const availableScreens = screens.filter(value => value.roomId === roomId && !activeScreens.includes(value));
  const displayedSources = new Set([...visibleScreens, ...availableScreens].map(source => source.id));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
  // A join reports here, not in a slot: membership arrives before the join settles and the slot moves with the room tool.
  const voiceJoin = useSettingsAction(true, JSON.stringify([state?.channel.id, sessionId, roomId]));
  const joinVoice = room?.authorized && (!joined || busy("voice", roomId) || voiceJoin.error) ? <ChannelJoinVoice tonal joined={joined && !busy("voice", roomId)}
    disabled={joined || !connected || !room.available} busy={busy("voice", roomId)}
    error={voiceJoin.error} onJoin={listenOnly => { void voiceJoin.run(() => channel.joinVoice(roomId, listenOnly, false), () => setVoiceFocus(roomId)); }} /> : null;
  const nameOfRoom = (id: string) => rooms.find(value => value.id === id)?.name ?? id;
  const nameOfUser = (id: string) => memberName(id, state?.users.find(value => value.id === id)?.name);
  const voiceStreams = useVoicePlayback(state, sessionId, streams);
  const [voiceRendering, setVoiceRendering] = useState(new Map<string, { stream: MediaStream; state: VoiceRendering }>());
  const reportVoiceRendering = useCallback((id: string, stream: MediaStream, state: VoiceRendering | undefined) => {
    setVoiceRendering(previous => {
      const current = previous.get(id);
      if ((state === undefined && current?.stream !== stream) || (current?.stream === stream && current.state === state)) return previous;
      const next = new Map(previous);
      if (state === undefined) next.delete(id);
      else next.set(id, { stream, state });
      return next;
    });
  }, []);
  const renderingBySpeaker = new Map<string, VoiceRendering>();
  for (const publication of voiceStreams) {
    const rendering = voiceRendering.get(publication.id);
    if (rendering && rendering.stream === streams.get(publication.id)) renderingBySpeaker.set(publication.sessionId, rendering.state);
  }
  const [voiceContext] = useState(() => new VoicePlaybackContext());
  const failure = channelErrorPresentation(channel.error, t);
  // Name the failed room only when it is not the one on screen; a removed room has no name left to show.
  const errorRoomName = channel.errorRoomId && channel.errorRoomId !== roomId ? rooms.find(value => value.id === channel.errorRoomId)?.name : undefined;
  const openFailure = room && channel.roomOpenFailures.get(room.id);
  const roomOpenFailure = openFailure ? diagnoseChannelFact({ area: "roomOpen", failure: openFailure }) : null;
  useEffect(() => {
    if (!state) return;
    channel.browse(roomId);
  }, [state?.channel.id, roomId, room?.authorized, room?.available]);
  useEffect(() => {
    const closedDrawer = previousDrawer.current;
    previousDrawer.current = mobilePane;
    if (mobilePane === "room") {
      if (closedDrawer !== "room") {
        const trigger = document.getElementById(`c3-${closedDrawer}-trigger`);
        (trigger ?? (closedDrawer === "chat" ? document.querySelector<HTMLElement>("#c3-chat .c3-message-log") : null))?.focus({ preventScroll: true });
      }
      return;
    }
    const target = mobilePane === "rooms" ? "#c3-room-list-heading" : mobilePane === "people" ? "#c3-people-heading" : "#c3-chat .c3-message-log";
    document.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing &&
        !document.querySelector('[popover="auto"]:popover-open, dialog:modal')) {
        event.preventDefault();
        setMobilePane("room");
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [mobilePane, setMobilePane]);
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  // A picture's Watch and Retry report here: its offer, tile, help dialog and picture panel can all go first.
  // A result this owner can no longer receive still reaches the banner. A lost connection ends both owners, as it
  // ends the banner's claim: the session drops a result whose socket has gone, and a reconnect starts clean.
  const visibleWatches = watches.filter(activity => activity.roomId === roomId && !(phone && roomListOpen)
    && (!theaterVisible || activity.id === focusedScreen));
  const sourceAction = useKeyedSettingsAction(JSON.stringify([state?.channel.id, sessionId, connected]), [
    ...publications.map(publication => ({ id: `picture:${publication.id}` })), ...visibleWatches.map(activity => ({ id: `watch:${activity.id}` })),
  ]);
  function watchAction(id: string, operation: (reportError: () => boolean) => Promise<void>) {
    void sourceAction.run(`watch:${id}`, operation);
  }
  // A share start reports here: the picker closes first, and the room's share control moves to the tile once sharing starts.
  const shareStart = useSettingsAction(true, JSON.stringify([state?.channel.id, sessionId, roomId, connected]));
  const attemptPicture = (id: string, operation: (reportError: () => boolean) => Promise<void>) => {
    void sourceAction.run(`picture:${id}`, operation);
  };
  const stageWatches = watches.filter(activity => activity.roomId === roomId || activeWatches.includes(activity));
  const [hlsSupported, setHlsSupported] = useState(false);
  const inspectHls = stageWatches.some(activity => activity.sessionId !== sessionId && activity.byteSource?.format === "hls")
    && !canReceivePeerWatch("hls");
  useEffect(() => {
    if (!inspectHls) return;
    let current = true;
    void import("../channel/watch-hls").then(({ Hls }) => { if (current) setHlsSupported(Hls.isSupported()); }, () => {});
    return () => { current = false; };
  }, [inspectHls]);
  function watchTitle(url?: string) { if (!url) return t("watch.video"); const source = new URL(url); return source.host + source.pathname; };
  const watchSources: WatchStageSource[] = stageWatches.map(activity => {
    const player = channel.watchPlayers.get(activity.id);
    const browserSource = canWatchInBrowser(activity.source, player);
    const originalPage = originalWatchURL(activity.source);
    const owned = ownsWatch(activity.id);
    const subscription = state?.watchSubscriptions.find(value => value.id === activity.id);
    const available = connected && !!rooms.find(room => room.id === activity.roomId)?.available;
    return {
      kind: "watch", id: activity.id, roomId: activity.roomId, predecessor: activity.predecessor, pictureAdmitted: rooms.some(room => room.id === activity.roomId && room.authorized), userId: activity.userId, name: nameOfUser(activity.userId), title: watchTitle(activity.source.url),
      website: activity.source.kind === "website", originalPageAvailable: !!originalPage && activity.playback.timeline === "media" && (!channel.appConnected || channel.pagePlayer), onFocusWindow: () => channel.focusWatch(activity.id),
      originalPageUnavailable: originalPage && activity.source.kind === "website" && activity.playback.timeline === "media" && channel.appConnected && !channel.pagePlayer
        ? t("watch.pageUnsupported") : undefined,
      browserSource,
      onAppWatch: originalPage && !owned && activity.playback.timeline !== "program" && activity.source.kind === "website" && channel.appConnected && channel.pagePlayer ? () => {
        showSource(activity.roomId, activity.id);
        setAppWatchId(activity.id);
      } : undefined,
      roomName: nameOfRoom(activity.roomId), avatar: userProfile(state, channel.profiles, activity.userId)?.avatar ?? undefined,
      owned, awaitingSource: channel.waitingWatchPages?.has(activity.id), subscribed: !!subscription || !!channel.waitingWatchPages?.has(activity.id), audience: state ? watchAudience(state, activity, channel.profiles) : [],
      receiving: !owned ? { peerAvailable: !!activity.byteSource, peerSupported: canReceivePeerWatch(activity.byteSource?.format, hlsSupported),
        failed: !!player?.error, mode: player?.mode ?? subscription?.mode ?? "direct",
        browserSource, pending: busy("watch-video", activity.id), disabled: !connected,
        onPeer: () => { showSource(activity.roomId, activity.id); watchAction(activity.id, report => channel.joinWatch(activity.id, "peer", report)); },
        onDirect: () => { showSource(activity.roomId, activity.id); watchAction(activity.id, report => channel.joinWatch(activity.id, "direct", report)); } } : undefined,
      shareControls: owned && <ChannelShareControl channel={channel} roomId={activity.roomId} onWatch={() => setWatchRoomId(activity.roomId)} compact disabled={!available} startAction={shareStart} />,
      actionFailure: sourceAction.errors.get(`watch:${activity.id}`), clearActionFailure: () => sourceAction.clearError(`watch:${activity.id}`),
      hidden: activity.roomId !== roomId,
      paused: activity.playback.paused, player, available,
      pending: busy("watch", activity.id) || busy("watch-video", activity.id) || busy("stop", activity.id),
      onRoom: () => selectRoom(activity.roomId), onJoin: () => { showSource(activity.roomId, activity.id); watchAction(activity.id, report => channel.joinWatch(activity.id, undefined, report)); },
      onLeave: () => watchAction(activity.id, report => channel.leaveWatch(activity.id, report)), onStop: () => watchAction(activity.id, report => channel.stopWatch(activity.id, report)),
      onResume: () => channel.resumeWatch(activity.id), onPlayback: patch => channel.setWatchPlayback(activity.id, patch),
    };
  });
  const connectionLabel = connected ? t("channel.previewPage.connected") : connection === "connecting"
    ? t("channel.previewPage.connecting") : connection === "reconnecting" ? t("channel.previewPage.reconnecting") : t("channel.previewPage.disconnected");

  const personalControls = <>
    <ChannelInterfaceControl value={layout} onChange={onLayoutChange} />
    <PlaybackDeviceSelect />
    <ChannelFeedbackSounds channel={channel} />
    <ChannelForwardingSettings channel={channel} />
    {previewOptions}
  </>;
  const chatToggle = state && !overview && !roomToolOpen && chatHasToggle && room?.authorized && <Btn id="c3-chat-trigger" icon="chat" title="conversation.chat" size="compact" quiet={!chatInBar} className={chatInBar ? "is-tonal" : undefined}
        textTooltip pressed={!conversationHidden} controls="c3-chat" onClick={() => toggleCompanion("chat")} />;
  const connections = room?.authorized && <ChannelConnections key={`connections:${roomId}`} channel={channel} roomId={roomId} />;
  const standingTools = <div className="c3-standing-room-tools" hidden={phone && roomListOpen}>
    {/* A phone's header keeps the room's name, so the room's window opens from beside the couch it lifts out. */}
    {connections}{room?.authorized && !phone && <div ref={setToolTriggerHome} />}
  </div>;
  // In the bar forms the control that opens the room list begins the top row, before the site's cell, so it keeps
  // its place when the list opens.
  const paneNavigation = bar && <span className="c3-pane-navigation" data-tooltip-controls><Btn id="c3-rooms-trigger" icon="sidebar" quiet size="compact"
    title={{ text: t("channel.previewPage.roomList") }} hint="hint-room-list" controls="c3-room-list" expanded={mobilePane === "rooms"}
    onClick={toggleRoomList} /></span>;
  const roomHeading = <div className="c3-room-heading" data-tooltip-controls>
  <div className="c3-room-name"><ChannelIdentityMark icon={room?.icon ?? "couch"} picture={room?.picture} size={25} />
    <Tooltip className="c3-room-title" overflow={{ text: room?.name ?? (unlistedRoom ? t("channel.previewPage.openRoom") : t("channel.previewPage.roomsOverview")), selector: "h2" }}>
      <h2>{room?.name ?? (unlistedRoom ? t("channel.previewPage.openRoom") : t("channel.previewPage.roomsOverview"))}</h2>
    </Tooltip>
    {room && <ChannelRoomInvitation key={room.id} channel={channel} room={room} onManageAccess={() => setManagedRoomId(room.id)} />}
  </div>
  <div className="c3-heading-actions"><div className="c3-room-toolbar"><div className="c3-room-tools" role="group" aria-label={t("channel.previewPage.viewTools")}>
    {!phone && <div ref={setStageLayoutHome} className="c3-living-stage-view" />}
    {state && !overview && !roomToolOpen && <>
      <Btn id="c3-people-trigger" icon="users" title={{ text: t("channel.people.users") }} size="compact" quiet textTooltip
        pressed={companionVisible && companionPane === "people"} controls="c3-people" onClick={() => toggleCompanion("people")} />
      {!chatInBar && chatToggle}
    </>}
  </div></div>
  <div className="lr-top c3-global-tools">{standingTools}<HeaderControls appControl={appControl} personalControls={personalControls}
    maintenanceControls={(open, restoreFocus) => <ChannelHostMediaCleanup channel={channel} moreOpen={open} restoreFocus={restoreFocus} />} /></div></div>
</div>;
  const ownShare = mine.find(source => source.roomId === roomId);
  const ownWatch = activeWatches.find(source => source.roomId === roomId && ownsWatch(source.id));
  const stopOwnShare = ownShare ? () => run(channel.stopScreen(ownShare.id))
    : ownWatch ? () => run(channel.stopWatch(ownWatch.id)) : undefined;
  const ownShareId = ownShare?.id ?? ownWatch?.id;
  const identity = self && <div className="c3-identity">
      {(bar || !roomListCompact) && <PawnSvg centered color={participantColor(self.id)} identity={self.id} avatar={self.avatar ?? undefined} />}
      {!minimal && <div className="c3-identity-copy">
        <Tooltip overflow={{ text: nameOfUser(self.id), selector: "strong" }}><strong>{nameOfUser(self.id)}</strong></Tooltip>
        <small>{t("channel.previewPage.yourName")}</small>
      </div>}
      <ChannelProfileEditor triggerStyle={minimal ? "name" : !bar && roomListCompact ? "pawn" : "pencil"} key={JSON.stringify([state?.channel.id, self.id])}
        siteId={state?.channel.id} askUnnamedMemberName={state?.channel.askUnnamedMemberName ?? false}
        userId={self.id} name={self.name} avatar={self.avatar} color={participantColor(self.id)} disabled={!connected} profileReady={channel.profiles.has(self.id)}
        busy={busy("profile")} onSave={channel.updateProfile} />
    </div>;
  // Who I am ends my dock and begins my bar, and in each it is tabbed where it is seen.
  const personal = <div className="c3-personal">
    {bar && identity}
    <div className="c3-living-actions">
      <div ref={voiceSlot} className="c3-room-slot" />
      {room?.authorized && (stopOwnShare ? <Btn icon="stop" size="compact" tone="danger" title="host.stop"
        cap={phone || roomListCompact ? undefined : "host.stop"} disabled={!connected} busy={busy("stop", ownShareId)} onClick={stopOwnShare} />
        : <ChannelShareControl variant="split" compact={phone || roomListCompact} channel={channel} roomId={roomId} onWatch={() => setWatchRoomId(roomId)}
            disabled={!connected || !room.available} openRequested={pickerRoom === roomId} onPickerRequestHandled={() => setPickerRoom(null)} startAction={shareStart} />)}
      {chatInBar && chatToggle}
    </div>
    {!bar && identity}
  </div>;
  return <LayerHistory.Provider value={track}><div className="lr-app c3-app c3-living-app-frame">
    {stageWatches.map(activity => {
      const media = channel.watchEmbedPreparation(activity.id);
      if (!media) return null;
      const cancel = () => channel.cancelWatchPage(activity.id);
      return <ChannelSettingsDialog key={activity.id} compact title={t("watch.forward.direct")} onClose={cancel}>
        <WatchEmbedPreview media={media} busy={false} onCancel={cancel} />
      </ChannelSettingsDialog>;
    })}
    {watchRoomId && <WatchSourceDialog key={`source:${watchRoomId}`} channel={channel} roomId={watchRoomId} onClose={() => setWatchRoomId(null)} />}
    {watches.filter(activity => activity.id === appWatchId).map(activity => <WatchSourceDialog key={activity.id} channel={channel}
      roomId={activity.roomId} activityId={activity.id} initialURL={activity.source.url} onClose={() => setAppWatchId(null)} />)}
    {state && failure.message && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span className="c3-notice-message">{errorRoomName
      ? joinItems(lang, [errorRoomName, failure.message]) : failure.message}</span>
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="compact" quiet onClick={channel.clearError} />
    </div>}
    {roomRemoval.error && managedRoom?.id !== removalRoom?.id && <div className="c3-notice is-error">
      <Glyph name="alert" size={20} /><div className="c3-notice-message"><strong>{removalRoom?.name}</strong><ChannelSettingsError error={roomRemoval.error} /></div>
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="compact" quiet onClick={roomRemoval.clearError} />
    </div>}
    {managedRoom && <ChannelRoomSettingsDialog key={managedRoom.id} channel={channel} room={managedRoom}
      deleteError={managedRoom.id === removalRoom?.id ? roomRemoval.error : null} deleting={roomRemovalPending}
      onDelete={deleteData => {
        const deleting = { id: managedRoom.id, name: managedRoom.name };
        setRemovalRoom(deleting);
        return roomRemoval.run(async signal => {
          const result = await channel.deleteRoom(deleting.id, deleteData, signal);
          if (deleteData && !result.dataRemoved) throw new Error("room_data_removal_unconfirmed");
        }, () => {
          setRemovalRoom(null);
          setManagedRoomId(current => current === deleting.id ? null : current);
        });
      }}
      onClose={closeRoomSettings} />}
    {newRoom !== null && <ChannelRoomCreateDialog channel={channel} creationPolicy={creationPolicy}
      initialName={typeof newRoom === "string" ? newRoom : ""} initialInterruption={newRoom instanceof RoomCreationInterrupted ? newRoom : null}
      onCreated={id => { selectRoom(id); if (newRoom instanceof RoomCreationInterrupted) { rememberSimpleShareRoom(simpleShareKey, id); setPickerRoom(id); } }} onClose={() => setNewRoom(null)} />}
    <main ref={workspaceElement} className="c3-shell" data-app-shell data-layout="living" data-pane={mobilePane}
      data-sidebars={phone ? "phone" : roomListRail ? "rail" : "list"}
      data-minimal={minimal || undefined} data-main-chat={mainChatOpen && room?.authorized || undefined} data-room-list-open={roomListOpen || undefined} data-overview={overview || undefined}
      data-companion={visibleCompanion}>
      <header className="c3-site-bar">{paneNavigation}<div className="c3-site-identity">
        <button ref={siteHome} className="lr-btn is-compact is-quiet c3-site-home" type="button" aria-label={t("channel.previewPage.roomsOnThisSite")} onClick={() => selectRoom("")}><BrandMark size={30} motion="once" /></button>
        <div className="c3-site-name">{self && self.id === state?.channel.ownerId ? <ChannelSiteSettings channel={channel} />
          : <Tooltip overflow={{ text: state?.channel.name ?? "Piik", selector: "strong" }}><span className="c3-site-name-readonly"><ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={22} /><strong>{state?.channel.name ?? "Piik"}</strong></span></Tooltip>}</div>
        {!connected && <LedStrip state={connection === "closed" ? "bad" : "busy"}
          label={connectionLabel} comic={connection === "closed" ? "signal-failed"
            : connection === "reconnecting" ? "signal-recovering" : "signal-connecting"} />}
      </div><div className="c3-heading-column">{roomHeading}</div>
      </header>
      <aside id="c3-room-list" className="c3-sidebar" aria-label={t("channel.previewPage.rooms")}
        hidden={bar && !roomListOpen} inert={bar && !roomListOpen || undefined}>
        <div className="c3-sidebar-browse">
        <div className={`c3-room-navigation${!rooms.length ? " is-empty" : ""}`}>
          <div className="c3-section-label">
            {!bar && <Btn id="c3-rooms-trigger" icon="sidebar" size="dense" quiet textTooltip
              title={{ text: t("channel.previewPage.roomList") }} controls="c3-room-list"
              expanded={!roomListCompact} onClick={toggleRoomList} />}
            <span id="c3-room-list-heading" tabIndex={-1} className={roomListCompact ? "visually-hidden" : "c3-section-caption"}><Cap k={{ text: t("channel.previewPage.rooms") }} /></span>
            <div className="c3-room-list-actions">{!roomListCompact && self && (canOrderRooms || orderingRooms) && <Btn icon={orderingRooms ? "check" : "grip"} size="dense" quiet textTooltip
              title={orderingRooms ? "room.order.done" : "room.order.edit"} pressed={orderingRooms}
              onClick={() => { setOrderingRooms(!orderingRooms); setDraggedRoom(null); setOrderAnnouncement(""); }} />}
              {!roomListCompact && canCreateRoom && <Btn icon="plus" size="dense" quiet hint="hint-create-room"
              title={{ text: t("channel.previewPage.createRoom") }} cap={!rooms.length ? { text: t("channel.previewPage.createRoom") } : undefined}
              expanded={newRoom !== null} disabled={!connected} onClick={() => setNewRoom("")} />}
            </div>
          </div>
          {!roomListCompact && orderingRooms && <p className="c3-room-order-help">{t("room.order.scope")}<span id="c3-room-order-help" className="visually-hidden">{t("room.order.help")}</span></p>}
          <span className="visually-hidden" role="status">{orderAnnouncement}</span>
          <nav className="c3-rooms" aria-label={t("channel.previewPage.rooms")}>
            {roomGroups.flatMap(({ available, rooms: groupedRooms }) => [
              <h3 key={available ? "group-online" : "group-offline"} className={roomListCompact ? "visually-hidden" : "c3-section-label c3-room-group-heading"}>
                {t(available ? "channel.people.online" : "channel.people.offline")}<span>{groupedRooms.length}</span>
              </h3>,
              ...groupedRooms.map((value, index) => <ChannelRoomListItem key={`room-${value.id}`} channel={channel} room={value}
                selected={roomId === value.id} settingsOpen={managedRoomId === value.id} unopened={channel.roomOpenFailures.has(value.id)}
                compact={roomListCompact} ordering={!roomListCompact && orderingRooms && groupedRooms.length > 1 ? { index, total: groupedRooms.length,
                  active: activeDrag?.available === available && activeDrag.id !== value.id,
                  onDrag: () => setDraggedRoom({ id: value.id, available }), onEnd: () => setDraggedRoom(null),
                  onDrop: () => { if (activeDrag) reorderRoom(activeDrag.available, activeDrag.id, value.id); setDraggedRoom(null); },
                  onMove: direction => { const target = groupedRooms[index + direction]; if (target) reorderRoom(available, value.id, target.id); } } : undefined}
                onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />),
            ])}
          </nav>
          {!roomListCompact && state && !rooms.length && <p className="c3-room-list-empty">{t("channel.previewPage.noRoomsAvailableYet")}</p>}
        </div>
        </div>
      </aside>
      <section className="c3-main" aria-label={room?.name ?? t("channel.previewPage.room")} inert={(phone && roomListOpen) || peopleCoverRoom || undefined}>
        <div className="c3-main-body">
        {state && !connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span className="c3-notice-message">{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" hint="hint-reconnect" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && roomOpenFailure ? <div className="c3-notice is-error" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{t(roomOpenFailure.message)} {room.authorized && <RoomHostingNote channel={channel} room={room} />}</span><ChannelDiagnosisHelp diagnosis={roomOpenFailure} /></div>
          : room?.authorized && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{t(channel.messagesByRoom[room.id]?.length ? "room.offline.retained" : "room.offline.empty")} <RoomHostingNote channel={channel} room={room} /></span></div>}
        {otherScreens.length > 0 && <div className="c3-other-activities" aria-label={t("channel.previewPage.ongoingScreens")}>
          {otherScreens.map(source => {
            const watch = "playback" in source;
            const ended = !("source" in source);
            const owned = watch ? ownsWatch(source.id) : channel.ownedScreens.has(source.id), title = ended ? source.title : watch ? watchTitle(source.source.url) : screenTitle(source, t);
            const viewing = !ended && !owned ? roomSessionViewing(watch ? [] : [source], watch ? [source] : [], state?.subscriptions ?? [], channel) : undefined;
            const appearance = viewing && viewingAppearance[viewing];
            return <div key={source.id} className="c3-other-activity"><Glyph name={owned ? "cast" : appearance?.icon ?? "eye"} size={17} />
              <span><small>{ended ? t("screen.shareEnded", { name: source.name }) : owned ? t("channel.previewPage.stillSharing") : t(appearance?.label ?? "watch.joined")}</small>
                <strong>{title}</strong><span className="c3-activity-room">{nameOfRoom(source.roomId)}</span></span>
              <Btn icon="arrowLeft" quiet size="dense" title={{ text: t("channel.previewPage.returnToRoom", { value: nameOfRoom(source.roomId) }) }}
                cap={{ text: t("channel.previewPage.return") }} onClick={() => showSource(source.roomId, source.id)} />
              <Btn icon={owned ? "stop" : "x"} quiet size="dense" tone={owned ? "danger" : undefined}
                title={{ text: owned ? t("channel.previewPage.stopSharingSource", { title: title }) : t("channel.previewPage.stopWatchingSource", { title: title }) }}
                busy={busy(owned ? "stop" : "watch", source.id)} disabled={busy(owned ? "stop" : "watch", source.id)}
                onClick={() => ended ? closeWaiting(source.id) : watch
                  ? watchAction(source.id, report => owned ? channel.stopWatch(source.id, report) : channel.leaveWatch(source.id, report))
                  : run(owned ? channel.stopScreen(source.id) : channel.unwatch(source.id))} />
            </div>;
          })}
        </div>}
          {!state ? <ChannelSiteEntry channel={channel} failure={failure} /> : unlistedRoom
            ? <ChannelUnlistedRoomEntry key={selected} channel={channel} roomId={selected} onBack={() => selectRoom("")} />
            : overview && <section className="c3-site-overview">
            {minimal && canCreateRoom ? <StageTv hasEntry label={t(quickStartLabel)}><div className="c3-quick-start">
              {rememberedShareRoom
                ? <p>{t(rememberedShareRoom.available ? "channel.previewPage.quickReuseHint" : "channel.previewPage.quickOfflineHint", { name: rememberedShareRoom.name })}</p>
                : <p>{t("channel.previewPage.quickCreateHint", {
                  hosting: t(roomHostingNoteKey(channel)),
                  access: t(roomAccessNoteKey(creationPolicy === "invite_only" ? creationPolicy : roomDraft().access)),
                })}</p>}
              <div className="c3-quick-start-action"><Btn id="c3-first-action" icon={rememberedRoomOffline ? "couch" : "cast"} tone="primary" title={quickStartLabel} cap={quickStartLabel}
                disabled={!connected || busy("create-room")} busy={busy("create-room")} onClick={() => { void prepareShare(); }} />
                <ChannelSettingsError error={quickStart.error} /></div>
            </div></StageTv> : rooms.length ? <div className="c3-overview-rooms">{rooms.map(value => <ChannelRoomItem key={value.id}
              room={value} selected={false} sourceCount={screens.filter(source => source.roomId === value.id).length + watches.filter(source => source.roomId === value.id).length}
              unread={roomHasUnread(value, channel.readByRoom[value.id])} unopened={channel.roomOpenFailures.has(value.id)}
              onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />)}</div>
              : <div className="c3-first-room"><span className="c3-room-start-mark"><ChannelIdentityMark icon="couch" size={46} /></span>
                <h2 id="c3-first-room-heading" tabIndex={-1}>{t(canCreateRoom ? "channel.previewPage.startWithARoom" : "channel.previewPage.noRoomsAvailableYet")}</h2>
                <p>{t(canCreateRoom ? "channel.previewPage.firstRoomHint" : "channel.previewPage.ownerCreatesRooms")}</p>
                {canCreateRoom && <Btn id="c3-first-action" icon="plus" size="compact" tone="primary" hint="hint-create-room"
                  title={{ text: t("channel.previewPage.createYourFirstRoom") }} cap={{ text: t("channel.previewPage.createYourFirstRoom") }}
                  expanded={newRoom !== null} disabled={!connected} onClick={() => setNewRoom(t("channel.previewPage.livingRoom"))} />}
                {offerLayout && connected && <ChannelInterfaceSuggestion value={layout}
                  onChange={chooseInitialLayout} onDismiss={() => chooseInitialLayout(layout)} />}
              </div>}
          </section>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${inlineChatOpen && !roomToolOpen ? "" : " chat-collapsed"}`} hidden={overview}>
          {minimal && room?.authorized && room.available && !hasPictures && <div className="c3-living-tv">
            <StageTv hasEntry label={t("channel.previewPage.shareAScreen")}><div className="c3-quick-start"><p>{t("channel.previewPage.quickStartHint")}</p></div></StageTv>
          </div>}
          <ChannelStage companion={visibleCompanion} layoutHome={!phone ? stageLayoutHome : undefined} theaterMode={theaterMode} buffering={{ target: channel.screenBufferTargetMs, status: channel.screenBufferStatus, onChange: channel.setScreenBufferTarget }} sources={[...[...activeScreens, ...availableScreens].map(publication => ({
            kind: "screen" as const, id: publication.id, roomId: publication.roomId, predecessor: publication.predecessor, pictureAdmitted: rooms.some(room => room.id === publication.roomId && room.authorized), userId: publication.userId, name: nameOfUser(publication.userId),
            hidden: !displayedSources.has(publication.id),
            source: publication.source, title: publication.title, onRoom: () => selectRoom(publication.roomId),
            avatar: userProfile(state, channel.profiles, publication.userId)?.avatar ?? undefined,
            audience: state ? screenAudience(state, publication, channel.profiles) : [],
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id), localSource: channel.localScreens.has(publication.id),
            shareControls: channel.ownedScreens.has(publication.id) ? (publicationActions: ReactNode, compactCaption: boolean) => <ChannelShareControl channel={channel} publicationActions={publicationActions} compactCaption={compactCaption}
              roomId={publication.roomId} publicationId={publication.id} onWatch={() => setWatchRoomId(publication.roomId)} compact
              disabled={!connected || !rooms.find(room => room.id === publication.roomId)?.available} startAction={shareStart} /> : undefined,
            paused: publication.paused, pausePending: publication.sessionId !== sessionId && busy("pause", publication.id),
            pauseAvailable: publication.sessionId === sessionId || connected,
            deliveryFailed: screenDeliveryFailed(publication, sessionId),
            pictureFailure: sourceAction.errors.get(`picture:${publication.id}`), clearPictureFailure: () => sourceAction.clearError(`picture:${publication.id}`),
            playbackError: channel.screenPlaybackError(publication.id),
            roomAdmitted: rooms.find(value => value.id === publication.roomId)?.authorized,
            deliveryScope: JSON.stringify([roomId, sessionId, publication.sessionId,
              rooms.find(value => value.id === publication.roomId)?.delivery?.bindingId]),
            waitingForInput: connected && !channel.localScreens.has(publication.id) && !channel.ownedScreens.has(publication.id)
              && state?.subscriptions.includes(publication.id) && !selectedInputs.has(publication.id),
            available: rooms.find(value => value.id === publication.roomId)?.available ?? false,
            subscribed: state?.subscriptions.includes(publication.id) ?? false, stream: streams.get(publication.id), inputs: channel.screenInputs.get(publication.id),
            interaction: channel.interactionsByRoom.get(publication.roomId) ?? null,
            reactions: channel.publicationReactions.get(publication.id),
            input: channel.inputChannels.get(publication.id),
            sourceAudio: (() => {
              const sound = channel.sourceAudio(publication.id);
              return sound && { ...sound, busy: busy("screen", publication.roomId),
                onChange: (settings: { level?: number; muted?: boolean }) => run(channel.setSourceAudio(publication.id, settings)) };
            })(),
            sourceMicrophone: (() => {
              const microphone = channel.sourceMicrophone(publication.id);
              return microphone?.available ? { enabled: microphone.enabled, busy: busy("source-microphone", publication.id), canDisable: microphone.canDisable,
                disabled: !connected || busy("screen", publication.roomId),
                onEnabled: (enabled: boolean) => run(channel.setSourceMicrophone(publication.id, { enabled })) } : undefined;
            })(),
            remoteControl: (() => {
              const remote = channel.remoteControls.get(publication.id);
              return remote && { ...remote, requests: remote.requests.map(request => ({ ...request,
                name: nameOfUser(state?.sessions.find(session => session.id === request.peerId)?.userId ?? request.peerId) })) };
            })(),
            pending: busy(channel.ownedScreens.has(publication.id) ? "stop" : "watch", publication.id) || busy("retry-picture", publication.id),
          })), ...watchSources, ...sourceView.waiting.filter(source => !channel.waitingWatchPages?.has(source.id)).map(source => ({ ...source, hidden: source.roomId !== roomId, onClose: () => closeWaiting(source.id) }))]} focusedId={focusedScreen} onFocus={id => setSourceView({ roomId, focusedId: id })} canSubscribe={connected}
            onWatch={id => { showSource(roomId, id); attemptPicture(id, reportError => channel.watch(id, reportError)); }} onUnwatch={id => run(channel.unwatch(id))}
            onRetryPicture={id => attemptPicture(id, reportError => channel.retryPicture(id, reportError))}
            onPause={(id, paused) => run(channel.setScreenPaused(id, paused))}
            onStop={id => run(channel.stopScreen(id))} onPresentation={channel.screenPresentation}
            onInputPolicy={channel.inputPolicy} onInputDecide={channel.inputDecide} onInputSimultaneous={channel.inputSimultaneous} onInputShortcut={channel.inputShortcut} />
          <div ref={mainConversationHome} className="c3-room-slot" />
        </div>
        </div>
        {voiceStreams.map(publication => <ChannelAudio key={publication.sessionId} publicationId={publication.id} stream={streams.get(publication.id)!}
          onRendering={reportVoiceRendering}
          volume={channel.listeningVolume * (channel.voicePlaybackByUser.get(publication.userId)?.volume ?? 1)} voiceContext={voiceContext}
          muted={(myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true) || (channel.voicePlaybackByUser.get(publication.userId)?.muted ?? false)}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
      <div ref={chatPanel} className="c3-chat-panel" inert={!(chatAside || mainChatOpen) || peopleCoverRoom || undefined}><div ref={sideConversationHome} className="c3-room-slot" /></div>
      <ChannelPeople channel={channel} roomId={roomId} active={companionVisible && companionPane === "people"} onBack={() => toggleCompanion("people")} />
      <div className="c3-room-presence" data-empty={!room?.authorized || undefined} inert={(phone && roomListOpen) || peopleCoverRoom || undefined}>
        <ChannelRoomTool key={`${state?.channel.id ?? ""}:${sessionId ?? ""}`} title={room?.name ?? t("channel.previewPage.room")} voiceRoomName={voiceRoomName}
          triggerHome={toolTriggerHome} surface={toolSurface} onSurfaceChange={setToolSurface}
          caption={room ? t("channel.previewPage.roomFriends", { name: room.name }) : t("channel.previewPage.friendsInThisRoom")}
          home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
          couch={room?.authorized && <ChannelCouch compact={phone && visibleScreens.length >= 2} className="c3-room-company" people={state ? roomPeople(state, roomId, channel.profiles, channel) : []}
            floating={roomToolOpen} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
          conversation={<>{room && !room.authorized && <ChannelRoomEntry key={room.id} channel={channel} room={room} />}
            <ChannelConversation domainId={state?.channel.id} roomId={roomId} bindingId={room?.delivery?.bindingId} roomName={room?.name ?? ""} roomIcon={room?.icon} roomPicture={room?.picture} messages={channel.messagesByRoom[roomId] ?? []}
            users={state?.users ?? []} profiles={channel.profiles} queryProfiles={channel.queryProfiles} entry={self ? { kind: "site" } : { kind: "entry" }}
            authorized={room?.authorized} canSend={connected && !!room?.authorized && room.available} sending={busy("chat", roomId)}
            attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.authorized && room.available}
            history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
            onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
            findUnreadMessage={room?.historyLineage ? channel.findUnreadMessage : undefined}
            onMessage={channel.loadMessage} onRead={channel.markRead} unreadAfter={channel.readByRoom[roomId]} lastMessageSeq={room?.lastMessageSeq} selfUserId={self?.id}
            onDeleteMessage={room?.authorized ? channel.deleteMessage : undefined}
            canModerate={room?.canManage || (!!self && self.id === state?.channel.ownerId)} pending={channel.pending}
            historyChanges={channel.historyChangesByRoom[roomId]}
            interaction={channel.interactionsByRoom.get(roomId) ?? null}
            onSend={channel.sendMessage} onDiscardSend={channel.discardMessageRetry} floating={roomToolOpen} hidden={conversationHidden} /></>}
          voice={<><section className="c3-voice-entry" aria-label={t("channel.previewPage.voiceInThisRoom")}>
            {joinVoice && <>{!bar && <div><small>{t("channel.previewPage.currentRoom")}</small><strong>{room?.name}</strong></div>}{joinVoice}</>}
          </section><ChannelVoiceDock density={bar ? "bar" : roomListCompact ? "rail" : "rows"} directRoomId={voiceFocus} channel={channel} browsingRoomId={roomId}
            renderingBySpeaker={renderingBySpeaker} onBrowse={id => { setVoiceFocus(id); selectRoom(id); }} /></>} />
        <div ref={couchSlot} className="c3-room-slot" />
      </div>
      {personal}
    </main>
  </div></LayerHistory.Provider>;
}
