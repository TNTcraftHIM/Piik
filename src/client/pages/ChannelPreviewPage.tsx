import { useCallback, useEffect, useState } from "react";
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
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import { ChannelNameEditor } from "../channel/components/ChannelNameEditor";
import { ChannelRoomControls, ChannelRoomEntry } from "../channel/components/ChannelRoomControls";
import { ChannelBookmarks } from "../channel/components/ChannelBookmarks";
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
  const mine = screens.filter(value => value.sessionId === sessionId);
  const watched = screens.filter(value => value.sessionId !== sessionId && state?.subscriptions.includes(value.id));
  const visibleScreens = [...mine, ...watched];
  const availableScreens = screens.filter(value => value.roomId === roomId && !visibleScreens.includes(value));
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const joined = myVoice.some(value => value.roomId === roomId);
  const onlineUsers = state?.users.filter(user => state.sessions.some(session => session.userId === user.id && session.online)) ?? [];
  const nameOfRoom = (id: string) => rooms.find(value => value.id === id)?.name ?? id;
  const nameOfUser = (id: string) => state?.users.find(value => value.id === id)?.name ?? copy("用户", "User");
  const voiceStreams = publications.filter(value => value.kind === "voice" && value.sessionId !== sessionId &&
    state?.subscriptions.includes(value.id) && streams.has(value.id));
  const failure = channel.error ? channel.error === "room_runtime_unavailable"
    ? copy("房间运行组件尚未构建。请先构建 Browser room adapter，再刷新原型。", "Room runtime is not built. Build the Browser room adapter, then reload the prototype.")
    : channel.error === "directory_storage_failed"
      ? copy("房间操作已成功，但域目录保存失败。", "The room operation succeeded, but the domain directory could not be saved.")
    : channel.error === "app_disconnected"
      ? copy("App 已断开。请重新打开 App，再重新连接。", "The App disconnected. Open it again, then reconnect.")
    : channel.error === "owner_mismatch"
      ? copy("App 选择的数据不属于当前域或账号。请检查本机启动配置。", "The App data belongs to another domain or account. Check its local startup configuration.")
    : /room_host_conflict|room_storage_in_use/.test(channel.error)
      ? copy("另一个页面已接管这间房间。请关闭多余页面，再刷新本页。", "Another page has taken over this room. Close the extra page, then reload this page.")
    : channel.error === "room_host_offline"
      ? copy("房主暂时离线，请等待房主恢复房间。", "The room owner is offline. Wait for them to bring the room back.")
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
    <AppHeader homeHref={`${location.pathname}${location.search}${location.hash}`} atHome appControl={null} diagnosticControl={null}
      led={<LedStrip state={connected ? "live" : connection === "closed" ? "bad" : "busy"}
        label={connectionLabel} comic={connected ? "signal-connected" : "signal-connecting"} />} />
    <main className="c3-shell" data-pane={mobilePane}>
      <ChannelBookmarks currentName={state?.channel.name ?? location.host} onCurrent={() => setMobilePane("rooms")} />
      <aside id="c3-room-list" className="c3-sidebar" aria-label={copy("域和房间", "Domain and rooms")}>
        <div className="c3-channel-title"><div><h1 id="c3-room-list-heading" tabIndex={-1}>{state?.channel.name ?? copy("你的域", "Your domain")}</h1>
          <span className="c3-channel-caption">{copy("域", "Domain")}</span></div>
          <span className="c3-pane-back"><BackButton onClick={() => setMobilePane("room")} /></span>
        </div>
        {channel.inviteURL && <div className="c3-invite"><ChannelAction icon={copied ? "check" : "link"}
          label={copied ? copy("已复制", "Copied") : copy("邀请朋友", "Invite friends")} hint="hint-copy-invite" onClick={copyInvite} /></div>}
        {copyError && <label className="c3-copy-fallback">{copy("请手动复制邀请链接", "Copy invitation manually")}
          <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} />
        </label>}
        <div className="c3-room-navigation">
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
                <Glyph name={value.access === "private" ? "lock" : "couch"} size={21} /><strong>{value.name}</strong>
                <span className="c3-room-activity">
                  {voice && <Glyph name="headphones" size={14} />}
                  {sharing ? <Glyph name="cast" size={14} /> : watching ? <Glyph name="eye" size={14} />
                    : count > 0 ? <span>{count}<Glyph name="tv" size={13} /></span> : null}
                </span>
              </button>;
            })}
          </nav>
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
            onClick={() => setMobilePane("rooms")} /></span><Glyph name="couch" size={25} /><h2>{room?.name ?? copy("欢迎回来", "Welcome back")}</h2></div>
          <div className="c3-room-actions">
            {room?.authorized && <><ChannelAction icon="cast" label={copy("分享屏幕", "Share screen")} primary hint="hint-share-start"
              disabled={!connected || !room.available || !can("publish")} busy={busy("screen", roomId)} onClick={() => run(channel.startScreen(roomId))} />
              <ChannelJoinVoice joined={joined} disabled={!connected || !room.available || !can("voice")} busy={busy("voice", roomId)}
                onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /></>}
          </div>
          <div className="c3-room-tools">
            {room?.canManage && <ChannelRoomControls channel={channel} room={room} />}
            {visibleScreens.length > 0 && <ChannelAction icon="chat" label={chatOpen ? copy("收起聊天", "Hide chat") : copy("打开聊天", "Show chat")}
              iconOnly quiet pressed={chatOpen} hint={chatOpen ? "hint-close" : "hint-chat-open"} onClick={() => setChatOpen(!chatOpen)} />}
            <Tooltip className="c3-pane-navigation" kind="hint-details" disabled={mobilePane === "people"} text={vis ? undefined : copy("域内用户", "Domain users")}><button id="c3-people-trigger" type="button" className="c3-people-trigger"
              onClick={() => setMobilePane("people")} aria-label={copy("域内用户", "Domain users")} aria-controls="c3-people" aria-expanded={mobilePane === "people"}>
              <span className="c3-avatar-stack" aria-hidden="true">{onlineUsers.slice(0, 3).map(user =>
                <PawnSvg key={user.id} color={participantColor(user.id)} identity={user.id} />)}</span>
              <span>{onlineUsers.length}</span><Glyph name="chevron" size={14} />
            </button></Tooltip>
          </div>
        </header>
        {!connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span>{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" onClick={channel.reconnect} />}
        </div>}
        {room && !room.available && <div className="c3-notice" role="status"><Glyph name="couch" size={20} />
          <span>{copy("房主暂时离线，房间会在房主回来后恢复。", "The room owner is offline. The room will return when they reconnect.")}</span></div>}
        {self && !owner && !permissions.size && <div className="c3-notice" role="status"><Glyph name="lock" size={20} />
          <span>{copy("当前为只读。请联系域主分配身份组。", "Read-only access. Ask the domain owner for a role to participate.")}</span></div>}
        {failure && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span>{failure}</span>
          <Btn icon="x" title="notice.dismiss" size="compact" quiet onClick={channel.clearError} />
        </div>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${chatOpen ? "" : " chat-collapsed"}`}>
          <ChannelStage sources={[...visibleScreens, ...availableScreens].map(publication => ({
            id: publication.id, userId: publication.userId, name: nameOfUser(publication.userId),
            roomName: nameOfRoom(publication.roomId), local: publication.sessionId === sessionId,
            available: rooms.find(value => value.id === publication.roomId)?.available ?? false,
            subscribed: state?.subscriptions.includes(publication.id) ?? false, stream: streams.get(publication.id), inputs: channel.screenInputs.get(publication.id),
            pending: busy(publication.sessionId === sessionId ? "stop" : "watch", publication.id),
          }))} focusedId={focusedScreen} onFocus={setFocusedScreen} canSubscribe={connected && can("subscribe")}
            onWatch={id => run(channel.watch(id))} onUnwatch={id => run(channel.unwatch(id))}
            onStop={id => run(channel.stopScreen(id))} onPresentation={channel.screenPresentation} />
          {room && !room.authorized ? <ChannelRoomEntry key={room.id} channel={channel} room={room} /> : <ChannelConversation roomId={roomId} roomName={room?.name ?? ""} messages={channel.messagesByRoom[roomId] ?? []}
            users={state?.users ?? []} canSend={connected && !!roomId && !!room?.available && can("chat")} sending={busy("chat", roomId)}
            attachments={channel.attachments} attachmentsAvailable={room?.capabilities.attachments ?? false} available={connected && !!room?.available}
            history={channel.historyByRoom[roomId]} loadingHistory={busy("history", roomId)}
            onHistory={channel.loadHistory} onLatest={channel.loadLatestHistory}
            onSend={channel.sendMessage} hidden={visibleScreens.length > 0 && !chatOpen} />}
        </div>
        <ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={selectRoom} />
        {voiceStreams.map(publication => <ChannelAudio key={publication.id} stream={streams.get(publication.id)!}
          muted={myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
      <ChannelPeople channel={channel} roomId={roomId} onBack={() => setMobilePane("room")} />
    </main>
  </div>;
}
