import { canWatchInBrowser } from "../channel/watch-embed-source";
import { roomAvailabilityGroups, useRoomOrder } from "../channel/room-order";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HeaderControls, LedStrip } from "../components/living/Header";
import { StageTv } from "../components/living/Stage";
import { BrandMark } from "../components/living/BrandMark";
import { BackButton, Btn, Cap } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { joinItems, useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { channelErrorPresentation } from "../channel/error-presentation";
import { diagnoseChannelFact } from "../channel/diagnosis";
import { rememberRoom, selectedRoom } from "../channel/navigation";
import { useRoomPane } from "../channel/use-room-pane";
import { LayerHistory } from "../ui/layer-history";
import { composeDocumentTitle, usePageTitle } from "../ui/document-title";
import { ChannelAudio } from "../channel/components/ChannelMedia";
import { ChannelStage, type WaitingStageSource, type WatchStageSource } from "../channel/components/ChannelStage";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { ChannelSettingsDialog, ChannelSettingsError, useKeyedSettingsAction, useSettingsAction } from "../channel/components/ChannelSettingsDialog";
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
import { ChannelRoomCreateDialog, ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { RoomCreationInterrupted, roomCreationPolicyFor, readSimpleShareRoom, rememberSimpleShareRoom, roomDraft, roomSettings, simpleShareRoom, simpleShareRoomKey } from "../channel/room-creation";
import { ChannelRoomEntry, ChannelUnlistedRoomEntry } from "../channel/components/ChannelRoomEntry";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelSiteSettings } from "../channel/components/ChannelSiteSettings";
import { ChannelRoomListItem } from "../channel/components/ChannelRoomListItem";
import { ChannelRoomInvitation } from "../channel/components/ChannelRoomInvitation";
import { ChannelSiteEntry } from "../channel/components/ChannelSiteEntry";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelCouch } from "../channel/components/ChannelCouch";
import { ChannelRoomTool, type RoomToolSurface } from "../channel/components/ChannelRoomTool";
import { ChannelConnections } from "../channel/components/ChannelConnections";
import { ChannelDiagnosisHelp } from "../channel/components/ChannelDiagnosisHelp";
import { roomHasUnread, roomPeople, roomSessionViewing, viewingAppearance, screenAudience, screenDeliveryFailed, screenTitle, userProfile, watchAudience } from "../channel/presentation";
import { useVoicePlayback, type VoiceRendering } from "../channel/use-voice-playback";
import { VoicePlaybackContext } from "../media/viewer-audio";
import { resolveVoiceDockControls } from "../channel/voice-dock-controls";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import { useClientNavigationTarget } from "../channel/client-navigation";
import { readRoomPreferences, saveRoomPreferences, type InterfaceLayout, type RoomLayout } from "../lib/room-preferences";
import { useElementWidth } from "../lib/use-element-width";
import type { ChannelController } from "../channel/types";
import { canReceivePeerWatch } from "../channel/watch-media";
import "../channel/bootstrap";
import "./channel-preview.css";
import "./channel-living.css";

export function ChannelPage() {
  const [selected, setSelected] = useState(selectedRoom);
  // Capture incoming hashes before the session's admission listener can consume them.
  const targetURL = useClientNavigationTarget(selected);
  const [layout, setLayout] = useState(() => readRoomPreferences().interfaceLayout);
  const changeLayout = useCallback((value: InterfaceLayout) => {
    setLayout(value); saveRoomPreferences({ interfaceLayout: value });
  }, []);
  const onSelect = useCallback((id: string) => { rememberRoom(id); setSelected(id); }, []);
  const channel = useChannel();
  return <ChannelRoomPage channel={channel} selected={selected} onSelect={onSelect} layout={layout ?? "workspace"} offerLayout={layout === undefined} onLayoutChange={changeLayout}
    appControl={<AppConnectionButton discovery={channelAppDiscovery} available={channel.connection === 'connected'} connected={channel.appConnected} connectedPort={channel.appPort} targetURL={targetURL}
      onConnected={(health, signal) => channel.activateApp(health, signal)} />} />;
}

