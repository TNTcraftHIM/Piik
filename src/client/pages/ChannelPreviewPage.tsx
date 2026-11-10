import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
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
import { ChannelStage } from "../channel/components/ChannelStage";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import { ChannelNameEditor } from "../channel/components/ChannelNameEditor";
import { ChannelRoomControls, ChannelRoomEntry, ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelBookmarks } from "../channel/components/ChannelBookmarks";
import { ChannelDomainMenu } from "../channel/components/ChannelDomainMenu";
import { ChannelRoomInvitation } from "../channel/components/ChannelRoomInvitation";
import { ChannelDomainEntry } from "../channel/components/ChannelDomainEntry";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelCouch } from "../channel/components/ChannelCouch";
import { ChannelRoomTool, type RoomToolSurface } from "../channel/components/ChannelRoomTool";
import { ChannelConnections } from "../channel/components/ChannelConnections";
import { listeningVoicePublications, roomPeople, screenAudience } from "../channel/presentation";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
import { useElementWidth } from "../lib/use-element-width";
import type { ChannelController } from "../channel/types";
import "../channel/bootstrap";
import "./channel-preview.css";

export function ChannelPreviewPage() {
  const [selected, setSelected] = useState(selectedRoom);
  const onSelect = useCallback((id: string) => { rememberRoom(id); setSelected(id); }, []);
  const channel = useChannel(onSelect);
  return <ChannelRoomPage channel={channel} selected={selected} onSelect={onSelect}
    appControl={<AppConnectionButton discovery={channelAppDiscovery} connected={channel.appConnected}
      onConnected={() => { void channel.activateApp().catch(() => {}); }} />} />;
}

