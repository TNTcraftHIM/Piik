import { useEffect, useRef, useState } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
import { Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Tooltip } from "../components/living/Tooltip";
import { useAnchoredPopover } from "../components/living/use-anchored-popover";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { ChannelAction, ChannelAudio, ChannelVideo } from "../channel/components/ChannelMedia";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelJoinVoice } from "../channel/components/ChannelJoinVoice";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { ChannelPeople } from "../channel/components/ChannelPeople";
import "./channel-preview.css";

export function ChannelPreviewPage() {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const channel = useChannel();
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [selected, setSelected] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [voiceFocus, setVoiceFocus] = useState("");
  const [roomName, setRoomName] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createPanel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(createTrigger, createPanel, { side: "below" });
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
  const failure = channel.error ? /invite|credential|unauthorized|join_required/i.test(channel.error)
    ? copy("需要有效邀请。请打开频道主提供的完整邀请链接。", "A valid invitation is required. Open the full link from the channel owner.")
    : channel.error === "session_expired"
      ? copy("连接超时，采集已停止。重新连接后可再次分享或加入语音。", "Connection timed out. Capture stopped. Reconnect to share or join voice again.")
    : /permission|forbidden|denied|notallowed/i.test(channel.error)
      ? copy("未获允许。请检查身份组及浏览器的采集权限。", "Permission was declined. Check your roles and browser capture permission.")
    : /unavailable|notfound|notreadable/i.test(channel.error)
      ? copy("设备暂不可用，请检查浏览器权限及设备占用。", "Device unavailable. Check browser permissions and other apps.")
    : /disconnect|closed|offline/i.test(channel.error)
      ? copy("连接已断开，请重新连接后再试。", "Connection lost. Reconnect and try again.")
      : copy("未能完成操作，请重试。", "Could not complete the action. Please try again.") : null;
  useEffect(() => {
    if (!roomId) return;
    setSelected(roomId);
    channel.browse(roomId);
  }, [roomId]);
  useEffect(() => { setCopied(false); setCopyError(false); }, [channel.inviteURL]);
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
    <main className="c3-shell">
      <aside className="c3-sidebar" aria-label={copy("频道和房间", "Channel and rooms")}>
        <div className="c3-channel-title"><h1>{state?.channel.name ?? copy("你的频道", "Your channel")}</h1>
          <span className="c3-channel-caption">{copy("频道", "Channel")}</span></div>
        {channel.inviteURL && <div className="c3-invite"><ChannelAction icon={copied ? "check" : "link"}
          label={copied ? copy("已复制", "Copied") : copy("邀请朋友", "Invite friends")} hint="hint-copy-invite" onClick={copyInvite} /></div>}
        {copyError && <label className="c3-copy-fallback">{copy("请手动复制邀请链接", "Copy invitation manually")}
          <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} />
        </label>}
        <div className="c3-room-navigation">
          <div className="c3-section-label"><span className="c3-section-caption">{copy("房间", "Rooms")}</span>
            {can("create_room") && <Tooltip kind="hint-create-room" text={vis ? undefined : copy("创建房间", "Create room")}>
              <button ref={createTrigger} type="button" className="lr-btn is-dense is-quiet" popoverTarget="c3-create-room"
                aria-label={copy("创建房间", "Create room")} aria-haspopup="dialog" disabled={!connected}><Glyph name="plus" size={17} /></button>
            </Tooltip>}
          </div>
          <nav className="c3-rooms" aria-label={copy("房间", "Rooms")}>
            {rooms.map(value => {
              const voice = myVoice.some(activity => activity.roomId === value.id);
              const sharing = mine.some(activity => activity.roomId === value.id);
              const watching = watched.some(activity => activity.roomId === value.id);
              const count = screens.filter(screen => screen.roomId === value.id).length;
              return <button type="button" key={value.id} className="c3-room-link" aria-label={value.name}
                aria-current={roomId === value.id ? "page" : undefined} onClick={() => setSelected(value.id)}>
                <Glyph name="couch" size={21} /><strong>{value.name}</strong>
                <span className="c3-room-activity">
                  {voice && <Glyph name="headphones" size={14} />}
                  {sharing ? <Glyph name="cast" size={14} /> : watching ? <Glyph name="eye" size={14} />
                    : count > 0 ? <span>{count}<Glyph name="tv" size={13} /></span> : null}
                </span>
              </button>;
            })}
          </nav>
          <label className="c3-mobile-room"><Glyph name="couch" size={20} /><span className="visually-hidden">{copy("房间", "Room")}</span>
            <select value={roomId} onChange={event => setSelected(event.target.value)} disabled={!rooms.length}>
              {!rooms.length && <option value="">{copy("等待连接", "Waiting for connection")}</option>}
              {rooms.map(value => <option value={value.id} key={value.id}>{value.name}</option>)}
            </select>
          </label>
        </div>
        {self && <div className="c3-identity"><PawnSvg color={participantColor(self.id)} identity={self.id} host={owner} />
          <div><strong>{self.name}</strong><small>{owner ? copy("频道主", "Channel owner") : copy("你的名字", "Your name")}</small></div>
          <Tooltip kind="hint-rename" text={vis ? undefined : copy("查看用户与修改昵称", "Users and your profile")}><button type="button" className="lr-btn is-compact is-quiet"
            popoverTarget="c3-people" aria-label={copy("查看用户与修改昵称", "Users and your profile")}><Glyph name="pencil" size={17} /></button></Tooltip>
        </div>}
      </aside>
      <section className="c3-main" aria-label={room?.name ?? copy("房间", "Room")}>
        <header className="c3-room-heading">
          <div className="c3-room-name"><Glyph name="couch" size={25} /><h2>{room?.name ?? copy("欢迎回来", "Welcome back")}</h2></div>
          <div className="c3-room-actions">
            {room && <><ChannelAction icon="cast" label={copy("分享屏幕", "Share screen")} primary hint="hint-share-start"
              disabled={!connected || !can("publish")} busy={busy("screen", roomId)} onClick={() => run(channel.startScreen(roomId))} />
              <ChannelJoinVoice joined={joined} disabled={!connected || !can("voice")} busy={busy("voice", roomId)}
                onJoin={listenOnly => run(channel.joinVoice(roomId, listenOnly).then(() => setVoiceFocus(roomId)))} /></>}
          </div>
          <div className="c3-room-tools">
            {visibleScreens.length > 0 && <ChannelAction icon="chat" label={chatOpen ? copy("收起聊天", "Hide chat") : copy("打开聊天", "Show chat")}
              iconOnly quiet pressed={chatOpen} hint={chatOpen ? "hint-close" : "hint-chat-open"} onClick={() => setChatOpen(!chatOpen)} />}
            <Tooltip kind="hint-details" text={vis ? undefined : copy("频道用户", "Channel users")}><button id="c3-people-trigger" type="button" className="c3-people-trigger"
              popoverTarget="c3-people" aria-label={copy("频道用户", "Channel users")} aria-haspopup="dialog">
              <span className="c3-avatar-stack" aria-hidden="true">{onlineUsers.slice(0, 3).map(user =>
                <PawnSvg key={user.id} color={participantColor(user.id)} identity={user.id} />)}</span>
              <span>{onlineUsers.length}</span><Glyph name="chevron" size={14} />
            </button></Tooltip>
          </div>
        </header>
        {!connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span>{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" onClick={channel.reconnect} />}
        </div>}
        {self && !owner && !permissions.size && <div className="c3-notice" role="status"><Glyph name="lock" size={20} />
          <span>{copy("当前为只读。请联系频道主分配身份组。", "Read-only access. Ask the channel owner for a role to participate.")}</span></div>}
        {failure && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} /><span>{failure}</span>
          <Btn icon="x" title="notice.dismiss" size="compact" quiet onClick={channel.clearError} />
        </div>}
        {availableScreens.length > 0 && <section className="c3-available-screens" aria-label={copy("可观看的画面", "Available screens")}>
          {availableScreens.map(publication => <div className="c3-available-screen" key={publication.id}>
            <PawnSvg color={participantColor(publication.userId)} identity={publication.userId} />
            <span><strong>{nameOfUser(publication.userId)}</strong><small>{copy("正在分享", "Sharing a screen")}</small></span>
            <ChannelAction icon="eye" label={copy("观看", "Watch")} disabled={!connected || !can("subscribe")}
              busy={busy("watch", publication.id)} onClick={() => run(channel.watch(publication.id))} />
          </div>)}
        </section>}
        <div className={`c3-workspace${visibleScreens.length ? " has-screens" : ""}${chatOpen ? "" : " chat-collapsed"}`}>
          {visibleScreens.length > 0 && <section className="c3-stage" aria-label={copy("共享画面", "Shared screens")}>
            <div className="c3-screen-grid">{visibleScreens.map(publication => {
              const local = publication.sessionId === sessionId;
              const stream = streams.get(publication.id);
              return <article className="c3-screen" key={publication.id} data-publication-id={publication.id}>
                {stream ? <ChannelVideo stream={stream} local={local} label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />
                  : <div className="c3-screen-placeholder"><Glyph name="loader" size={24} className="lr-spin" />
                    <span>{copy("正在连接画面", "Connecting picture")}</span></div>}
                <footer><PawnSvg color={participantColor(publication.userId)} identity={publication.userId} />
                  <div><strong>{nameOfUser(publication.userId)}</strong><small>{local ? copy("本机预览", "Local preview") : nameOfRoom(publication.roomId)}
                    {local && publication.roomId !== roomId && ` (${nameOfRoom(publication.roomId)})`}</small></div>
                  <ChannelAction icon={local ? "stop" : "x"} danger={local} quiet={!local} iconOnly
                    label={local ? copy("停止分享", "Stop sharing") : copy("停止观看", "Stop watching")}
                    hint={local ? "hint-share-stop" : "hint-close"} busy={busy(local ? "stop" : "watch", publication.id)}
                    onClick={() => run(local ? channel.stopScreen(publication.id) : channel.unwatch(publication.id))} />
                </footer>
              </article>;
            })}</div>
          </section>}
          <ChannelConversation roomId={roomId} roomName={room?.name ?? ""} messages={channel.messagesByRoom[roomId] ?? []}
            users={state?.users ?? []} canSend={connected && !!roomId && can("chat")} sending={busy("chat", roomId)}
            onSend={channel.sendMessage} hidden={visibleScreens.length > 0 && !chatOpen} />
        </div>
        <ChannelVoiceDock channel={channel} selected={voiceFocus} onSelect={setVoiceFocus} onBrowse={setSelected} />
        {voiceStreams.map(publication => <ChannelAudio key={publication.id} stream={streams.get(publication.id)!}
          muted={myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
    </main>
    <ChannelPeople channel={channel} roomId={roomId} />
    <div ref={createPanel} id="c3-create-room" popover="auto" role="dialog" aria-label={copy("创建房间", "Create room")}
      className="lr-anchored-card c3-create-panel">
      <form onSubmit={event => {
        event.preventDefault();
        if (!roomName.trim() || busy("create-room")) return;
        run(channel.createRoom(roomName.trim()).then(() => { setRoomName(""); createPanel.current?.hidePopover(); }));
      }}>
        <label htmlFor="c3-room-name">{copy("房间名称", "Room name")}</label>
        <input id="c3-room-name" className="c3-input" maxLength={64} value={roomName} disabled={!connected || busy("create-room")}
          autoComplete="off" placeholder={copy("给朋友留个位置…", "Make room for your friends…")} onChange={event => setRoomName(event.target.value)} />
        <ChannelAction icon="plus" label={copy("创建房间", "Create room")} type="submit" primary
          disabled={!connected || !roomName.trim()} busy={busy("create-room")} />
      </form>
    </div>
  </div>;
}
