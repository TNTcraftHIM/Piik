import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
import { BackButton, Btn, Cap } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useClipboardResult } from "../ui/use-clipboard-result";
import { useChannel } from "../channel/use-channel";
import { channelErrorPresentation } from "../channel/error-presentation";
import { rememberRoom, selectedRoom } from "../channel/navigation";
import { ChannelAudio } from "../channel/components/ChannelMedia";
import { ChannelAction } from "../channel/components/ChannelAction";
import { ChannelInviteQrCode } from "../channel/components/ChannelInviteQrCode";
import { ChannelStage } from "../channel/components/ChannelStage";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import { ChannelNameEditor } from "../channel/components/ChannelNameEditor";
import { ChannelRoomControls, ChannelRoomEntry } from "../channel/components/ChannelRoomControls";
import { ChannelBookmarks } from "../channel/components/ChannelBookmarks";
import { ChannelDomainControls } from "../channel/components/ChannelDomainControls";
import { ChannelDomainEntry } from "../channel/components/ChannelDomainEntry";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelCouch } from "../channel/components/ChannelCouch";
import { ChannelRoomTool, type RoomToolSurface } from "../channel/components/ChannelRoomTool";
import { ChannelConnections } from "../channel/components/ChannelConnections";
import { listeningVoicePublications, roomPeople } from "../channel/presentation";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
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
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "people">("room");
  const selectRoom = useCallback((id: string) => {
    onSelect(id); setMobilePane("room");
  }, [onSelect]);
  useEffect(() => { setMobilePane("room"); }, [selected]);
  const [domainControlSlot, setDomainControlSlot] = useState<HTMLSpanElement | null>(null);
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [sharingView, setSharingView] = useState(() => readRoomPreferences().sharingView);
  const [chatOpen, setChatOpen] = useState(!sharingView);
  const [toolSurface, setToolSurface] = useState<RoomToolSurface>({ open: false, document: null });
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [focusedScreen, setFocusedScreen] = useState<string | null>(null);
  const [voiceFocus, setVoiceFocus] = useState("");
  const invitationCopy = useClipboardResult(channel.inviteURL);
  const rooms = state?.channel.rooms ?? [];
  const room = rooms.find(value => value.id === selected) ?? rooms[0];
  const roomId = room?.id ?? "";
  useEffect(() => {
    if (sharingView && state && !rooms.length) setMobilePane("rooms");
  }, [sharingView, state?.channel.id, rooms.length]);
  const toggleSharingView = () => {
    const next = !sharingView;
    setSharingView(next);
    saveRoomPreferences({ sharingView: next });
    if (next) setChatOpen(false);
    setMobilePane(next && state && !rooms.length ? "rooms" : "room");
  };
  const connected = connection === "connected";
  const owner = !!self && state?.channel.ownerId === self.id;
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const publications = state?.publications ?? [];
  const screens = publications.filter(value => value.kind === "screen");
  const mine = screens.filter(value => channel.ownedScreens.has(value.id));
  const watched = screens.filter(value => !channel.ownedScreens.has(value.id) && state?.subscriptions.includes(value.id));
  const visibleScreens = [...mine, ...watched];
  const availableScreens = screens.filter(value => value.roomId === roomId && !visibleScreens.includes(value));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
  const onlineUsers = state?.users.filter(user => state.sessions.some(session => session.userId === user.id && session.online)) ?? [];
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
    if (mobilePane === "room") return;
    const heading = document.getElementById(mobilePane === "rooms" ? "c3-room-list-heading" : "c3-people-heading");
    heading?.focus();
    return () => { document.getElementById(mobilePane === "rooms" ? "c3-rooms-trigger" : "c3-people-trigger")?.focus(); };
  }, [mobilePane]);
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const connectionLabel = connected ? copy("已连接", "Connected") : connection === "connecting"
    ? copy("正在连接", "Connecting") : connection === "reconnecting" ? copy("正在重连", "Reconnecting") : copy("连接已断开", "Disconnected");

  return <div className={`lr-app c3-app${vis ? " c3-visual" : ""}`}>
    <AppHeader homeHref={`${location.pathname}${location.search}${location.hash}`} atHome
      appControl={appControl}
      led={<LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
        label={connectionLabel} comic={connected ? "signal-connected" : "signal-connecting"} />} />
    {state && failure.message && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span>{failure.message}</span>
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="compact" quiet onClick={channel.clearError} />
    </div>}
    <ChannelDomainControls channel={channel} triggerSlot={domainControlSlot} />
    {!state ? <ChannelDomainEntry channel={channel} failure={failure} /> : <main className="c3-shell" data-pane={mobilePane} data-view={sharingView ? "share" : "workspace"}>
      <ChannelBookmarks currentName={state?.channel.name ?? location.host}
        currentIcon={<ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={26} />} onCurrent={() => setMobilePane("rooms")} />
      <aside id="c3-room-list" className="c3-sidebar" aria-label={copy("域和房间", "Domain and rooms")}>
        <div className="c3-sidebar-browse">
        <div className="c3-channel-title c3-editable"><div><h1 id="c3-room-list-heading" tabIndex={-1}>{state?.channel.name ?? copy("你的域", "Your domain")}</h1>
          <span className="c3-channel-caption">{copy("域", "Domain")}</span></div>
          {owner && <span ref={setDomainControlSlot} />}
          <span className="c3-pane-back"><BackButton onClick={() => setMobilePane("room")} /></span>
        </div>
        {channel.inviteURL && <div className="c3-invite" role="group" aria-label={state.channel.access === "public" ? copy("域地址", "Domain address") : copy("域邀请", "Domain invitation")}>
          <span className="c3-invite-label">{!vis && (state.channel.access === "public" ? copy("域地址", "Domain address") : copy("域邀请", "Domain invitation"))}</span>
          <ChannelAction icon={invitationCopy.status === "copied" ? "check" : "link"} iconOnly
            label={invitationCopy.status === "copied" ? copy("已复制", "Copied") : state.channel.access === "public" ? copy("复制域地址", "Copy domain address") : copy("复制域邀请", "Copy domain invitation")}
            hint="hint-copy-invite" onClick={invitationCopy.copy} />
          <ChannelInviteQrCode url={channel.inviteURL} label={state.channel.access === "public" ? copy("域地址二维码", "Domain address QR code") : copy("域邀请二维码", "Domain invitation QR code")} />
        </div>}
        {state.channel.access === "private" && !owner && !channel.inviteURL && <p className="c3-room-list-empty">{copy("需要邀请朋友时，请向域主索取当前域邀请。", "Ask the domain owner for the current invitation to invite friends.")}</p>}
        {invitationCopy.status === "failed" && <label className="c3-copy-fallback">{state.channel.access === "public" ? copy("请手动复制域地址", "Copy domain address manually") : copy("请手动复制邀请链接", "Copy invitation manually")}
          <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} />
        </label>}
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
              return <button type="button" key={value.id} className="c3-room-link" aria-label={value.name}
                aria-current={roomId === value.id ? "page" : undefined} onClick={() => selectRoom(value.id)}>
                <ChannelIdentityMark icon={value.icon} size={21} /><strong>{value.name}</strong>
                <span className="c3-room-activity">
                  {value.access === "private" && <Glyph name="lock" size={13} />}
                  {voice && <Glyph name="headphones" size={14} />}
                  {sharing ? <Glyph name="cast" size={14} /> : watching ? <Glyph name="eye" size={14} />
                    : count > 0 ? <span>{count}<Glyph name="tv" size={13} /></span> : null}
                </span>
              </button>;
            })}
          </nav>
          {state && !rooms.length && <p className="c3-room-list-empty">{copy("暂无可进入的房间", "No rooms available yet")}</p>}
        </div>
        </div>
        {self && <div className="c3-identity"><PawnSvg color={participantColor(self.id)} identity={self.id} host={owner} />
          <div><strong>{self.name}</strong><small>{owner ? copy("域主", "Domain owner") : copy("你的名字", "Your name")}</small></div>
          <ChannelNameEditor name={self.name} disabled={!connected || busy("rename")} onSave={name => run(channel.renameSelf(name))} />
        </div>}
      </aside>
      <section className="c3-main" aria-label={room?.name ?? copy("房间", "Room")}>
        <header className="c3-room-heading">
          <div className="c3-room-name"><span className="c3-pane-navigation"><Btn id="c3-rooms-trigger" icon="arrowLeft" quiet size="compact"
            title={{ text: copy("房间列表", "Rooms") }} hint="hint-collapse" controls="c3-room-list" expanded={mobilePane === "rooms"}
            onClick={() => setMobilePane("rooms")} /></span><ChannelIdentityMark icon={room?.icon ?? "couch"} size={25} />
            <Tooltip className="c3-room-title" overflow={{ text: room?.name ?? copy("欢迎回来", "Welcome back"), selector: "h2" }}>
              <h2>{room?.name ?? copy("欢迎回来", "Welcome back")}</h2>
            </Tooltip>
            {(room?.authorized || room?.canManage) && <ChannelRoomControls key={`controls:${room.id}`} channel={channel} room={room} />}
          </div>
          <div className="c3-room-actions">
            {room?.authorized && <><ChannelShareControl channel={channel} roomId={roomId} disabled={!connected || !room.available} />
              <ChannelJoinVoice joined={joined} disabled={!connected || !room.available} busy={busy("voice", roomId)}
                onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /></>}
          </div>
          <div className="c3-room-tools">
            <span className="c3-view-toggle"><ChannelAction icon="tv" label={copy("分享视图", "Sharing view")}
              pressed={sharingView} quiet hint="hint-details" onClick={toggleSharingView} /></span>
            <ChannelRoomTool title={room?.name ?? copy("房间", "Room")} surface={toolSurface} onSurfaceChange={setToolSurface}
              home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
              couch={room?.authorized && <ChannelCouch className="c3-room-company" people={state ? roomPeople(state, roomId) : []}
                floating={toolSurface.open} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
              conversation={<>{room && !room.authorized && <ChannelRoomEntry key={room.id} channel={channel} room={room} />}
                <ChannelConversation roomId={roomId} roomName={room?.name ?? ""} roomIcon={room?.icon} messages={channel.messagesByRoom[roomId] ?? []}
                users={state?.users ?? []} selfUserId={self?.id ?? null} entry={self ? { kind: "domain" } : { kind: "entry" }}
                canSend={connected && !!room?.authorized && room.available} sending={busy("chat", roomId)}
                attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.authorized && room.available}
                history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
                onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
                isReactionPending={seq => busy(`reaction:${roomId}:${seq}`)} onReaction={channel.setMessageReaction}
                onSend={channel.sendMessage} floating={toolSurface.open} hidden={room?.authorized === false || (!toolSurface.open && visibleScreens.length > 0 && !chatOpen)} /></>}
              voice={<ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={selectRoom} />} />
            {room?.authorized && <ChannelConnections key={`connections:${roomId}`} channel={channel} roomId={roomId} />}
            {visibleScreens.length > 0 && !toolSurface.open && <ChannelAction icon="chat" label={chatOpen ? copy("收起聊天", "Hide chat") : copy("打开聊天", "Show chat")}
              iconOnly quiet pressed={chatOpen} hint={chatOpen ? "hint-close" : "hint-chat-open"} onClick={() => setChatOpen(!chatOpen)} />}
            <Tooltip className="c3-pane-navigation" kind="hint-details" disabled={mobilePane === "people"} text={vis ? undefined : copy("域内用户", "Domain users")}><button id="c3-people-trigger" type="button" className="c3-people-trigger"
              onClick={() => setMobilePane("people")} aria-label={copy("域内用户", "Domain users")} aria-controls="c3-people" aria-expanded={mobilePane === "people"}>
              <span className="c3-avatar-stack" aria-hidden="true">{onlineUsers.slice(0, 3).map(user =>
                <PawnSvg key={user.id} color={participantColor(user.id)} identity={user.id} />)}</span>
              <span>{onlineUsers.length}</span><Glyph name="chevron" size={14} />
            </button></Tooltip>
          </div>
          <div ref={couchSlot} className="c3-room-slot" />
        </header>
        {!connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span>{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" hint="hint-reconnect" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span>{copy("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.")}</span></div>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${chatOpen && !toolSurface.open ? "" : " chat-collapsed"}`}>
          <ChannelStage sources={[...visibleScreens, ...availableScreens].map(publication => ({
            id: publication.id, userId: publication.userId, name: nameOfUser(publication.userId),
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id),
            paused: publication.paused, pausePending: publication.sessionId !== sessionId && busy("pause", publication.id),
            pauseAvailable: publication.sessionId === sessionId || connected,
            deliveryFailed: state?.failedSubscriptions.includes(publication.id),
            available: rooms.find(value => value.id === publication.roomId)?.available ?? false,
            subscribed: state?.subscriptions.includes(publication.id) ?? false, stream: streams.get(publication.id), inputs: channel.screenInputs.get(publication.id),
            interaction: channel.interactionsByRoom.get(publication.roomId) ?? null,
            input: channel.inputChannels.get(publication.id),
            sourceAudio: (() => {
              const sound = channel.sourceAudio(publication.id);
              return sound && { ...sound, busy: busy("screen", publication.roomId), canMute: channel.sourceMicrophone(publication.id)?.browser,
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
          <div ref={conversationSlot} className="c3-room-slot" />
        </div>
        <div ref={voiceSlot} className="c3-room-slot" />
        {voiceStreams.map(publication => <ChannelAudio key={publication.id} stream={streams.get(publication.id)!}
          volume={channel.listeningVolume * (channel.voicePlaybackByUser.get(publication.userId)?.volume ?? 1)} createContext={createVoiceAudioContext}
          muted={(myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true) || (channel.voicePlaybackByUser.get(publication.userId)?.muted ?? false)}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
      <ChannelPeople channel={channel} roomId={roomId} onBack={() => setMobilePane("room")} />
    </main>}
  </div>;
}
