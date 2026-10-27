import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
import { Btn } from "../components/living/primitives";
import { PawnSvg } from "../components/living/Pawn";
import { participantColor } from "../components/living/participant-color";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useChannel } from "../channel/use-channel";
import { ChannelAction, ChannelAudio, ChannelVideo } from "../channel/components/ChannelMedia";
import { ChannelUser } from "../channel/components/ChannelUser";
import { ChannelNameEditor } from "../channel/components/ChannelNameEditor";
import "./channel-preview.css";

export function ChannelPreviewPage() {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const channel = useChannel();
  const { state, self, sessionId, connection, pending, streams } = channel;
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [roomName, setRoomName] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const room = state?.channel.rooms.find(value => value.id === selected) ?? state?.channel.rooms[0];
  const roomId = room?.id ?? "";
  const messages = channel.messagesByRoom[roomId] ?? [];
  const connected = connection === "connected";
  const owner = !!self && state?.channel.ownerId === self.id;
  const permissions = new Set(state?.channel.roles.filter(role => self?.roles.includes(role.id)).flatMap(role => role.permissions));
  const can = (permission: string) => owner || permissions.has(permission);
  const canCreate = can("create_room");
  const busy = (action: string, id?: string) => pending.has(action) || pending.has(`${action}:${id}`);
  const rooms = state?.channel.rooms ?? [];
  const publications = state?.publications ?? [];
  const roomScreens = publications.filter(value => value.kind === "screen" && value.roomId === roomId);
  const mine = publications.filter(value => value.kind === "screen" && value.sessionId === sessionId);
  const watched = publications.filter(value => value.kind === "screen" && value.sessionId !== sessionId && state?.subscriptions.includes(value.id));
  const visibleScreens = [...roomScreens, ...watched.filter(value => value.roomId !== roomId),
    ...mine.filter(value => value.roomId !== roomId)];
  const myVoice = state?.voice.filter(value => value.sessionId === sessionId) ?? [];
  const forwarding = state?.pairs.some(pair => pair.outgoing.some(id => publications.some(publication =>
    publication.id === id && publication.sessionId !== sessionId))) ?? false;
  const joined = myVoice.find(value => value.roomId === roomId);
  const roomVoice = state?.voice.filter(value => value.roomId === roomId) ?? [];
  const draft = drafts[roomId] ?? "";
  const nameOfRoom = (id: string) => rooms.find(value => value.id === id)?.name ?? id;
  const nameOfUser = (id: string) => state?.users.find(value => value.id === id)?.name ?? copy("用户", "User");
  const voiceStreams = publications.filter(value => value.kind === "voice" && value.sessionId !== sessionId &&
    state?.subscriptions.includes(value.id) && streams.has(value.id));
  const failure = channel.error ? /invite|credential|unauthorized|join_required/i.test(channel.error)
    ? copy("需要有效邀请。请打开频道主提供的完整邀请链接。", "A valid invitation is required. Open the full link from the channel owner.")
    : channel.error === "session_expired"
      ? copy("连接超时，采集已停止。重新连接后可再次分享或加入语音。", "Connection timed out. Capture stopped. Reconnect to share or join voice again.")
    : /permission|forbidden|denied|notallowed/i.test(channel.error)
    ? copy("未获允许。请检查当前身份组；设备采集需要浏览器许可。", "Permission was declined. Check your roles and browser capture permission.")
    : /unavailable|notfound|notreadable/i.test(channel.error)
      ? copy("设备暂不可用。请检查浏览器权限及设备占用后重试。", "Device unavailable. Check browser permissions and other apps, then try again.")
    : /disconnect|closed|offline/i.test(channel.error)
      ? copy("连接已断开，请重新连接后再试。", "Connection lost. Reconnect and try again.")
      : copy("未能完成操作，请重试。", "Could not complete the action. Please try again.") : null;
  useEffect(() => { if (roomId) channel.browse(roomId); }, [roomId]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [roomId, messages.length]);
  useEffect(() => { setCopied(false); setCopyError(false); }, [channel.inviteURL]);

  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connected || !can("chat") || busy("chat", roomId)) return;
    void channel.sendMessage(roomId, text).then(() => {
      setDrafts(previous => previous[roomId] === draft ? { ...previous, [roomId]: "" } : previous);
    }).catch(() => {});
  }
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
        <div className="c3-channel-title">
          <span className="c3-eyebrow">PIIK / 3.0</span>
          <h1>{state?.channel.name ?? copy("你的频道", "Your channel")}</h1>
          <p>{copy("一起聊天，一起看点什么。", "Good company. Something to share.")}</p>
        </div>
        {channel.inviteURL && <div className="c3-sidebar-tools">
          <Btn icon={copied ? "check" : "link"} title={copied ? "common.copied" : "host.invite.copy"}
            cap={copied ? "common.copied" : "common.copy"} size="compact" hint="hint-copy-invite" onClick={copyInvite} />
        </div>}
        {copyError && <div className="c3-copy-fallback">
          <label>{copy("复制失败，请手动复制邀请链接", "Copy failed. Copy this invitation manually.")}
            <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} />
          </label>
        </div>}
        <div>
          <div className="c3-section-title"><span>{copy("房间", "ROOMS")}</span><span>{rooms.length}</span></div>
          <nav className="c3-rooms" aria-label={copy("房间", "Rooms")}>
            {rooms.map(value => {
              const voiceHere = myVoice.some(activity => activity.roomId === value.id);
              const screenHere = mine.some(activity => activity.roomId === value.id);
              const watchHere = watched.some(activity => activity.roomId === value.id);
              return <button type="button" key={value.id} className="c3-room-link"
                aria-label={value.name} aria-current={roomId === value.id ? "page" : undefined} onClick={() => setSelected(value.id)}>
                <Glyph name="couch" size={21} /><span><strong>{value.name}</strong>
                  {(voiceHere || screenHere || watchHere) && <small>
                    {voiceHere && <Glyph name="headphones" size={12} />}
                    {screenHere && <Glyph name="cast" size={12} />}
                    {watchHere && <Glyph name="eye" size={12} />}
                    {copy("活动中", "Active")}
                  </small>}
                </span>
                <span className="c3-room-count">{publications.filter(publication => publication.roomId === value.id && publication.kind === "screen").length || ""}</span>
              </button>;
            })}
          </nav>
          {!rooms.length && <p className="c3-empty-note">{copy("请通过频道主提供的邀请链接进入。连接后显示房间。", "Open the channel owner’s invitation link to join. Rooms appear when connected.")}</p>}
        </div>
        {canCreate && <details className="c3-details">
          <summary>{copy("创建房间", "Create a room")}</summary>
          <form className="c3-create-form" onSubmit={event => {
            event.preventDefault();
            if (roomName.trim()) run(channel.createRoom(roomName.trim()).then(() => setRoomName("")));
          }}>
            <input className="c3-input" maxLength={64} value={roomName} aria-label={copy("房间名称", "Room name")}
              disabled={!connected || busy("create-room")}
              placeholder={copy("房间名称", "Room name")} onChange={event => setRoomName(event.target.value)} />
            <ChannelAction icon="plus" label={copy("创建房间", "Create room")} hint="hint-create-room" type="submit"
              disabled={!connected || !roomName.trim()} busy={busy("create-room")} />
          </form>
        </details>}
        <div className="c3-identity">
          {self ? <><ChannelUser id={self.id} name={self.name} self owner={owner} roles={self.roles} online={connected}
            activity={forwarding ? copy("正在帮助转发", "Forwarding media") : undefined}
            voice={myVoice.length ? { microphone: myVoice.some(value => !value.muted), deafened: myVoice.every(value => value.deafened) } : undefined} />
            <ChannelNameEditor name={self.name} disabled={!connected || busy("rename")}
              onSave={value => run(channel.renameSelf(value))} /></> : <p className="c3-empty-note">{connectionLabel}</p>}
        </div>
      </aside>
      <section className="c3-main" aria-label={room?.name ?? copy("房间", "Room")}>
        <header className="c3-room-heading">
          <div><h2>{room?.name ?? copy("欢迎回来", "Welcome back")}</h2>
            <p>{copy("浏览另一个房间，不会中断正在进行的活动。", "Browse another room. Your activities stay where they are.")}</p></div>
          {room && <ChannelAction icon="cast" label={copy("分享屏幕", "Share screen")} hint="hint-share-start"
            disabled={!connected || !can("publish")} busy={busy("screen", roomId)} onClick={() => run(channel.startScreen(roomId))} />}
        </header>
        {myVoice.some(value => value.roomId !== roomId) && <section className="c3-activities" aria-label={copy("其他房间的活动", "Activities in other rooms")}>
          {myVoice.filter(value => value.roomId !== roomId).map(value => <div key={value.roomId} className="c3-activity">
            <Glyph name="headphones" size={20} /><div className="c3-activity-label"><strong>{nameOfRoom(value.roomId)}</strong>
              <small>{value.deafened ? copy("已暂停收听", "Listening paused") : value.muted ? copy("正在收听", "Listening") : copy("麦克风已打开", "Microphone on")}</small></div>
            <ChannelAction icon="door" label={copy("回到房间", "Open room")} onClick={() => setSelected(value.roomId)} />
            <ChannelAction icon={value.muted ? "microphoneOff" : "microphone"} label={value.muted ? copy("打开麦克风", "Unmute") : copy("静音", "Mute")}
              pressed={value.muted} disabled={!connected} busy={busy("voice", value.roomId)}
              onClick={() => run(channel.setMuted(value.roomId, !value.muted))} />
            <ChannelAction icon={value.deafened ? "headphonesOff" : "headphones"} pressed={value.deafened}
              label={value.deafened ? copy("恢复收听", "Resume listening") : copy("暂停收听", "Deafen")}
              disabled={!connected} busy={busy("voice", value.roomId)}
              onClick={() => run(channel.setDeafened(value.roomId, !value.deafened))} />
            <ChannelAction icon="x" label={copy("离开语音", "Leave voice")} hint="hint-voice-leave"
              onClick={() => run(channel.leaveVoice(value.roomId))} />
          </div>)}
        </section>}
        {!connected && <div className="c3-notice" role="status"><Glyph name="signal" size={20} /><span>{connectionLabel}</span>
          {connection === "closed" && <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" onClick={channel.reconnect} />}
        </div>}
        {self && !owner && !permissions.size && <div className="c3-notice" role="status"><Glyph name="lock" size={20} />
          <span>{copy("当前为只读。请联系频道主分配身份组后参与。", "Read-only access. Ask the channel owner for a role to participate.")}</span>
        </div>}
        {(failure || copyError) && <div className="c3-notice is-error" role="alert"><Glyph name="alert" size={20} />
          <span>{failure ?? copy("未能复制邀请链接，请在侧栏手动复制。", "Could not copy the invitation. Copy it manually in the sidebar.")}</span>
          <Btn icon="x" title="notice.dismiss" size="compact" quiet onClick={() => { channel.clearError(); setCopyError(false); }} />
        </div>}
        <div className="c3-content">
          <section className="c3-conversation" aria-label={copy("聊天与画面", "Chat and screens")}>
            {visibleScreens.length > 0 && <div className="c3-screen-grid" aria-label={copy("共享画面", "Shared screens")}>
              {visibleScreens.map(publication => {
                const local = publication.sessionId === sessionId;
                const watching = state?.subscriptions.includes(publication.id) ?? false;
                const stream = streams.get(publication.id);
                return <article className="c3-screen" key={publication.id} data-publication-id={publication.id}>
                  {(local || watching) && stream ? <ChannelVideo stream={stream} local={local}
                    label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} /> : <div className="c3-screen-placeholder">
                    <Glyph name={watching ? "loader" : "tv"} size={32} className={watching ? "lr-spin" : undefined} />
                    <p>{watching ? copy("正在连接画面", "Connecting picture") : copy("选择观看后才接收画面", "Watch to receive this screen")}</p>
                  </div>}
                  <header><Glyph name="tv" size={16} /><strong>{nameOfUser(publication.userId)}</strong>
                    <small>{local ? `${copy("本机预览", "Local preview")} / ` : ""}{nameOfRoom(publication.roomId)}</small></header>
                  <footer>{local ? <ChannelAction icon="stop" danger label={copy("停止分享", "Stop sharing")} hint="hint-share-stop"
                    busy={busy("stop", publication.id)} onClick={() => run(channel.stopScreen(publication.id))} />
                    : <ChannelAction icon={watching ? "eyeOff" : "eye"} label={watching ? copy("停止观看", "Stop watching") : copy("观看画面", "Watch screen")}
                      pressed={watching} disabled={!watching && (!connected || !can("subscribe"))} busy={busy("watch", publication.id)}
                      onClick={() => run(watching ? channel.unwatch(publication.id) : channel.watch(publication.id))} />}</footer>
                </article>;
              })}
            </div>}
            <div className="c3-conversation-title"><Glyph name="chat" size={18} />{copy("聊天", "Conversation")}
              <small>{copy("每个房间保留各自的对话", "A conversation for each room")}</small></div>
            <div className="c3-message-log" ref={log} role="log" aria-label={copy("消息", "Messages")}>
              {!messages.length && <div className="c3-welcome"><Glyph name="couch" size={38} />
                <h3>{room ? copy("在这里打个招呼。", "Make yourself at home.") : copy("从一份邀请开始。", "It starts with an invitation.")}</h3>
                <p>{room ? copy("聊聊近况，加入语音，或分享正在看的画面。", "Say hello, join the conversation, or share what you’re looking at.")
                  : copy("打开频道主发来的完整邀请链接，即可进入频道。", "Open the full invitation link from the channel owner to enter.")}</p>
              </div>}
              {messages.map(message => <article className="c3-message" key={message.id}>
                <PawnSvg color={participantColor(message.userId)} identity={message.userId} />
                <div className="c3-message-body"><div className="c3-message-meta"><strong>{nameOfUser(message.userId)}</strong>
                  <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" })}</time>
                </div><p>{message.text}</p></div>
              </article>)}
            </div>
            <form className="c3-composer" onSubmit={send}>
              <textarea maxLength={2000} aria-label={copy("消息内容", "Message")} value={draft}
                placeholder={copy(`给${room?.name ?? "房间"}留句话…`, `Message ${room?.name ?? "room"}…`)}
                onChange={event => setDrafts(previous => ({ ...previous, [roomId]: event.target.value }))}
                onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); event.currentTarget.form?.requestSubmit();
                } }} />
              <div className="c3-composer-footer"><small>{copy("Enter 发送 / Shift + Enter 换行", "Enter to send / Shift + Enter for a new line")}</small>
                <ChannelAction icon="send" label={copy("发送", "Send")} type="submit" primary
                  disabled={!connected || !roomId || !draft.trim() || !can("chat")} busy={busy("chat", roomId)} />
              </div>
            </form>
          </section>
          <aside className="c3-people" aria-label={copy("频道用户", "Channel users")}>
            <h3><Glyph name="users" size={18} />{copy("频道用户", "Users")} <span>{state?.users.length ?? 0}</span></h3>
            <div className="c3-users">{state?.users.map(user => {
              const userSessions = state.sessions.filter(value => value.userId === user.id);
              const ids = new Set(userSessions.map(value => value.id));
              const voices = state.voice.filter(value => ids.has(value.sessionId) && value.roomId === roomId);
              const sharing = publications.some(value => value.userId === user.id && value.kind === "screen");
              return <ChannelUser key={user.id} id={user.id} name={user.name} self={user.id === self?.id}
                owner={user.id === state.channel.ownerId} roles={user.roles} online={userSessions.some(value => value.online)}
                voice={voices.length ? { microphone: voices.some(value => !value.muted), deafened: voices.every(value => value.deafened) } : undefined}
                activity={sharing ? copy("正在分享画面", "Sharing a screen") : undefined}
                rolesDisabled={!connected || busy("roles", user.id)} availableRoles={state.channel.roles}
                onRoles={owner ? roles => run(channel.setRoles(user.id, roles)) : undefined} />;
            })}</div>
          </aside>
        </div>
        {room && <section className="c3-voice" aria-label={copy("房间语音", "Room voice")}>
          <div className="c3-voice-heading"><Glyph name="headphones" size={23} /><div><h3>{room.name}</h3>
            <p>{copy("语音", "Voice")} / {roomVoice.length} {copy("人", "joined")}{joined ? ` / ${copy("已加入", "Joined")}` : ""}</p></div></div>
          <div className="c3-actions">{joined ? <>
            <ChannelAction icon={joined.muted ? "microphoneOff" : "microphone"} pressed={joined.muted}
              label={joined.muted ? copy("打开麦克风", "Unmute") : copy("静音", "Mute")}
              hint={joined.muted ? "hint-voice-microphone-on" : "hint-voice-microphone-off"}
              disabled={!connected} busy={busy("voice", roomId)} onClick={() => run(channel.setMuted(roomId, !joined.muted))} />
            <ChannelAction icon={joined.deafened ? "headphonesOff" : "headphones"} pressed={joined.deafened}
              label={joined.deafened ? copy("恢复收听", "Resume listening") : copy("暂停收听", "Deafen")}
              hint={joined.deafened ? "hint-voice-undeafen" : "hint-voice-deafen"}
              disabled={!connected} busy={busy("voice", roomId)} onClick={() => run(channel.setDeafened(roomId, !joined.deafened))} />
            <ChannelAction icon="x" label={copy("离开语音", "Leave voice")} hint="hint-voice-leave"
              busy={busy("voice", roomId)} onClick={() => run(channel.leaveVoice(roomId))} />
          </> : <>
            <ChannelAction icon="headphones" label={copy("只收听", "Listen only")} hint="hint-voice-join"
              disabled={!connected || !can("voice")} busy={busy("voice", roomId)} onClick={() => run(channel.joinVoice(roomId, true))} />
            <ChannelAction icon="microphone" label={copy("加入语音", "Join voice")} hint="hint-voice-join"
              disabled={!connected || !can("voice")} busy={busy("voice", roomId)} onClick={() => run(channel.joinVoice(roomId, false))} />
          </>}</div>
        </section>}
        {voiceStreams.map(publication => <ChannelAudio key={publication.id} stream={streams.get(publication.id)!}
          muted={myVoice.find(value => value.roomId === publication.roomId)?.deafened ?? true}
          label={`${nameOfUser(publication.userId)} — ${nameOfRoom(publication.roomId)}`} />)}
      </section>
    </main>
  </div>;
}
