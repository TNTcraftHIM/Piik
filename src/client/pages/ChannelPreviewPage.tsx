import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HeaderControls, LedStrip } from "../components/living/Header";
import { StageTv } from "../components/living/Stage";
import { BrandMark } from "../components/living/BrandMark";
import { Btn, Cap } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { channelErrorPresentation } from "../channel/error-presentation";
import { rememberRoom, selectedRoom } from "../channel/navigation";
import { ChannelAudio } from "../channel/components/ChannelMedia";
import { ChannelStage, type WatchStageSource } from "../channel/components/ChannelStage";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import { ChannelProfileEditor } from "../channel/components/ChannelProfileEditor";
import { ChannelFeedbackSounds } from "../channel/components/ChannelFeedbackSounds";
import { ChannelInterfaceControl, ChannelInterfaceSuggestion } from "../channel/components/ChannelInterfaceControl";
import { ChannelRoomCreateDialog, ChannelRoomSettingsDialog, roomDraft, roomSettings } from "../channel/components/ChannelRoomControls";
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
import { listeningVoicePublications, roomPeople, screenAudience, screenTitle, userProfile } from "../channel/presentation";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import { useClientNavigationTarget } from "../channel/client-navigation";
import { readRoomPreferences, saveRoomPreferences, type InterfaceLayout } from "../lib/room-preferences";
import { useElementWidth } from "../lib/use-element-width";
import type { ChannelController } from "../channel/types";
import "../channel/bootstrap";
import "./channel-preview.css";

export function ChannelPreviewPage() {
  const [selected, setSelected] = useState(selectedRoom);
  // Capture incoming hashes before the session's admission listener can consume them.
  const targetURL = useClientNavigationTarget(selected);
  const [layout, setLayout] = useState(() => readRoomPreferences().interfaceLayout);
  const changeLayout = useCallback((value: InterfaceLayout) => {
    setLayout(value); saveRoomPreferences({ interfaceLayout: value });
  }, []);
  const onSelect = useCallback((id: string) => { rememberRoom(id); setSelected(id); }, []);
  const channel = useChannel(onSelect);
  return <ChannelRoomPage channel={channel} selected={selected} onSelect={onSelect} layout={layout ?? "workspace"} offerLayout={layout === undefined} onLayoutChange={changeLayout}
    appControl={<AppConnectionButton discovery={channelAppDiscovery} connected={channel.appConnected} targetURL={targetURL}
      onConnected={() => { void channel.activateApp().catch(() => {}); }} />} />;
}