/** Session and App connection owners supply data; this view keeps one set of room slots. */
export function ChannelRoomPage({ channel, selected, onSelect, appControl }: {
  channel: ChannelController; selected: string; onSelect(id: string): void; appControl: ReactNode;
}) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "people" | "chat">("room");
  const [peopleScope, setPeopleScope] = useState<"room" | "domain">("room");
  const selectRoom = useCallback((id: string) => {
    onSelect(id); setMobilePane("room"); setPeopleScope("room");
  }, [onSelect]);
  useEffect(() => { setMobilePane("room"); }, [selected]);
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [sharingView, setSharingView] = useState(() => readRoomPreferences().sharingView);
  const [workspaceElement, workspaceWidth] = useElementWidth();
  const sidebarsInline = workspaceWidth > 1080;
  const [companionOpen, setCompanionOpen] = useState(true);
  const [managedRoomId, setManagedRoomId] = useState<string | null>(null);
  const closeRoomSettings = useCallback(() => setManagedRoomId(null), []);
  const inlineChatOpen = mobilePane === "chat" || sidebarsInline && companionOpen && mobilePane !== "people";
  const companionVisible = sidebarsInline ? companionOpen : mobilePane === "people" || mobilePane === "chat";
  useEffect(() => { if (sidebarsInline) setMobilePane("room"); }, [sidebarsInline]);
  const [toolSurface, setToolSurface] = useState<RoomToolSurface>({ open: false, document: null });
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [focusedScreen, setFocusedScreen] = useState<string | null>(null);
  const [voiceFocus, setVoiceFocus] = useState("");
  const rooms = state?.channel.rooms ?? [];
  const room = rooms.find(value => value.id === selected) ?? rooms[0];
  const roomId = room?.id ?? "";
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
    if (sidebarsInline) {
      if (sharingView) toggleSharingView();
      setMobilePane("room");
    } else setMobilePane("rooms");
  };
  const connected = connection === "connected";
  const owner = !!self && state?.channel.ownerId === self.id;
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const publications = state?.publications ?? [];
  const screens = publications.filter(value => value.kind === "screen");
  const mine = screens.filter(value => channel.ownedScreens.has(value.id));
  const watched = screens.filter(value => !channel.ownedScreens.has(value.id) && state?.subscriptions.includes(value.id));
  const visibleScreens = [...mine, ...watched];
  const mainConversationHome = useCallback((node: HTMLDivElement | null) => { if (!visibleScreens.length) conversationSlot.current = node; }, [!!visibleScreens.length]);
  const sideConversationHome = useCallback((node: HTMLDivElement | null) => { if (visibleScreens.length) conversationSlot.current = node; }, [!!visibleScreens.length]);
  const availableScreens = screens.filter(value => value.roomId === roomId && !visibleScreens.includes(value));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
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
  const failure = channelErrorPresentation(channel.error, copy);
  useEffect(() => {
    if (!state) return;
    onSelect(roomId);
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
  const connectionLabel = connected ? copy("已连接", "Connected") : connection === "connecting"
    ? copy("正在连接", "Connecting") : connection === "reconnecting" ? copy("正在重连", "Reconnecting") : copy("连接已断开", "Disconnected");

  return <div className={`lr-app c3-app${vis ? " c3-visual" : ""}`}>
    <AppHeader homeHref={`${location.pathname}${location.search}${location.hash}`} atHome
      appControl={appControl}
      led={<LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
        label={connectionLabel} comic={connected ? "signal-connected" : "signal-connecting"} />} />
    {state && failure.message && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span className="c3-notice-message">{failure.message}</span>
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="compact" quiet onClick={channel.clearError} />
    </div>}
    {managedRoom && <ChannelRoomSettingsDialog key={managedRoom.id} channel={channel} room={managedRoom}
      onClose={closeRoomSettings} />}
    {!state ? <ChannelDomainEntry channel={channel} failure={failure} /> : <main ref={workspaceElement} className="c3-shell" data-pane={mobilePane} data-view={sharingView ? "share" : "workspace"} data-sidebars={sidebarsInline ? "inline" : "overlay"}
      data-companion={companionVisible ? mobilePane === "people" || !visibleScreens.length ? "people" : toolSurface.open ? "none" : "chat" : "none"}>
      <ChannelBookmarks currentName={state?.channel.name ?? location.host}
        currentIcon={<ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={26} />} onCurrent={showRooms} />
      <aside id="c3-room-list" className="c3-sidebar" aria-label={copy("域和房间", "Domain and rooms")}>
        <div className="c3-sidebar-browse">
        <div className="c3-channel-title">
          <ChannelDomainMenu channel={channel} onPeople={() => { setPeopleScope("domain"); if (sidebarsInline) setCompanionOpen(true); setMobilePane("people"); }} />
          <Btn icon="sidebar" size="dense" quiet title={{ text: copy("收起房间列表", "Collapse room list") }}
            controls="c3-room-list" expanded={!sharingView} onClick={() => { if (sidebarsInline && !sharingView) toggleSharingView(); setMobilePane("room"); }} />
        </div>
        <div className={`c3-room-navigation${!rooms.length ? " is-empty" : ""}`}>
          <div className="c3-section-label"><span className="c3-section-caption"><Cap k={{ text: copy("房间", "Rooms") }} /></span>
            {self && <ChannelRoomControls channel={channel} onCreated={selectRoom} />}
          </div>
          <nav className="c3-rooms" aria-label={copy("房间", "Rooms")}>
            {rooms.map(value => {
              const voice = myVoice.some(activity => activity.roomId === value.id);
              const sharing = mine.some(activity => activity.roomId === value.id);
              const watching = watched.some(activity => activity.roomId === value.id);
              const count = screens.filter(screen => screen.roomId === value.id).length;
              return <ChannelRoomItem key={value.id} room={value} selected={roomId === value.id}
                voice={voice} sharing={sharing} watching={watching} screenCount={count} settingsOpen={managedRoomId === value.id}
                onSelect={() => selectRoom(value.id)} onManage={() => setManagedRoomId(value.id)} />;
            })}
          </nav>
          {state && !rooms.length && <p className="c3-room-list-empty">{copy("暂无可进入的房间", "No rooms available yet")}</p>}
        </div>
        </div>
      </aside>
      <div className="c3-personal"><div ref={voiceSlot} className="c3-room-slot" />
        {self && <div className="c3-identity"><PawnSvg color={participantColor(self.id)} identity={self.id} host={owner} />
          <div><strong>{self.name}</strong><small>{owner ? copy("域主", "Domain owner") : copy("你的名字", "Your name")}</small></div>
          <ChannelNameEditor name={self.name} disabled={!connected || busy("rename")} onSave={name => run(channel.renameSelf(name))} />
        </div>}
      </div>
      <section className="c3-main" aria-label={room?.name ?? copy("房间", "Room")}>
        <header className="c3-room-heading">
          <div className="c3-room-name"><span className="c3-pane-navigation"><Btn id="c3-rooms-trigger" icon="sidebar" quiet size="compact"
            title={{ text: copy("房间列表", "Rooms") }} hint="hint-room-list" controls="c3-room-list" expanded={mobilePane === "rooms"}
            onClick={showRooms} /></span><ChannelIdentityMark icon={room?.icon ?? "couch"} size={25} />
            <Tooltip className="c3-room-title" overflow={{ text: room?.name ?? copy("欢迎回来", "Welcome back"), selector: "h2" }}>
              <h2>{room?.name ?? copy("欢迎回来", "Welcome back")}</h2>
            </Tooltip>
            {room && <ChannelRoomInvitation channel={channel} room={room} />}
          </div>
          <div className="c3-room-actions">
            {room?.authorized && !mine.some(source => source.roomId === roomId) &&
              <ChannelShareControl channel={channel} roomId={roomId} disabled={!connected || !room.available} />}
          </div>
          <div className="c3-room-tools">
            {room?.authorized && <ChannelConnections key={`connections:${roomId}`} channel={channel} roomId={roomId} />}
            {!toolSurface.open && <Btn id="c3-companion-trigger" icon="sidebar" title={{ text: companionVisible ? copy("收起侧栏", "Hide side panel") : copy("展开侧栏", "Show side panel") }}
              size="dense" quiet expanded={companionVisible} hint={companionVisible ? "hint-collapse" : "hint-chat-open"}
              onClick={() => {
                if (sidebarsInline) setCompanionOpen(!companionOpen);
                else { setPeopleScope("room"); setMobilePane(companionVisible ? "room" : visibleScreens.length ? "chat" : "people"); }
              }} />}
          </div>
        </header>
        {!connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span className="c3-notice-message">{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" hint="hint-reconnect" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span className="c3-notice-message">{copy("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.")}</span></div>}
        <div className="c3-main-body"><div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${inlineChatOpen && !toolSurface.open ? "" : " chat-collapsed"}`}>
          <ChannelStage sources={[...visibleScreens, ...availableScreens].map(publication => ({
            id: publication.id, userId: publication.userId, name: nameOfUser(publication.userId),
            audience: state ? screenAudience(state, publication) : [],
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id),
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
          }))} focusedId={focusedScreen} onFocus={setFocusedScreen} canSubscribe={connected}
            onWatch={id => run(channel.watch(id))} onUnwatch={id => run(channel.unwatch(id))}
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
      <ChannelPeople channel={channel} roomId={roomId} scope={peopleScope} onBack={() => setMobilePane("room")} />
      <div className="c3-room-presence" data-empty={!room?.authorized || undefined}>
        <span>{room?.name}</span><div ref={couchSlot} className="c3-room-slot" />
        <ChannelRoomTool title={room?.name ?? copy("房间", "Room")} surface={toolSurface} onSurfaceChange={setToolSurface}
          home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
          couch={room?.authorized && <ChannelCouch className="c3-room-company" people={state ? roomPeople(state, roomId) : []}
            floating={toolSurface.open} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
          conversation={<>{room && !room.authorized && <ChannelRoomEntry key={room.id} channel={channel} room={room} />}
            <ChannelConversation roomId={roomId} roomName={room?.name ?? ""} roomIcon={room?.icon} messages={channel.messagesByRoom[roomId] ?? []}
            users={state?.users ?? []} entry={self ? { kind: "domain" } : { kind: "entry" }}
            canSend={connected && !!room?.authorized && room.available} sending={busy("chat", roomId)}
            attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.authorized && room.available}
            history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
            onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
            onBack={!toolSurface.open && !sidebarsInline && visibleScreens.length > 0 ? () => setMobilePane("room") : undefined}
            interaction={channel.interactionsByRoom.get(roomId) ?? null}
            onSend={channel.sendMessage} floating={toolSurface.open} hidden={room?.authorized === false || (!toolSurface.open && visibleScreens.length > 0 && !inlineChatOpen)} /></>}
          voice={<><section className="c3-voice-entry" aria-label={copy("当前房间语音", "Voice in this room")}>
            {room?.authorized && !joined && <><div><small>{copy("当前房间", "Current room")}</small><strong>{room.name}</strong></div>
              <ChannelJoinVoice joined={false} disabled={!connected || !room.available} busy={busy("voice", roomId)}
                onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /></>}
          </section><ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={selectRoom} /></>} />
      </div>
    </main>}
  </div>;
}
