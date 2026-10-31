import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
import { BackButton, Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { ChannelAction, ChannelAudio } from "../channel/components/ChannelMedia";
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
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelCouch } from "../channel/components/ChannelCouch";
import { ChannelRoomTool, type RoomToolSurface } from "../channel/components/ChannelRoomTool";
import { listeningVoicePublications, roomPeople } from "../channel/presentation";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { channelAppDiscovery } from "../channel/app-link";
import "../channel/bootstrap";
import "./channel-preview.css";

export function ChannelPreviewPage() {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [selected, setSelected] = useState(() => new URLSearchParams(location.hash.slice(1)).get("room") ?? "");
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "people">("room");
  const selectRoom = useCallback((id: string) => { setSelected(id); setMobilePane("room"); }, []);
  const channel = useChannel(selectRoom);
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [chatOpen, setChatOpen] = useState(true);
  const [toolSurface, setToolSurface] = useState<RoomToolSurface>({ open: false, document: null });
  const couchSlot = useRef<HTMLDivElement>(null), conversationSlot = useRef<HTMLDivElement>(null), voiceSlot = useRef<HTMLDivElement>(null);
  const [focusedScreen, setFocusedScreen] = useState<string | null>(null);
  const [voiceFocus, setVoiceFocus] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const rooms = state?.channel.rooms ?? [];
  const room = rooms.find(value => value.id === selected) ?? rooms[0];
  const roomId = room?.id ?? "";
  const connected = connection === "connected";
  const owner = !!self && state?.channel.ownerId === self.id;
  const permissions = new Set(state?.channel.roles.filter(role => self?.roles.includes(role.id)).flatMap(role => role.permissions));
  const can = (permission: string) => owner || permissions.has(permission);
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
  const failure = channel.error ? channel.error === "webassembly_unavailable"
    ? copy("当前浏览器不支持 WebAssembly，无法使用房间。请更新浏览器或使用支持 WebAssembly 的浏览器。", "This browser does not support WebAssembly, which Piik needs for rooms. Update your browser or use one that supports WebAssembly.")
    : channel.error === "room_runtime_unavailable"
      ? copy("未能加载房间组件。请刷新页面后重试。", "Could not load room components. Reload the page and try again.")
    : channel.error === "directory_storage_failed"
      ? copy("房间操作已成功，但域目录保存失败。", "The room operation succeeded, but the domain directory could not be saved.")
    : channel.error === "app_disconnected"
      ? copy("与 App 的连接已断开。请确认 App 正在运行，然后重试。", "Connection to the App was lost. Check that it is running, then retry.")
    : channel.error === "capture_failed"
      ? copy("未能开始分享，请重新选择窗口或屏幕。", "Could not start sharing. Choose a window or screen again.")
    : channel.error === "capture_audio_failed"
      ? copy("无法分享声音，画面分享仍在继续。", "Could not share sound. Screen sharing continues.")
    : channel.error === "owner_mismatch"
      ? copy("App 中的房间数据属于另一个域或账号。请确认当前站点和登录账号。", "The App room data belongs to another domain or account. Check the current site and signed-in account.")
    : /room_host_conflict|room_storage_in_use/.test(channel.error)
      ? copy("这间房间已在另一处打开。请回到正在托管它的页面或 App。", "This room is already open elsewhere. Return to the page or App hosting it.")
    : channel.error === "room_host_offline"
      ? copy("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.")
    : /password/i.test(channel.error)
    ? copy("房间密码不正确，请重新输入。", "The room password is incorrect. Please try again.")
    : /room_access|room_forbidden/i.test(channel.error)
      ? copy("你还没有这间房间的访问权限。", "You don't have access to this room.")
    : /invite|credential|unauthorized|join_required/i.test(channel.error)
    ? copy("需要有效邀请。请打开域主提供的完整邀请链接。", "A valid invitation is required. Open the full link from the domain owner.")
    : channel.error === "session_expired"
      ? copy("连接超时，采集已停止。重新连接后可再次分享或加入语音。", "Connection timed out. Capture stopped. Reconnect to share or join voice again.")
    : /permission|forbidden|denied|notallowed/i.test(channel.error)
      ? copy("未获允许。请检查身份组及浏览器的采集权限。", "Permission was declined. Check your roles and browser capture permission.")
    : /room_(path_unavailable|delivery_unavailable|unavailable|control_busy)|peer_data_unavailable|data_channel_(unavailable|busy)|request_timeout/.test(channel.error)
      ? copy("房间通信未能完成，请重试。", "Room communication did not complete. Please try again.")
    : channel.error === "incomplete_history"
      ? copy("聊天记录接收不完整，请重新加载。", "Chat history was interrupted. Please load it again.")
    : /unavailable|notfound|notreadable/i.test(channel.error)
      ? copy("设备暂不可用，请检查浏览器权限及设备占用。", "Device unavailable. Check browser permissions and other apps.")
    : /disconnect|closed|offline/i.test(channel.error)
      ? copy("连接已断开，请重新连接后再试。", "Connection lost. Reconnect and try again.")
      : copy("未能完成操作，请重试。", "Could not complete the action. Please try again.") : null;
  useEffect(() => {
    if (!roomId) return;
    setSelected(roomId);
    channel.browse(roomId);
  }, [roomId, room?.authorized, room?.available]);
  useEffect(() => { setCopied(false); setCopyError(false); }, [channel.inviteURL]);
  useEffect(() => {
    if (mobilePane === "room") return;
    const heading = document.getElementById(mobilePane === "rooms" ? "c3-room-list-heading" : "c3-people-heading");
    heading?.focus();
    return () => { document.getElementById(mobilePane === "rooms" ? "c3-rooms-trigger" : "c3-people-trigger")?.focus(); };
  }, [mobilePane]);
  function copyInvite() {
    if (!channel.inviteURL) return;
    void navigator.clipboard.writeText(channel.inviteURL).then(() => {
      setCopied(true); setCopyError(false);
    }).catch(() => setCopyError(true));
  }
  const run = (operation: Promise<void>) => { void operation.catch(() => {}); };
  const connectionLabel = connected ? copy("已连接", "Connected") : connection === "connecting"
    ? copy("正在连接", "Connecting") : connection === "reconnecting" ? copy("正在重连", "Reconnecting") : copy("连接已断开", "Disconnected");

  return <div className={`lr-app c3-app${vis ? " c3-visual" : ""}`}>
    <AppHeader homeHref={`${location.pathname}${location.search}${location.hash}`} atHome
      appControl={<AppConnectionButton discovery={channelAppDiscovery} onConnected={() => run(channel.activateApp())} />} diagnosticControl={null}
      led={<LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
        label={connectionLabel} comic={connected ? "signal-connected" : "signal-connecting"} />} />
    {failure && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span>{failure}</span>
      <Btn icon="x" title="notice.dismiss" size="compact" quiet onClick={channel.clearError} />
    </div>}
    <main className="c3-shell" data-pane={mobilePane}>
      <ChannelBookmarks currentName={state?.channel.name ?? location.host}
        currentIcon={<ChannelIdentityMark icon={state?.channel.icon ?? "couch"} size={26} />} onCurrent={() => setMobilePane("rooms")} />
      <aside id="c3-room-list" className="c3-sidebar" aria-label={copy("域和房间", "Domain and rooms")}>
        <div className="c3-channel-title c3-editable"><div><h1 id="c3-room-list-heading" tabIndex={-1}>{state?.channel.name ?? copy("你的域", "Your domain")}</h1>
          <span className="c3-channel-caption">{copy("域", "Domain")}</span></div>
          {state && owner && <ChannelDomainControls channel={channel} />}
          <span className="c3-pane-back"><BackButton onClick={() => setMobilePane("room")} /></span>
        </div>
        {channel.inviteURL && <div className="c3-invite"><ChannelAction icon={copied ? "check" : "link"}
          label={copied ? copy("已复制", "Copied") : copy("邀请朋友", "Invite friends")} hint="hint-copy-invite" onClick={copyInvite} /></div>}
        {copyError && <label className="c3-copy-fallback">{copy("请手动复制邀请链接", "Copy invitation manually")}
          <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} />
        </label>}
        <div className={`c3-room-navigation${!rooms.length ? " is-empty" : ""}`}>
          <div className="c3-section-label"><span className="c3-section-caption">{copy("房间", "Rooms")}</span>
            {can("create_room") && <ChannelRoomControls channel={channel} onCreated={selectRoom} />}
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
            </Tooltip></div>
          <div className="c3-room-actions">
            {room?.authorized && <><ChannelShareControl channel={channel} roomId={roomId} disabled={!connected || !room.available || !can("publish")} />
              <ChannelJoinVoice joined={joined} disabled={!connected || !room.available || !can("voice")} busy={busy("voice", roomId)}
                onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /></>}
          </div>
          <div className="c3-room-tools">
            <ChannelRoomTool title={room?.name ?? copy("房间", "Room")} surface={toolSurface} onSurfaceChange={setToolSurface}
              home={{ couch: couchSlot, conversation: conversationSlot, voice: voiceSlot }}
              couch={room?.authorized && <ChannelCouch className="c3-room-company" people={state ? roomPeople(state, roomId) : []}
                floating={toolSurface.open} selfUserId={self?.id ?? null} session={channel.interactionsByRoom.get(roomId) ?? null} />}
              conversation={<>{room && !room.authorized && <ChannelRoomEntry key={room.id} channel={channel} room={room} />}
                <ChannelConversation roomId={roomId} roomName={room?.name ?? ""} roomIcon={room?.icon} messages={channel.messagesByRoom[roomId] ?? []}
                users={state?.users ?? []} selfUserId={self?.id ?? null} entry={self ? { kind: "domain", canCreate: can("create_room") } : { kind: "entry" }}
                canSend={connected && !!room?.authorized && room.available && can("chat")} sending={busy("chat", roomId)}
                attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.authorized && room.available}
                history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
                onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
                isReactionPending={seq => busy(`reaction:${roomId}:${seq}`)} onReaction={channel.setMessageReaction}
                onSend={channel.sendMessage} floating={toolSurface.open} hidden={room?.authorized === false || (!toolSurface.open && visibleScreens.length > 0 && !chatOpen)} /></>}
              voice={<ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={selectRoom} />} />
            {room?.canManage && <ChannelRoomControls key={room.id} channel={channel} room={room} />}
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
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span>{copy("房间暂不可用，请等待恢复托管。", "This room is unavailable. Wait for hosting to resume.")}</span></div>}
        {self && !owner && !permissions.size && <div className="c3-notice" role="status"><Glyph name="lock" size={20} />
          <span>{copy("当前为只读。请联系域主分配身份组。", "Read-only access. Ask the domain owner for a role to participate.")}</span></div>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${chatOpen && !toolSurface.open ? "" : " chat-collapsed"}`}>
          <ChannelStage sources={[...visibleScreens, ...availableScreens].map(publication => ({
            id: publication.id, userId: publication.userId, name: nameOfUser(publication.userId),
            roomName: nameOfRoom(publication.roomId), owned: channel.ownedScreens.has(publication.id),
            available: rooms.find(value => value.id === publication.roomId)?.available ?? false,
            subscribed: state?.subscriptions.includes(publication.id) ?? false, stream: streams.get(publication.id), inputs: channel.screenInputs.get(publication.id),
            input: channel.inputChannels.get(publication.id),
            remoteControl: (() => {
              const remote = channel.remoteControls.get(publication.id);
              return remote && { ...remote, requests: remote.requests.map(request => ({ ...request,
                name: nameOfUser(state?.sessions.find(session => session.id === request.peerId)?.userId ?? request.peerId) })) };
            })(),
            pending: busy(channel.ownedScreens.has(publication.id) ? "stop" : "watch", publication.id),
          }))} focusedId={focusedScreen} onFocus={setFocusedScreen} canSubscribe={connected && can("subscribe")}
            onWatch={id => run(channel.watch(id))} onUnwatch={id => run(channel.unwatch(id))}
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
    </main>
  </div>;
}