/** Session and App connection owners supply data; this view keeps one set of room slots. */
export function ChannelRoomPage({ channel, selected, onSelect, appControl, layout = "workspace", offerLayout = false, onLayoutChange }: {
  channel: ChannelController; selected: string; onSelect(id: string): void; appControl: ReactNode;
  layout?: InterfaceLayout; offerLayout?: boolean;
  onLayoutChange?: (value: InterfaceLayout) => void;
}) {
  const { t, lang, vis } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [pickerRoom, setPickerRoom] = useState<string | null>(null);
  const preparingShare = useRef<object | null>(null);
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "people" | "chat">("room");
  const selectRoom = useCallback((id: string) => {
    preparingShare.current = null; setPickerRoom(null);
    onSelect(id); setSourceView(null); setMobilePane("room");
  }, [onSelect]);
  useEffect(() => { setMobilePane("room"); preparingShare.current = null; }, [selected]);
  useEffect(() => { if (pickerRoom && pickerRoom !== selected) setPickerRoom(null); }, [selected, pickerRoom]);
  useEffect(() => () => { preparingShare.current = null; }, []);
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [sharingView, setSharingView] = useState(() => readRoomPreferences().sharingView);
  const [workspaceElement, workspaceWidth] = useElementWidth();
  const sidebarsInline = layout !== "quick" && workspaceWidth > 1080;
  const [companionOpen, setCompanionOpen] = useState({ people: false, chat: true });
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState<string | null>(null);
  const closeRoomSettings = useCallback(() => setManagedRoomId(null), []);
  useEffect(() => { setMobilePane("room"); }, [sidebarsInline, layout]);
  const [toolSurface, setToolSurface] = useState<RoomToolSurface>({ open: false, document: null });
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [sourceView, setSourceView] = useState<{ roomId: string; focusedId: string | null } | null>(() => ({ roomId: selected, focusedId: null }));
  const previousOwnedScreens = useRef<ReadonlySet<string>>(new Set(channel.ownedScreens));
  const [voiceFocus, setVoiceFocus] = useState("");
  const rooms = state?.channel.rooms ?? [];
  const room = rooms.find(value => value.id === selected);
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
    if (sharingView && state && !rooms.length) setMobilePane("rooms");
  }, [sharingView, state?.channel.id, rooms.length]);
  const toggleSharingView = () => {
    const next = !sharingView;
    setSharingView(next);
    saveRoomPreferences({ sharingView: next });
    setMobilePane(next && state && !rooms.length ? "rooms" : "room");
  };
  const showRooms = () => {
    if (layout === "quick" || !sidebarsInline) { setMobilePane(mobilePane === "rooms" ? "room" : "rooms"); return; }
    if (sharingView) toggleSharingView();
    setMobilePane("room");
  };
  const connected = connection === "connected";
  const chooseInitialLayout = (value: InterfaceLayout) => {
    onLayoutChange?.(value);
    requestAnimationFrame(() => document.getElementById("c3-first-action")?.focus());
  };
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const prepareShare = async () => {
    if (preparingShare.current || pending.has("create-room")) return;
    const operation = preparingShare.current = {};
    try {
      const id = await channel.createRoom(roomSettings({ ...roomDraft(), name: copy("屏幕共享", "Screen sharing") }));
      if (preparingShare.current !== operation) return;
      selectRoom(id); setPickerRoom(id);
    } catch { /* The session presents creation errors. */ }
    finally { if (preparingShare.current === operation) preparingShare.current = null; }
  };
  const publications = state?.publications ?? [];
  const screens = publications.filter(value => value.kind === "screen");
  const mine = screens.filter(value => channel.ownedScreens.has(value.id));
  const watched = screens.filter(value => !channel.ownedScreens.has(value.id) && state?.subscriptions.includes(value.id));
  const activeScreens = [...mine, ...watched];
  const watches = state?.watchActivities ?? [];
  const ownsWatch = (id: string) => watches.some(activity => activity.id === id && activity.sessionId === sessionId);
  const activeWatches = watches.filter(activity => ownsWatch(activity.id) || state?.watchSubscriptions.includes(activity.id));
  const activeSources = [...activeScreens, ...activeWatches];
  const visibleScreens = activeSources.filter(source => source.roomId === roomId && sourceView?.roomId === roomId);
  const otherScreens = activeSources.filter(source => !visibleScreens.includes(source));
  const focusedScreen = sourceView?.roomId === roomId ? sourceView.focusedId : null;
  const showSource = (sourceRoom: string, focusedId: string | null) => {
    onSelect(sourceRoom); setSourceView({ roomId: sourceRoom, focusedId }); setMobilePane("room");
  };
  useEffect(() => {
    const owned = [...mine, ...watches.filter(activity => activity.sessionId === sessionId)];
    const added = owned.find(source => source.roomId === roomId && !previousOwnedScreens.current.has(source.id));
    previousOwnedScreens.current = new Set(owned.map(source => source.id));
    if (added) setSourceView({ roomId: added.roomId, focusedId: added.id });
  }, [roomId, mine.map(source => source.id).join(","), watches.map(source => source.id).join(",")]);
  const companionKind = visibleScreens.length > 0 ? "chat" : "people";
  const companionPane = sidebarsInline ? companionKind : mobilePane;
  const companionVisible = layout !== "quick" && !overview && !toolSurface.open && (sidebarsInline
    ? companionOpen[companionKind]
    : mobilePane === "people" || mobilePane === "chat");
  const inlineChatOpen = companionVisible && companionPane === "chat";
  const mainConversationHome = useCallback((node: HTMLDivElement | null) => { if (!visibleScreens.length) conversationSlot.current = node; }, [!!visibleScreens.length]);
  const sideConversationHome = useCallback((node: HTMLDivElement | null) => { if (visibleScreens.length) conversationSlot.current = node; }, [!!visibleScreens.length]);
  const availableScreens = screens.filter(value => value.roomId === roomId && !activeScreens.includes(value));
  const displayedSources = new Set([...visibleScreens, ...availableScreens].map(source => source.id));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
  const joinVoice = room?.authorized && !joined ? <ChannelJoinVoice joined={false} disabled={!connected || !room.available} busy={busy("voice", roomId)}
    onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /> : null;
  const nameOfRoom = (id: string) => rooms.find(value => value.id === id)?.name ?? id;
  const nameOfUser = (id: string) => state?.users.find(value => value.id === id)?.name ?? copy("用户", "User");
  const voiceStreams = listeningVoicePublications(state, sessionId, streams);
  const voiceAudioContext = useRef<AudioContext | null>(null);
  const createVoiceAudioContext = useCallback(() => voiceAudioContext.current ??= new AudioContext(), []);
  const closeVoiceAudioContext = useCallback(() => {
    void voiceAudioContext.current?.close().catch(() => {});
    voiceAudioContext.current = null;
  }, []);
  useEffect(() => { if (!voiceStreams.length) closeVoiceAudioContext(); }, [voiceStreams.length, closeVoiceAudioContext]);
  useEffect(() => closeVoiceAudioContext, [closeVoiceAudioContext]);
  const failure = channelErrorPresentation(channel.error, t);
  useEffect(() => {
    if (!state) return;
    channel.browse(roomId);
  }, [state?.channel.id, roomId, room?.authorized, room?.available]);
  useEffect(() => {
    if (mobilePane === "room" || mobilePane === "chat") return;
    const heading = document.getElementById(mobilePane === "rooms" ? "c3-room-list-heading" : "c3-people-heading");
    heading?.focus();
    const pane = heading?.closest("aside");
    return () => {
      if (pane?.contains(document.activeElement))
        document.getElementById(mobilePane === "rooms" ? "c3-rooms-trigger" : "c3-companion-trigger")?.focus();
    };
  }, [mobilePane]);
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const watchTitle = (url: string) => { const source = new URL(url); return source.host + source.pathname; };
  const watchSources: WatchStageSource[] = watches.filter(activity => activeWatches.includes(activity) || activity.roomId === roomId).map(activity => ({
    kind: "watch", id: activity.id, userId: activity.userId, name: nameOfUser(activity.userId), title: watchTitle(activity.url),
    roomName: nameOfRoom(activity.roomId), avatar: userProfile(state, channel.profiles, activity.userId)?.avatar ?? undefined,
    owned: ownsWatch(activity.id), subscribed: state?.watchSubscriptions.includes(activity.id) ?? false,
    shareControls: ownsWatch(activity.id) && <ChannelShareControl channel={channel} roomId={activity.roomId} compact disabled={!connected || !rooms.find(room => room.id === activity.roomId)?.available} />,
    hidden: activity.roomId !== roomId || activeWatches.includes(activity) && !visibleScreens.includes(activity),
    paused: activity.playback.paused, player: channel.watchPlayers.get(activity.id),
    pending: busy("watch", activity.id) || busy("stop", activity.id), available: connected && !!rooms.find(room => room.id === activity.roomId)?.available,
    onRoom: () => selectRoom(activity.roomId), onJoin: () => { showSource(activity.roomId, activity.id); run(channel.joinWatch(activity.id)); },
    onLeave: () => run(channel.leaveWatch(activity.id)), onStop: () => run(channel.stopWatch(activity.id)),
    onResume: () => run(channel.resumeWatch(activity.id)), onPlayback: patch => run(channel.setWatchPlayback(activity.id, patch)),
  }));
  const connectionLabel = connected ? copy("已连接", "Connected") : connection === "connecting"
    ? copy("正在连接", "Connecting") : connection === "reconnecting" ? copy("正在重连", "Reconnecting") : copy("连接已断开", "Disconnected");

  return <div className={`lr-app c3-app${vis ? " c3-visual" : ""}`}>
    {state && failure.message && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span className="c3-notice-message">{failure.message}</span>
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="compact" quiet onClick={channel.clearError} />
    </div>}
    {managedRoom && <ChannelRoomSettingsDialog key={managedRoom.id} channel={channel} room={managedRoom}
      onClose={closeRoomSettings} />}
    {newRoomName !== null && <ChannelRoomCreateDialog channel={channel} initialName={newRoomName}
      onCreated={selectRoom} onClose={() => setNewRoomName(null)} />}
    <main ref={workspaceElement} className="c3-shell" data-layout={layout} data-pane={mobilePane} data-view={sharingView ? "share" : "workspace"} data-sidebars={sidebarsInline ? "inline" : "overlay"} data-overview={overview || undefined}
      data-companion={companionVisible ? companionPane : "none"}>
      <header className="c3-site-bar"><div className="c3-site-identity">
        {layout === "quick" ? <span className="c3-site-home"><BrandMark size={30} motion="once" /></span>
          : <button className="c3-site-home" type="button" aria-label={copy("本站房间总览", "Rooms on this site")} onClick={() => selectRoom("")}><BrandMark size={30} motion="once" /></button>}
        <div className="c3-site-name">{layout !== "quick" && self && self.id === state?.channel.ownerId ? <ChannelSiteSettings channel={channel} />
          : <Tooltip overflow={{ text: state?.channel.name ?? "Piik", selector: "strong" }}><span className="c3-site-name-readonly"><ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={22} /><strong>{state?.channel.name ?? "Piik"}</strong></span></Tooltip>}</div>
        <LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
          label={connectionLabel} comic={connected ? "signal-connected" : "signal-connecting"} />
        {layout === "quick" && <Btn id="c3-rooms-trigger" icon="couch" quiet size="compact"
          title={{ text: copy("房间列表", "Rooms") }} cap={{ text: copy("房间", "Rooms") }} hint="hint-room-list"
          controls="c3-room-list" expanded={mobilePane === "rooms"} onClick={showRooms} />}
      </div><div className="lr-top c3-global-tools">
        <HeaderControls appControl={appControl} personalControls={<>
          {onLayoutChange && <ChannelInterfaceControl value={layout} onChange={onLayoutChange} />}
          <ChannelFeedbackSounds channel={channel} />
        </>} />
      </div></header>
      <aside id="c3-room-list" className="c3-sidebar" onKeyDown={event => {
        if (!sidebarsInline && mobilePane === "rooms" && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault(); setMobilePane("room");
        }
      }} aria-label={copy("房间", "Rooms")}>
        <div className="c3-sidebar-browse">
        <div className={`c3-room-navigation${!rooms.length ? " is-empty" : ""}`}>
          <div className="c3-section-label"><span id="c3-room-list-heading" tabIndex={-1} className="c3-section-caption"><Cap k={{ text: copy("房间", "Rooms") }} /></span>
            <div className="c3-room-list-actions">{self && <Btn icon="plus" size="dense" quiet hint="hint-create-room"
              title={{ text: copy("创建房间", "Create room") }} cap={!rooms.length ? { text: copy("创建房间", "Create room") } : undefined}
              expanded={newRoomName !== null} disabled={!connected} onClick={() => setNewRoomName("")} />}
              {sidebarsInline && <Btn icon="sidebar" size="dense" quiet title={{ text: copy("收起房间列表", "Collapse room list") }}
                controls="c3-room-list" expanded={!sharingView} onClick={() => { if (!sharingView) toggleSharingView(); setMobilePane("room"); }} />}
            </div>
          </div>
          <nav className="c3-rooms" aria-label={copy("房间", "Rooms")}>
            {rooms.map(value => <ChannelRoomListItem key={value.id} channel={channel} room={value}
              selected={roomId === value.id} settingsOpen={managedRoomId === value.id}
              onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />)}
          </nav>
          {state && !rooms.length && <p className="c3-room-list-empty">{copy("暂无可进入的房间", "No rooms available yet")}</p>}
        </div>
        </div>
      </aside>
      <div className="c3-personal"><div ref={voiceSlot} className="c3-room-slot" />
        {self && <div className="c3-identity"><PawnSvg color={participantColor(self.id)} identity={self.id} avatar={self.avatar ?? undefined} />
          <div><strong>{self.name}</strong><small>{copy("你的名字", "Your name")}</small></div>
          <ChannelProfileEditor key={self.id} name={self.name} avatar={self.avatar} color={participantColor(self.id)} disabled={!connected || self.version !== state?.users.find(user => user.id === self.id)?.version}
            busy={busy("profile")} onSave={channel.updateProfile} />
        </div>}
      </div>
      <section className="c3-main" aria-label={room?.name ?? copy("房间", "Room")}>
        <header className="c3-room-heading">
          <div className="c3-room-name">{layout !== "quick" && <span className="c3-pane-navigation"><Btn id="c3-rooms-trigger" icon="sidebar" quiet size="compact"
            title={{ text: copy("房间列表", "Rooms") }} hint="hint-room-list" controls="c3-room-list" expanded={mobilePane === "rooms"}
            onClick={showRooms} /></span>}<ChannelIdentityMark icon={room?.icon ?? "couch"} size={25} />
            <Tooltip className="c3-room-title" overflow={{ text: room?.name ?? (unlistedRoom ? copy("打开房间", "Open room") : copy("房间总览", "Rooms")), selector: "h2" }}>
              <h2>{room?.name ?? (unlistedRoom ? copy("打开房间", "Open room") : copy("房间总览", "Rooms"))}</h2>
            </Tooltip>
            {room && <ChannelRoomInvitation channel={channel} room={room} onManageAccess={() => setManagedRoomId(room.id)} />}
          </div>
          <div className="c3-room-toolbar"><div className="c3-room-actions">
            {(layout !== "quick" || visibleScreens.length > 0) && room?.authorized && !mine.some(source => source.roomId === roomId) && !activeWatches.some(source => source.roomId === roomId && ownsWatch(source.id)) &&
              <ChannelShareControl channel={channel} roomId={roomId} disabled={!connected || !room.available}
                openRequested={layout !== "quick" && pickerRoom === roomId} onPickerOpened={() => setPickerRoom(null)} />}
          </div>
          <div className="c3-room-tools" role="group" aria-label={copy("视图工具", "View tools")}>
            {room?.authorized && <ChannelConnections key={`connections:${roomId}`} channel={channel} roomId={roomId} />}
            {layout !== "quick" && state && !overview && !toolSurface.open && <Btn id="c3-companion-trigger" icon={companionKind === "chat" ? "chat" : "users"}
              title={{ text: companionVisible ? copy("收起侧栏", "Hide side panel") : copy("展开侧栏", "Show side panel") }}
              size="dense" quiet expanded={companionVisible} hint="hint-collapse"
              onClick={() => {
                if (sidebarsInline) setCompanionOpen(previous => ({ ...previous, [companionKind]: !previous[companionKind] }));
                else setMobilePane(companionVisible ? "room" : companionKind);
              }} />}
          </div></div>
        </header>
        <div className="c3-main-body">
        {state && !connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span className="c3-notice-message">{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" hint="hint-reconnect" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{copy("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.")}</span></div>}
        {otherScreens.length > 0 && <div className="c3-other-activities" aria-label={copy("进行中的画面", "Ongoing screens")}>
          {otherScreens.map(source => {
            const watch = "url" in source;
            const owned = watch ? ownsWatch(source.id) : channel.ownedScreens.has(source.id), title = watch ? watchTitle(source.url) : screenTitle(source, lang);
            return <div key={source.id} className="c3-other-activity"><Glyph name={owned ? "cast" : "eye"} size={17} />
              <span><small>{owned ? copy("仍在分享", "Still sharing") : copy("仍在观看", "Still watching")}</small>
                <strong>{title}</strong><span className="c3-activity-room">{nameOfRoom(source.roomId)}</span></span>
              <Btn icon="arrowLeft" quiet size="dense" title={{ text: copy(`返回 ${nameOfRoom(source.roomId)}`, `Return to ${nameOfRoom(source.roomId)}`) }}
                cap={{ text: copy("返回", "Return") }} onClick={() => showSource(source.roomId, source.id)} />
              <Btn icon={owned ? "stop" : "x"} quiet size="dense" tone={owned ? "danger" : undefined}
                title={{ text: owned ? copy(`停止分享 ${title}`, `Stop sharing ${title}`) : copy(`停止观看 ${title}`, `Stop watching ${title}`) }}
                busy={busy(owned ? "stop" : "watch", source.id)} disabled={busy(owned ? "stop" : "watch", source.id)}
                onClick={() => run(watch ? owned ? channel.stopWatch(source.id) : channel.leaveWatch(source.id) : owned ? channel.stopScreen(source.id) : channel.unwatch(source.id))} />
            </div>;
          })}
        </div>}
          {!state ? <ChannelSiteEntry channel={channel} failure={failure} /> : unlistedRoom
            ? <ChannelUnlistedRoomEntry key={selected} channel={channel} roomId={selected} onBack={() => selectRoom("")} />
            : overview && <section className="c3-site-overview">
            {layout === "quick" ? <StageTv hasEntry label={copy("开始分享", "Start sharing")}><div className="c3-quick-start">
              <p>{copy("选择要分享的画面，再把邀请发给朋友。", "Choose a screen, then invite your friends.")}</p>
              <Btn id="c3-first-action" icon="cast" tone="primary" title={{ text: copy("开始分享", "Start sharing") }} cap={{ text: copy("开始分享", "Start sharing") }}
                disabled={!connected || busy("create-room")} busy={busy("create-room")} onClick={() => { void prepareShare(); }} />
            </div></StageTv> : rooms.length ? <><h2><ChannelIdentityMark icon={state.channel.icon} size={30} />{state.channel.name}</h2><div className="c3-overview-rooms">{rooms.map(value => <ChannelRoomItem key={value.id}
              room={value} selected={false} sourceCount={screens.filter(source => source.roomId === value.id).length + watches.filter(source => source.roomId === value.id).length}
              unread={value.authorized && value.lastMessageSeq > (channel.readByRoom[value.id] ?? value.lastMessageSeq)}
              onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />)}</div></>
              : <div className="c3-first-room"><span className="c3-room-start-mark"><ChannelIdentityMark icon="couch" size={46} /></span>
                <h2>{copy("从一间房间开始", "Start with a room")}</h2>
                <p>{copy("先创建房间，再把邀请发给朋友。聊天、语音和分享都在房间里。", "Create a room, then invite your friends. Chat, voice and screen sharing happen there.")}</p>
                <Btn id="c3-first-action" icon="plus" size="compact" tone="primary" hint="hint-create-room"
                  title={{ text: copy("创建第一间房间", "Create your first room") }} cap={{ text: copy("创建第一间房间", "Create your first room") }}
                  expanded={newRoomName !== null} disabled={!connected} onClick={() => setNewRoomName(copy("客厅", "Living room"))} />
                {offerLayout && onLayoutChange && connected && <ChannelInterfaceSuggestion value={layout}
                  onChange={chooseInitialLayout} onDismiss={() => chooseInitialLayout(layout)} />}
              </div>}
          </section>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${inlineChatOpen && !toolSurface.open ? "" : " chat-collapsed"}`} hidden={overview}>
          {layout === "quick" && room?.authorized && !visibleScreens.length && <div className="c3-quick-entry-tv"><StageTv hasEntry label={copy("分享画面", "Share a screen")}>
            <div className="c3-quick-start"><ChannelShareControl channel={channel} roomId={roomId} disabled={!connected || !room.available}
              openRequested={pickerRoom === roomId} onPickerOpened={() => setPickerRoom(null)} /></div>
          </StageTv></div>}
          <ChannelStage buffering={{ target: channel.screenBufferTargetMs, status: channel.screenBufferStatus, onChange: channel.setScreenBufferTarget }} sources={[...[...activeScreens, ...availableScreens].map(publication => ({
            kind: "screen" as const, id: publication.id, userId: publication.userId, name: nameOfUser(publication.userId),
            hidden: !displayedSources.has(publication.id),
            source: publication.source, title: publication.title, onRoom: () => selectRoom(publication.roomId),
            avatar: userProfile(state, channel.profiles, publication.userId)?.avatar ?? undefined,
            audience: state ? screenAudience(state, publication, channel.profiles) : [],
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id), localSource: channel.localScreens.has(publication.id),
            shareControls: channel.ownedScreens.has(publication.id) && <ChannelShareControl channel={channel}
              roomId={publication.roomId} publicationId={publication.id} compact
              disabled={!connected || !rooms.find(room => room.id === publication.roomId)?.available} />,
            paused: publication.paused, pausePending: publication.sessionId !== sessionId && busy("pause", publication.id),
            pauseAvailable: publication.sessionId === sessionId || connected,
            deliveryFailed: state?.failedSubscriptions.includes(publication.id),
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
            pending: busy(channel.ownedScreens.has(publication.id) ? "stop" : "watch", publication.id),
          })), ...watchSources]} focusedId={focusedScreen} onFocus={id => setSourceView({ roomId, focusedId: id })} canSubscribe={connected}
            onWatch={id => { showSource(roomId, id); run(channel.watch(id)); }} onUnwatch={id => run(channel.unwatch(id))}
            onPause={(id, paused) => run(channel.setScreenPaused(id, paused))}
            onStop={id => run(channel.stopScreen(id))} onPresentation={channel.screenPresentation}
            onInputPolicy={channel.inputPolicy} onInputDecide={channel.inputDecide} onInputSimultaneous={channel.inputSimultaneous} onInputShortcut={channel.inputShortcut} />
          <div ref={mainConversationHome} className="c3-room-slot" />
        </div>
        </div>
        {voiceStreams.map(publication => <ChannelAudio key={publication.id} stream={streams.get(publication.id)!}
          volume={channel.listeningVolume * (channel.voicePlaybackByUser.get(publication.userId)?.volume ?? 1)} createContext={createVoiceAudioContext}
          muted={(myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true) || (channel.voicePlaybackByUser.get(publication.userId)?.muted ?? false)}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
      <div className="c3-chat-panel"><div ref={sideConversationHome} className="c3-room-slot" /></div>
      {layout !== "quick" && <ChannelPeople channel={channel} roomId={roomId} active={companionVisible && companionPane === "people"} onBack={() => setMobilePane("room")} />}
      <div className="c3-room-presence" data-empty={!room?.authorized || undefined}>
        <div ref={couchSlot} className="c3-room-slot" />
        <ChannelRoomTool title={room?.name ?? copy("房间", "Room")} surface={toolSurface} onSurfaceChange={setToolSurface}
          preferPanel={layout === "quick"}
          actions={layout === "quick" && !toolSurface.open ? joinVoice : undefined}
          caption={room ? copy(`${room.name}的朋友`, `Friends in ${room.name}`) : copy("房间里的朋友", "Friends in this room")}
          home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
          couch={room?.authorized && <ChannelCouch className="c3-room-company" people={state ? roomPeople(state, roomId, channel.profiles) : []}
            floating={toolSurface.open && (layout !== "quick" || toolSurface.document !== document)} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
          conversation={<>{room && !room.authorized && <ChannelRoomEntry key={room.id} channel={channel} room={room} />}
            <ChannelConversation domainId={state?.channel.id} roomId={roomId} roomName={room?.name ?? ""} roomIcon={room?.icon} messages={channel.messagesByRoom[roomId] ?? []}
            users={state?.users ?? []} profiles={channel.profiles} queryProfiles={channel.queryProfiles} entry={self ? { kind: "site" } : { kind: "entry" }}
            canSend={connected && !!room?.authorized && room.available} sending={busy("chat", roomId)}
            attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.authorized && room.available}
            history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
            onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
            onMessage={channel.loadMessage} onRead={channel.markRead} unreadAfter={channel.readByRoom[roomId]} selfUserId={self?.id}
            onBack={!toolSurface.open && !sidebarsInline && visibleScreens.length > 0 ? () => setMobilePane("room") : undefined}
            interaction={channel.interactionsByRoom.get(roomId) ?? null}
            onSend={channel.sendMessage} floating={toolSurface.open} hidden={room?.authorized === false || (!toolSurface.open && visibleScreens.length > 0 && !inlineChatOpen)} /></>}
          voice={<><section className="c3-voice-entry" aria-label={copy("当前房间语音", "Voice in this room")}>
            {(layout !== "quick" || toolSurface.open) && joinVoice && <><div><small>{copy("当前房间", "Current room")}</small><strong>{room?.name}</strong></div>{joinVoice}</>}
          </section><ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={selectRoom} /></>} />
      </div>
    </main>
  </div>;
}