/** Session and App connection owners supply data; this view keeps one set of room slots. */
export function ChannelRoomPage({ channel, selected, onSelect, appControl, layout = "workspace", offerLayout = false, onLayoutChange, previewOptions }: {
  channel: ChannelController; selected: string; onSelect(id: string): void; appControl: ReactNode;
  layout?: RoomLayout; offerLayout?: boolean;
  onLayoutChange?: (value: InterfaceLayout) => void;
  previewOptions?: ReactNode;
}) {
  const { t, lang } = useCopy();
  const [pickerRoom, setPickerRoom] = useState<string | null>(null);
  const [appWatchId, setAppWatchId] = useState<string | null>(null);
  const [watchRoomId, setWatchRoomId] = useState<string | null>(null);
  const preparingShare = useRef<object | null>(null);
  const { pane: mobilePane, navigate: setMobilePane, showInitialRooms, track } = useRoomPane();
  const returnToRoom = useCallback(() => setMobilePane("room"), [setMobilePane]);
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
  const creationPolicy = state && self ? roomCreationPolicyFor(state.channel, self.id) : "owner_only";
  const canCreateRoom = creationPolicy !== "owner_only";
  const [sharingView, setSharingView] = useState(() => readRoomPreferences().sharingView);
  const [workspaceElement, workspaceWidth] = useElementWidth();
  const sidebarsInline = layout !== "quick" && workspaceWidth > 1080;
  // The living-room prototype re-places the same owners; under 600 px it stacks them in one column.
  const living = layout === "living";
  const phone = living && workspaceWidth > 0 && workspaceWidth < 600;
  // Which companion sits beside the pictures: the conversation, the people of the site, or nothing. Local
  // presentation for this prototype, not saved. A phone or a narrow window starts with the picture and the couch alone.
  const [panel, setPanel] = useState<"chat" | "people" | "none">(() => typeof window !== "undefined" && window.innerWidth < 1080 ? "none" : "chat");
  const togglePanel = (kind: "chat" | "people") => setPanel(current => current === kind ? "none" : kind);
  // The stage's grid and focus switch is shown in the top bar, with the other view tools.
  const [viewHome, setViewHome] = useState<HTMLElement | null>(null);
  const [companionOpen, setCompanionOpen] = useState({ people: false, chat: true });
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);
  const [newRoom, setNewRoom] = useState<string | RoomCreationInterrupted | null>(null);
  const closeRoomSettings = useCallback(() => setManagedRoomId(null), []);
  const previousLayout = useRef(layout);
  const previousDrawer = useRef<typeof mobilePane>("room");
  const previousSharingView = useRef(sharingView);
  useEffect(() => {
    if (sidebarsInline || layout !== previousLayout.current) {
      previousDrawer.current = "room";
      setMobilePane("room");
    }
    previousLayout.current = layout;
  }, [sidebarsInline, layout, setMobilePane]);
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
    if (channel.watchPlayers.has(id) || channel.waitingWatchPages?.has(id)) run(channel.leaveWatch(id));
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
          name: old.users.find(u => u.id === source.userId)?.name ?? t("channel.previewPage.user"),
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
  useEffect(() => {
    if (state && managedRoomId && !managedRoom) setManagedRoomId(null);
  }, [state?.channel.id, managedRoomId, managedRoom?.id]);
  useEffect(() => {
    if (!sidebarsInline && sharingView && state && !rooms.length) showInitialRooms();
  }, [sharingView, state?.channel.id, rooms.length, sidebarsInline, showInitialRooms]);
  const toggleSharingView = () => {
    const next = !sharingView;
    setSharingView(next);
    saveRoomPreferences({ sharingView: next });
    setMobilePane(next && state && !rooms.length ? "rooms" : "room");
  };
  const showRooms = () => {
    if (roomsRail || layout === "quick" || !sidebarsInline) { setMobilePane(mobilePane === "rooms" ? "room" : "rooms"); return; }
    if (sharingView) toggleSharingView();
    setMobilePane("room");
  };
  const connected = connection === "connected";
  const chooseInitialLayout = (value: InterfaceLayout) => {
    onLayoutChange?.(value);
    requestAnimationFrame(() => document.getElementById("c3-first-action")?.focus());
  };
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const simpleShareKey = simpleShareRoomKey(state?.channel.id, self?.id);
  // The quick-start button shows its own failure; another site retires it.
  const quickStart = useSettingsAction(true, simpleShareKey ?? state?.channel.id);
  const prepareShare = async () => {
    if (!canCreateRoom || preparingShare.current || pending.has("create-room")) return;
    quickStart.clearError();
    const existing = self && simpleShareRoom(rooms, self.id, readSimpleShareRoom(simpleShareKey));
    if (existing) {
      selectRoom(existing.id);
      if (existing.available && !sharesIn(existing.id)) setPickerRoom(existing.id);
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
  // What I share in the room on screen, for the bar's stop control.
  const livingScreen = mine.find(source => source.roomId === roomId), livingWatch = activeWatches.find(source => source.roomId === roomId && ownsWatch(source.id));
  const livingShare = livingScreen ? { id: livingScreen.id, watch: false } : livingWatch ? { id: livingWatch.id, watch: true } : undefined;
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
  const companionKind = visibleScreens.length > 0 ? "chat" : "people";
  const roomToolOpen = toolSurface.open && (!toolSurface.mode || toolSurface.mode === "panel");
  // Living: the centre belongs to the main activity. With pictures the conversation is a companion beside
  // them; without pictures it is the main column, and only the people of the site can be a companion.
  const hasPictures = visibleScreens.length > 0;
  const livingPane = !living || overview || roomToolOpen ? "none" : hasPictures ? panel : panel === "people" ? "people" : "none";
  const livingChat = !living || overview || roomToolOpen ? "none" : !hasPictures ? "main" : panel === "chat" ? "panel" : "none";
  // Only one side region fits beside a large picture: below a 1600 px viewport (the shell is 40 px narrower)
  // the room list folds to its rail while a picture is on the stage, and opens over the stage on demand.
  const roomsRail = living && !phone && (sharingView || workspaceWidth < 900 || hasPictures && workspaceWidth < 1560);
  const companionPane = living ? livingPane : sidebarsInline ? companionKind : mobilePane;
  const companionVisible = living ? livingPane !== "none" : layout !== "quick" && !overview && !roomToolOpen && (sidebarsInline
    ? companionOpen[companionKind]
    : mobilePane === "people" || mobilePane === "chat");
  const inlineChatOpen = living ? livingChat !== "none" : companionVisible && companionPane === "chat";
  const conversationHidden = room?.authorized === false || (!roomToolOpen && (living ? theaterVisible || !inlineChatOpen : layout === "quick" || theaterVisible
    || (visibleScreens.length > 0 ? !inlineChatOpen : !sidebarsInline && mobilePane !== "room")));
  const setConversationPopout = channel.setConversationPopout;
  useLayoutEffect(() => {
    const popout = roomToolOpen && !conversationHidden && toolSurface.document !== document ? toolSurface.document : null;
    setConversationPopout(roomId, popout);
    return () => setConversationPopout(roomId, null);
  }, [roomId, conversationHidden, roomToolOpen, toolSurface.document, setConversationPopout]);
  const conversationAside = living || visibleScreens.length > 0;
  const mainConversationHome = useCallback((node: HTMLDivElement | null) => { if (!conversationAside) conversationSlot.current = node; }, [conversationAside]);
  const sideConversationHome = useCallback((node: HTMLDivElement | null) => { if (conversationAside) conversationSlot.current = node; }, [conversationAside]);
  const availableScreens = screens.filter(value => value.roomId === roomId && !activeScreens.includes(value));
  const displayedSources = new Set([...visibleScreens, ...availableScreens].map(source => source.id));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
  // A join reports here, not in a slot: membership arrives before the join settles and the slot moves with the room tool.
  const voiceJoin = useSettingsAction(true, JSON.stringify([state?.channel.id, sessionId, roomId]));
  const joinVoice = room?.authorized && (!joined || busy("voice", roomId) || voiceJoin.error) ? <ChannelJoinVoice joined={joined && !busy("voice", roomId)}
    disabled={joined || !connected || !room.available} busy={busy("voice", roomId)}
    error={voiceJoin.error} onJoin={listenOnly => { void voiceJoin.run(() => channel.joinVoice(roomId, listenOnly, false), () => setVoiceFocus(roomId)); }} /> : null;
  const nameOfRoom = (id: string) => rooms.find(value => value.id === id)?.name ?? id;
  const nameOfUser = (id: string) => state?.users.find(value => value.id === id)?.name ?? t("channel.previewPage.user");
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
  useLayoutEffect(() => {
    const changed = previousSharingView.current !== sharingView;
    previousSharingView.current = sharingView;
    if (!sidebarsInline || !changed) return;
    const trigger = sharingView ? "c3-rooms-trigger" : "c3-rooms-collapse";
    document.getElementById(trigger)?.focus({ preventScroll: true });
  }, [sharingView, sidebarsInline]);
  useEffect(() => {
    const closedDrawer = previousDrawer.current;
    previousDrawer.current = sidebarsInline ? "room" : mobilePane;
    if (sidebarsInline) return;
    if (mobilePane === "room") {
      if (closedDrawer !== "room") {
        const trigger = closedDrawer === "rooms" ? "c3-rooms-trigger" : "c3-companion-trigger";
        document.getElementById(trigger)?.focus({ preventScroll: true });
      }
      return;
    }
    const heading = mobilePane === "chat" ? document.querySelector<HTMLElement>(".c3-chat-panel .c3-chat-heading button")
      : document.getElementById(mobilePane === "rooms" ? "c3-room-list-heading" : "c3-people-heading");
    heading?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing &&
        !document.querySelector('[popover="auto"]:popover-open, dialog:modal')) {
        event.preventDefault();
        setMobilePane("room");
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [mobilePane, sidebarsInline, setMobilePane]);
  useEffect(() => {
    if (!roomsRail || mobilePane !== "rooms") return;
    // The list over the stage closes on Escape or a press outside it; choosing a room closes it through selectRoom.
    const close = (event: KeyboardEvent | PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event instanceof KeyboardEvent ? event.key !== "Escape" || event.defaultPrevented || event.isComposing
        || !!document.querySelector('[popover="auto"]:popover-open, dialog:modal')
        : !target || !!target.closest("#c3-room-list, #c3-rooms-trigger, [popover], dialog")) return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      setMobilePane("room");
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); };
  }, [roomsRail, mobilePane, setMobilePane]);
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  // A picture's Watch and Retry report here: its offer, tile, help dialog and picture panel can all go first.
  // A result this owner can no longer receive still reaches the banner. A lost connection ends both owners, as it
  // ends the banner's claim: the session drops a result whose socket has gone, and a reconnect starts clean.
  const pictureAction = useKeyedSettingsAction(JSON.stringify([state?.channel.id, sessionId, connected]), publications);
  // A share start reports here: the picker closes first, and the room's share control moves to the tile once sharing starts.
  const shareStart = useSettingsAction(true, JSON.stringify([state?.channel.id, sessionId, roomId, connected]));
  const attemptPicture = (id: string, operation: (reportError: () => boolean) => Promise<void>) => {
    void pictureAction.run(id, operation);
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
  function watchTitle(url: string) { const source = new URL(url); return source.host + source.pathname; };
  const watchSources: WatchStageSource[] = stageWatches.map(activity => {
    const player = channel.watchPlayers.get(activity.id);
    const browserSource = canWatchInBrowser(activity.source, player);
    const owned = ownsWatch(activity.id);
    const subscription = state?.watchSubscriptions.find(value => value.id === activity.id);
    const available = connected && !!rooms.find(room => room.id === activity.roomId)?.available;
    return {
      kind: "watch", id: activity.id, roomId: activity.roomId, predecessor: activity.predecessor, pictureAdmitted: rooms.some(room => room.id === activity.roomId && room.authorized), userId: activity.userId, name: nameOfUser(activity.userId), title: watchTitle(activity.source.url),
      website: activity.source.kind === "website", originalPageAvailable: activity.playback.timeline === "media" && (!channel.appConnected || channel.pagePlayer), onFocusWindow: () => run(channel.focusWatch(activity.id)),
      originalPageUnavailable: activity.source.kind === "website" && activity.playback.timeline === "media" && channel.appConnected && !channel.pagePlayer
        ? t("watch.pageUnsupported") : undefined,
      browserSource,
      onAppWatch: !owned && activity.playback.timeline !== "program" && activity.source.kind === "website" && channel.appConnected && channel.pagePlayer && player?.presentation.kind !== "external" ? () => {
        showSource(activity.roomId, activity.id);
        setAppWatchId(activity.id);
      } : undefined,
      roomName: nameOfRoom(activity.roomId), avatar: userProfile(state, channel.profiles, activity.userId)?.avatar ?? undefined,
      owned, awaitingSource: channel.waitingWatchPages?.has(activity.id), subscribed: !!subscription || !!channel.waitingWatchPages?.has(activity.id), audience: state ? watchAudience(state, activity, channel.profiles) : [],
      receiving: !owned ? { peerAvailable: !!activity.byteSource, peerSupported: canReceivePeerWatch(activity.byteSource?.format, hlsSupported),
        failed: !!player?.error, mode: player?.mode ?? subscription?.mode ?? "direct",
        browserSource, pending: busy("watch-video", activity.id), disabled: !connected,
        onPeer: () => { showSource(activity.roomId, activity.id); run(channel.joinWatch(activity.id, "peer")); },
        onDirect: () => { showSource(activity.roomId, activity.id); run(channel.joinWatch(activity.id, "direct")); } } : undefined,
      shareControls: owned && <ChannelShareControl channel={channel} roomId={activity.roomId} onWatch={() => setWatchRoomId(activity.roomId)} compact disabled={!available} startAction={shareStart} />,
      hidden: activity.roomId !== roomId,
      paused: activity.playback.paused, player, available,
      pending: busy("watch", activity.id) || busy("watch-video", activity.id) || busy("stop", activity.id),
      onRoom: () => selectRoom(activity.roomId), onJoin: () => { showSource(activity.roomId, activity.id); run(channel.joinWatch(activity.id)); },
      onLeave: () => run(channel.leaveWatch(activity.id)), onStop: () => run(channel.stopWatch(activity.id)),
      onResume: () => run(channel.resumeWatch(activity.id)), onPlayback: patch => run(channel.setWatchPlayback(activity.id, patch)),
    };
  });
  const connectionLabel = connected ? t("channel.previewPage.connected") : connection === "connecting"
    ? t("channel.previewPage.connecting") : connection === "reconnecting" ? t("channel.previewPage.reconnecting") : t("channel.previewPage.disconnected");

  // The living layout's top bar is one row: the room's heading sits in it, between the site and the tools.
  const RoomHeading = living ? "div" : "header";
  const roomHeading = <RoomHeading className="c3-room-heading" data-tooltip-controls>
          <div className="c3-room-name">{layout !== "quick" && <span className="c3-pane-navigation"><Btn id="c3-rooms-trigger" icon="sidebar" quiet size="compact"
            title={{ text: t("channel.previewPage.roomList") }} hint="hint-room-list" controls="c3-room-list" expanded={mobilePane === "rooms"}
            onClick={showRooms} /></span>}<ChannelIdentityMark icon={room?.icon ?? "couch"} picture={room?.picture} size={25} />
            <Tooltip className="c3-room-title" overflow={{ text: room?.name ?? (unlistedRoom ? t("channel.previewPage.openRoom") : t("channel.previewPage.roomsOverview")), selector: "h2" }}>
              <h2>{room?.name ?? (unlistedRoom ? t("channel.previewPage.openRoom") : t("channel.previewPage.roomsOverview"))}</h2>
            </Tooltip>
            {room && <ChannelRoomInvitation key={room.id} channel={channel} room={room} onManageAccess={() => setManagedRoomId(room.id)} />}
          </div>
          <div className="c3-room-toolbar"><div className="c3-room-actions">
            {!living && (layout !== "quick" || visibleScreens.length > 0) && room?.authorized && !sharesIn(roomId) &&
              <ChannelShareControl channel={channel} roomId={roomId} onWatch={() => setWatchRoomId(roomId)} disabled={!connected || !room.available}
                openRequested={pickerRoom === roomId} onPickerRequestHandled={() => setPickerRoom(null)} startAction={shareStart} />}
          </div>
          <div className="c3-room-tools" role="group" aria-label={t("channel.previewPage.viewTools")}>
            {living && <span ref={setViewHome} className="c3-living-view" />}
            {room?.authorized && <ChannelConnections key={`connections:${roomId}`} channel={channel} roomId={roomId} />}
            {living && state && !overview && !roomToolOpen && <>
              <Btn icon="users" size="dense" quiet textTooltip title="channel.people.users" controls="c3-living-people"
                expanded={livingPane === "people"} pressed={livingPane === "people"} onClick={() => togglePanel("people")} />
              {hasPictures && !phone && <Btn id="c3-companion-trigger" icon="chat" size="dense" quiet textTooltip title="conversation.chat" controls="c3-chat"
                expanded={panel === "chat"} pressed={panel === "chat"} onClick={() => togglePanel("chat")} />}
            </>}
            {layout !== "quick" && !living && state && !overview && !roomToolOpen && <Btn id="c3-companion-trigger" icon={companionKind === "chat" ? "chat" : "users"}
              title={{ text: companionVisible ? t("channel.previewPage.hideSidePanel") : t("channel.previewPage.showSidePanel") }}
              size="dense" quiet expanded={companionVisible} textTooltip
              onClick={() => {
                if (sidebarsInline) setCompanionOpen(previous => ({ ...previous, [companionKind]: !previous[companionKind] }));
                else setMobilePane(companionVisible ? "room" : companionKind);
              }} />}
          </div></div>
        </RoomHeading>;
  return <LayerHistory.Provider value={sidebarsInline ? null : track}><div className="lr-app c3-app">
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
    {managedRoom && <ChannelRoomSettingsDialog key={managedRoom.id} channel={channel} room={managedRoom}
      onClose={closeRoomSettings} />}
    {newRoom !== null && <ChannelRoomCreateDialog channel={channel} creationPolicy={creationPolicy}
      initialName={typeof newRoom === "string" ? newRoom : ""} initialInterruption={newRoom instanceof RoomCreationInterrupted ? newRoom : null}
      onCreated={id => { selectRoom(id); if (newRoom instanceof RoomCreationInterrupted) { rememberSimpleShareRoom(simpleShareKey, id); setPickerRoom(id); } }} onClose={() => setNewRoom(null)} />}
    <main ref={workspaceElement} className={`c3-shell${living ? " c3-living" : ""}`} data-app-shell data-layout={layout} data-pane={mobilePane} data-view={sharingView ? "share" : "workspace"}
      data-sidebars={living ? phone ? "phone" : "inline" : sidebarsInline ? "inline" : "overlay"} data-overview={overview || undefined}
      data-rooms={living ? roomsRail ? "rail" : "list" : undefined} data-stage={living ? visibleScreens.length ? "pictures" : "empty" : undefined}
      data-chat={living ? livingChat : undefined}
      data-companion={companionVisible ? companionPane : "none"}>
      <header className="c3-site-bar"><div className="c3-site-identity">
        <button className="c3-site-home" type="button" aria-label={t("channel.previewPage.roomsOnThisSite")} onClick={() => selectRoom("")}><BrandMark size={30} motion="once" /></button>
        <div className="c3-site-name">{self && self.id === state?.channel.ownerId ? <ChannelSiteSettings channel={channel} />
          : <Tooltip overflow={{ text: state?.channel.name ?? "Piik", selector: "strong" }}><span className="c3-site-name-readonly"><ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={22} /><strong>{state?.channel.name ?? "Piik"}</strong></span></Tooltip>}</div>
        <LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
          label={connectionLabel} comic={connected ? "signal-connected" : connection === "closed" ? "signal-failed"
            : connection === "reconnecting" ? "signal-recovering" : "signal-connecting"} />
        {layout === "quick" && <Btn id="c3-rooms-trigger" icon="couch" quiet size="compact"
          title={{ text: t("channel.previewPage.roomList") }} cap={{ text: t("channel.previewPage.rooms") }} hint="hint-room-list"
          controls="c3-room-list" expanded={mobilePane === "rooms"} onClick={showRooms} />}
      </div>{living && roomHeading}<div className="lr-top c3-global-tools">
        <HeaderControls appControl={appControl} personalControls={<>
          {onLayoutChange && layout !== "living" && <ChannelInterfaceControl value={layout} onChange={onLayoutChange} />}
          <PlaybackDeviceSelect />
          <ChannelFeedbackSounds channel={channel} />
          <ChannelForwardingSettings channel={channel} />
          {previewOptions}
        </>} />
      </div></header>
      <aside id="c3-room-list" className="c3-sidebar" aria-label={t("channel.previewPage.rooms")}>
        <div className="c3-sidebar-browse">
        <div className={`c3-room-navigation${!rooms.length ? " is-empty" : ""}`}>
          <div className="c3-section-label"><span id="c3-room-list-heading" tabIndex={-1} className="c3-section-caption"><Cap k={{ text: t("channel.previewPage.rooms") }} /></span>
            <div className="c3-room-list-actions">{self && (canOrderRooms || orderingRooms) && <Btn icon={orderingRooms ? "check" : "grip"} size="dense" quiet textTooltip
              title={orderingRooms ? "room.order.done" : "room.order.edit"} pressed={orderingRooms}
              onClick={() => { setOrderingRooms(!orderingRooms); setDraggedRoom(null); setOrderAnnouncement(""); }} />}
              {canCreateRoom && <Btn icon="plus" size="dense" quiet hint="hint-create-room"
              title={{ text: t("channel.previewPage.createRoom") }} cap={!rooms.length ? { text: t("channel.previewPage.createRoom") } : undefined}
              expanded={newRoom !== null} disabled={!connected} onClick={() => setNewRoom("")} />}
              {!sidebarsInline && mobilePane === "rooms" && <BackButton onClick={returnToRoom} />}
              {sidebarsInline && <Btn id="c3-rooms-collapse" icon="sidebar" size="dense" quiet title={{ text: t("channel.previewPage.collapseRoomList") }}
                controls="c3-room-list" expanded={!sharingView} onClick={() => { if (!sharingView) toggleSharingView(); setMobilePane("room"); }} />}
            </div>
          </div>
          {orderingRooms && <p id="c3-room-order-help" className="c3-room-order-help">{t("room.order.help")}</p>}
          <span className="visually-hidden" role="status">{orderAnnouncement}</span>
          <nav className="c3-rooms" aria-label={t("channel.previewPage.rooms")}>
            {roomGroups.flatMap(({ available, rooms: groupedRooms }) => [
              <h3 key={available ? "group-online" : "group-offline"} className="c3-section-label c3-room-group-heading">
                {t(available ? "channel.people.online" : "channel.people.offline")}<span>{groupedRooms.length}</span>
              </h3>,
              ...groupedRooms.map((value, index) => <ChannelRoomListItem key={`room-${value.id}`} channel={channel} room={value}
                selected={roomId === value.id} settingsOpen={managedRoomId === value.id} unopened={channel.roomOpenFailures.has(value.id)}
                pile={living} nameHint={roomsRail && mobilePane !== "rooms"} ordering={orderingRooms && groupedRooms.length > 1 ? { index, total: groupedRooms.length,
                  active: activeDrag?.available === available && activeDrag.id !== value.id,
                  onDrag: () => setDraggedRoom({ id: value.id, available }), onEnd: () => setDraggedRoom(null),
                  onDrop: () => { if (activeDrag) reorderRoom(activeDrag.available, activeDrag.id, value.id); setDraggedRoom(null); },
                  onMove: direction => { const target = groupedRooms[index + direction]; if (target) reorderRoom(available, value.id, target.id); } } : undefined}
                onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />),
            ])}
          </nav>
          {state && !rooms.length && <p className="c3-room-list-empty">{t("channel.previewPage.noRoomsAvailableYet")}</p>}
        </div>
        </div>
      </aside>
      <div className="c3-personal" data-voice-elsewhere={living && voiceActivity && voiceActivity.roomId !== roomId || undefined}><div ref={voiceSlot} className="c3-room-slot" />
        {self && <div className="c3-identity"><PawnSvg centered color={participantColor(self.id)} identity={self.id} avatar={self.avatar ?? undefined} />
          <div><strong>{self.name}</strong><small>{t("channel.previewPage.yourName")}</small></div>
          <ChannelProfileEditor key={self.id} name={self.name} avatar={self.avatar} color={participantColor(self.id)} disabled={!connected} profileReady={channel.profiles.has(self.id)}
            busy={busy("profile")} onSave={channel.updateProfile} />
        </div>}
        {living && room?.authorized && <div className="c3-living-share">{sharesIn(roomId)
          // While I share here the bar's control ends it, as a call's share button does. The tile keeps its own.
          ? <Btn icon="stop" size="compact" tone="danger" title="host.stop" cap="host.stop" disabled={!connected}
            busy={livingShare ? busy("stop", livingShare.id) : false}
            onClick={() => { if (livingShare) run(livingShare.watch ? channel.stopWatch(livingShare.id) : channel.stopScreen(livingShare.id)); }} />
          : <ChannelShareControl channel={channel} roomId={roomId} onWatch={() => setWatchRoomId(roomId)} disabled={!connected || !room.available}
            openRequested={pickerRoom === roomId} onPickerRequestHandled={() => setPickerRoom(null)} startAction={shareStart} />}</div>}
        {living && phone && !overview && hasPictures && <Btn className="c3-living-chat" icon="chat" size="compact" quiet title="conversation.chat"
          controls="c3-chat" expanded={panel === "chat"} pressed={panel === "chat"} onClick={() => togglePanel("chat")} />}
      </div>
      <section className="c3-main" aria-label={room?.name ?? t("channel.previewPage.room")}>
        {!living && roomHeading}
        <div className="c3-main-body">
        {state && !connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span className="c3-notice-message">{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" hint="hint-reconnect" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && roomOpenFailure ? <div className="c3-notice is-error" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{t(roomOpenFailure.message)}</span><ChannelDiagnosisHelp diagnosis={roomOpenFailure} /></div>
          : room?.authorized && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{t(channel.messagesByRoom[room.id]?.length ? "room.offline.retained" : "room.offline.empty")}</span></div>}
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
                onClick={() => ended ? closeWaiting(source.id) : run(watch ? owned ? channel.stopWatch(source.id) : channel.leaveWatch(source.id) : owned ? channel.stopScreen(source.id) : channel.unwatch(source.id))} />
            </div>;
          })}
        </div>}
          {!state ? <ChannelSiteEntry channel={channel} failure={failure} /> : unlistedRoom
            ? <ChannelUnlistedRoomEntry key={selected} channel={channel} roomId={selected} onBack={() => selectRoom("")} />
            : overview && <section className="c3-site-overview">
            {layout === "quick" && canCreateRoom ? <StageTv hasEntry label={t("channel.previewPage.startSharing")}><div className="c3-quick-start">
              <p>{t(creationPolicy === "invite_only" ? "channel.previewPage.quickInviteOnlyHint" : "channel.previewPage.quickStartHint")}</p>
              <div className="c3-quick-start-action"><Btn id="c3-first-action" icon="cast" tone="primary" title={{ text: t("channel.previewPage.startSharing") }} cap={{ text: t("channel.previewPage.startSharing") }}
                disabled={!connected || busy("create-room")} busy={busy("create-room")} onClick={() => { void prepareShare(); }} />
                <ChannelSettingsError error={quickStart.error} /></div>
            </div></StageTv> : rooms.length ? <><h2><BrandMark size={30} motion="once" />{state.channel.name}</h2><div className="c3-overview-rooms">{rooms.map(value => <ChannelRoomItem key={value.id}
              room={value} selected={false} sourceCount={screens.filter(source => source.roomId === value.id).length + watches.filter(source => source.roomId === value.id).length}
              unread={roomHasUnread(value, channel.readByRoom[value.id])} unopened={channel.roomOpenFailures.has(value.id)}
              onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />)}</div></>
              : <div className="c3-first-room"><span className="c3-room-start-mark"><ChannelIdentityMark icon="couch" size={46} /></span>
                <h2>{t(canCreateRoom ? "channel.previewPage.startWithARoom" : "channel.previewPage.noRoomsAvailableYet")}</h2>
                <p>{t(canCreateRoom ? "channel.previewPage.firstRoomHint" : "channel.previewPage.ownerCreatesRooms")}</p>
                {canCreateRoom && <Btn id="c3-first-action" icon="plus" size="compact" tone="primary" hint="hint-create-room"
                  title={{ text: t("channel.previewPage.createYourFirstRoom") }} cap={{ text: t("channel.previewPage.createYourFirstRoom") }}
                  expanded={newRoom !== null} disabled={!connected} onClick={() => setNewRoom(t("channel.previewPage.livingRoom"))} />}
                {offerLayout && onLayoutChange && connected && layout !== "living" && <ChannelInterfaceSuggestion value={layout}
                  onChange={chooseInitialLayout} onDismiss={() => chooseInitialLayout(layout)} />}
              </div>}
          </section>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${inlineChatOpen && !roomToolOpen ? "" : " chat-collapsed"}`} hidden={overview}>
          {layout === "quick" && room?.authorized && room.available && !visibleScreens.length && <div className="c3-quick-entry-tv"><StageTv hasEntry label={t("channel.previewPage.shareAScreen")}>
            <div className="c3-quick-start"><ChannelShareControl channel={channel} roomId={roomId} onWatch={() => setWatchRoomId(roomId)} disabled={!connected || !room.available}
              openRequested={pickerRoom === roomId} onPickerRequestHandled={() => setPickerRoom(null)} startAction={shareStart} /></div>
          </StageTv></div>}
          <ChannelStage fit={living && `${phone ? "phone" : "wide"}:${livingPane}:${livingChat}:${roomsRail}`}
            layoutHome={living && !phone ? viewHome : undefined} theaterMode={theaterMode} buffering={{ target: channel.screenBufferTargetMs, status: channel.screenBufferStatus, onChange: channel.setScreenBufferTarget }} sources={[...[...activeScreens, ...availableScreens].map(publication => ({
            kind: "screen" as const, id: publication.id, roomId: publication.roomId, predecessor: publication.predecessor, pictureAdmitted: rooms.some(room => room.id === publication.roomId && room.authorized), userId: publication.userId, name: nameOfUser(publication.userId),
            hidden: !displayedSources.has(publication.id),
            source: publication.source, title: publication.title, onRoom: () => selectRoom(publication.roomId),
            avatar: userProfile(state, channel.profiles, publication.userId)?.avatar ?? undefined,
            audience: state ? screenAudience(state, publication, channel.profiles) : [],
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id), localSource: channel.localScreens.has(publication.id),
            shareControls: channel.ownedScreens.has(publication.id) && <ChannelShareControl channel={channel}
              roomId={publication.roomId} publicationId={publication.id} onWatch={() => setWatchRoomId(publication.roomId)} compact
              disabled={!connected || !rooms.find(room => room.id === publication.roomId)?.available} startAction={shareStart} />,
            paused: publication.paused, pausePending: publication.sessionId !== sessionId && busy("pause", publication.id),
            pauseAvailable: publication.sessionId === sessionId || connected,
            deliveryFailed: screenDeliveryFailed(publication, sessionId),
            pictureFailure: pictureAction.errors.get(publication.id), clearPictureFailure: () => pictureAction.clearError(publication.id),
            playbackError: channel.screenPlaybackError(publication.id),
            roomAdmitted: rooms.find(value => value.id === publication.roomId)?.authorized,
            deliveryScope: JSON.stringify([roomId, sessionId, publication.sessionId,
              rooms.find(value => value.id === publication.roomId)?.delivery?.bindingId]),
            awaitingRoute: connected && !channel.localScreens.has(publication.id) && !channel.ownedScreens.has(publication.id)
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
      <div className="c3-chat-panel">
        <div ref={sideConversationHome} className="c3-room-slot" /></div>
      {layout !== "quick" && (living
        ? <div id="c3-living-people" className="c3-living-people" hidden={livingPane !== "people"}>
          <ChannelPeople channel={channel} roomId={roomId} active={livingPane === "people"} onBack={() => setPanel("none")} /></div>
        : <ChannelPeople channel={channel} roomId={roomId} active={companionVisible && companionPane === "people"} onBack={returnToRoom} />)}
      <div className="c3-room-presence" data-empty={!room?.authorized || undefined}>
        <div ref={couchSlot} className="c3-room-slot" />
        <ChannelRoomTool key={`${state?.channel.id ?? ""}:${sessionId ?? ""}`} title={room?.name ?? t("channel.previewPage.room")} voiceRoomName={voiceRoomName}
          surface={toolSurface} onSurfaceChange={setToolSurface}
          preferPanel={layout === "quick"}
          actions={layout === "quick" && !roomToolOpen ? joinVoice : undefined}
          caption={room ? t("channel.previewPage.roomFriends", { name: room.name }) : t("channel.previewPage.friendsInThisRoom")}
          home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
          couch={room?.authorized && <ChannelCouch className="c3-room-company" people={state ? roomPeople(state, roomId, channel.profiles, channel) : []}
            floating={roomToolOpen && (layout !== "quick" || toolSurface.document !== document)} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
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
            onBack={!roomToolOpen && !sidebarsInline && visibleScreens.length > 0 ? returnToRoom : undefined}
            interaction={channel.interactionsByRoom.get(roomId) ?? null}
            onSend={channel.sendMessage} onDiscardSend={channel.discardMessageRetry} floating={roomToolOpen} hidden={conversationHidden} /></>}
          voice={<><section className="c3-voice-entry" aria-label={t("channel.previewPage.voiceInThisRoom")}>
            {(layout !== "quick" || roomToolOpen) && joinVoice && <><div><small>{t("channel.previewPage.currentRoom")}</small><strong>{room?.name}</strong></div>{joinVoice}</>}
          </section><ChannelVoiceDock channel={channel} selected={voiceFocus} renderingBySpeaker={renderingBySpeaker} onSelect={setVoiceFocus} onBrowse={selectRoom}
            labelled={living && !phone} /></>} />
      </div>
    </main>
  </div></LayerHistory.Provider>;
}
