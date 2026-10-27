import { useEffect, useRef, useState } from "react";
import { Glyph } from "../../ui/icons";
import { BrandMark } from "../../components/living/BrandMark";
import { PawnSvg, type PawnVoice } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignArtwork } from "./DesignArtwork";
import { DesignRoomDialog } from "./DesignRoomDialog";
import { designPeople, designRooms, type DesignCopy, type DesignScene } from "./fixtures";

function Avatar({ index, voice = false }: { index: number; voice?: boolean | PawnVoice }) {
  const person = designPeople[index];
  return <span className="cd-avatar">
    <PawnSvg color={participantColor(person.id)} identity={person.id} host={index === 0}
      voice={typeof voice === "object" ? voice : voice ? { microphone: person.status !== "muted", deafened: person.status === "away" } : undefined} />
  </span>;
}

export function DesignWorkspace({ copy, scene, onScene }: {
  copy: DesignCopy; scene: DesignScene; onScene(scene: DesignScene): void;
}) {
  const [rooms, setRooms] = useState(() => designRooms(copy));
  const [roomId, setRoomId] = useState("games");
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "members">("room");
  const [joined, setJoined] = useState(true);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [sharingRoom, setSharingRoom] = useState<string | null>(null);
  const [screensHidden, setScreensHidden] = useState(false);
  const [roomMessages, setRoomMessages] = useState<Record<string, string[]>>({});
  const [reactionSelected, setReactionSelected] = useState(false);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(0);
  const conversation = useRef<HTMLDivElement>(null);
  const room = rooms.find(item => item.id === roomId)!;
  const roomName = designRooms(copy).find(item => item.id === roomId)?.name ?? room.name;
  const demoRoom = roomId === "games";
  const sharing = sharingRoom === roomId;
  const screenIds = [...(demoRoom ? [0, 1] : []), ...(sharing ? [3] : [])];
  const showingScreens = screenIds.length > 0 && !screensHidden && (scene === "screens" || scene === "focus" || sharing);
  const messages = roomMessages[roomId] ?? [];
  const selfVoice = joined ? { microphone: !muted, deafened } : false;
  const here = demoRoom ? [0, 1, 2, 3] : [3];
  const elsewhere = demoRoom ? [4] : [0, 1, 2, 4];
  const name = (index: number) => copy(designPeople[index].name, designPeople[index].english);

  useEffect(() => { setMobilePane("room"); setScreensHidden(false); }, [scene]);
  useEffect(() => {
    if (messages.length) conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return <>
    <div className="cd-workspace" data-pane={mobilePane}>
      <nav className="cd-channel-rail" aria-label={copy("频道", "Channels")}>
        <span className="cd-rail-brand" aria-label="Piik"><BrandMark size={30} /></span>
        <span className="cd-rail-rule" />
        <button type="button" className="lr-btn cd-channel-icon is-on" aria-label={copy("下班以后", "After hours")}
          onClick={() => { setRoomId("games"); setMobilePane("rooms"); }}>
          <Glyph name="couch" size={26} />
        </button>
        <span className="cd-rail-bottom">3.0</span>
      </nav>

      <aside className="cd-rooms" aria-label={copy("房间", "Rooms")}>
        <header className="cd-channel-heading">
          <div><small>{copy("一个属于朋友的频道", "A place for your people")}</small><h2>{copy("下班以后", "After hours")}</h2></div>
          <span className="cd-pane-back"><ChannelAction icon="x" label={copy("返回房间", "Back to room")} quiet iconOnly onClick={() => setMobilePane("room")} /></span>
        </header>
        <div className="cd-room-nav">
          <div className="cd-section-label"><span>{copy("房间", "Rooms")}</span>
            <ChannelAction icon="plus" label={copy("创建房间", "Create room")} hint="hint-create-room" quiet iconOnly onClick={() => onScene("create")} />
          </div>
          <nav aria-label={copy("房间列表", "Room list")}>
            {rooms.map(item => <button key={item.id} type="button" className="cd-room-link"
              aria-current={roomId === item.id ? "page" : undefined}
              onClick={() => { setRoomId(item.id); setMobilePane("room"); setDraft(""); setFocused(item.id === "games" ? 0 : 3); }}>
              <Glyph name={item.icon} size={21} />
              <span>{designRooms(copy).find(preset => preset.id === item.id)?.name ?? item.name}</span>
              {item.id === "games" ? <small>4</small> : item.hidden ? <Glyph name="eyeOff" size={14} /> : null}
            </button>)}
          </nav>
        </div>
        <div className="cd-nav-bottom">
          <div className="cd-voice-session" data-connected={joined}>
            <div className="cd-voice-title"><Glyph name="headphones" size={17} /><strong>{joined ? copy("语音已连接", "Voice connected") : copy("随时来聊聊", "Come hang out")}</strong></div>
            <div className="cd-voice-detail"><span>{copy("再来一局", "One more round")}</span>
              <ChannelAction icon={joined ? "door" : "headphones"} quiet iconOnly
                label={joined ? copy("退出语音", "Leave voice") : copy("加入语音", "Join voice")}
                hint={joined ? "hint-voice-leave" : "hint-voice-join"} onClick={() => setJoined(!joined)} /></div>
          </div>
          <div className="cd-self">
            <Avatar index={3} voice={selfVoice} /><div className="cd-self-name"><strong>{name(3)}</strong><small>{copy("在线", "Online")}</small></div>
            <ChannelAction icon={muted ? "microphoneOff" : "microphone"} label={muted ? copy("开启麦克风", "Unmute microphone") : copy("关闭麦克风", "Mute microphone")}
              pressed={muted} hint={muted ? "hint-voice-microphone-on" : "hint-voice-microphone-off"} quiet iconOnly onClick={() => setMuted(!muted)} />
            <ChannelAction icon={deafened ? "headphonesOff" : "headphones"} label={deafened ? copy("开启收听", "Undeafen") : copy("关闭收听", "Deafen")}
              pressed={deafened} hint={deafened ? "hint-voice-undeafen" : "hint-voice-deafen"} quiet iconOnly onClick={() => setDeafened(!deafened)} />
          </div>
        </div>
      </aside>

      <main className="cd-room">
        <header className="cd-room-heading">
          <span className="cd-mobile-rooms"><ChannelAction icon="arrowLeft" label={copy("房间列表", "Rooms")} quiet iconOnly onClick={() => setMobilePane("rooms")} /></span>
          <span className="cd-room-heading-icon"><Glyph name={room.icon} size={23} /></span>
          <div className="cd-room-heading-text"><h2>{roomName}</h2><span>{demoRoom ? copy("输赢不重要，人在就好。", "Good company. Questionable skills.") : copy("留个地方，一起聊聊。", "A place to get together.")}</span></div>
          <span className="cd-header-action"><ChannelAction icon={sharing ? "stop" : "share"} primary={!sharing} hint={sharing ? "hint-share-stop" : "hint-share-start"}
            label={sharing ? copy("停止分享", "Stop sharing") : copy("分享屏幕", "Share screen")} onClick={() => {
              setSharingRoom(sharing ? null : roomId); setScreensHidden(false);
              setFocused(sharing ? 0 : 3);
            }} /></span>
          <span className="cd-mobile-members"><ChannelAction icon="users" label={copy("成员", "Members")} quiet iconOnly onClick={() => setMobilePane("members")} /></span>
        </header>

        <div className="cd-room-content">
          {showingScreens ? <section className={"cd-stage" + (scene === "focus" ? " is-focused" : "")} aria-label={copy("分享的画面", "Shared screens")}>
            <div className="cd-stage-heading"><span><Glyph name="display" size={16} />{copy("正在观看", "Watching")} <b>{screenIds.length}</b></span>
              <button type="button" className="lr-btn is-dense is-quiet" onClick={() => setScreensHidden(true)}><Glyph name="x" size={16} /><span>{copy("收起画面", "Hide screens")}</span></button>
            </div>
            <div className="cd-screen-grid">
              {screenIds.map(index => <button key={index} type="button" className={"cd-screen" + (scene === "focus" && focused === index ? " is-focused" : "")}
                aria-label={copy("观看", "Watch") + " " + name(index)} aria-pressed={scene === "focus" && focused === index}
                onClick={() => { setFocused(index); onScene(scene === "focus" && focused === index ? "screens" : "focus"); }}>
                <DesignArtwork kind={index === 0 ? "game" : "drawing"} />
                <span className="cd-screen-caption"><Avatar index={index} /><strong>{name(index)}</strong><Glyph name={scene === "focus" && focused === index ? "contract" : "expand"} size={16} /></span>
              </button>)}
            </div>
          </section> : screenIds.length > 0 ? <div className="cd-sharing-strip">
            <span className="cd-sharing-avatars">{screenIds.slice(0, 2).map(index => <Avatar index={index} key={index} />)}</span>
            <span><strong>{demoRoom ? copy("朋友正在分享画面", "Friends are sharing") : copy("你正在分享画面", "You're sharing")}</strong><small>{copy("选一个看看，或者一起看。", "Pick a screen, or watch them together.")}</small></span>
            <ChannelAction icon="play" label={copy("观看", "Watch")} onClick={() => { setScreensHidden(false); onScene("screens"); }} />
          </div> : null}

          <div className="cd-conversation" ref={conversation} role="log" aria-label={copy("聊天记录", "Conversation")}>
            {!showingScreens && <div className="cd-room-welcome">
              <span className="cd-welcome-icon"><Glyph name={room.icon} size={33} /></span>
              <div><h3>{demoRoom ? copy("今晚，再来一局。", "One more round?") : roomName}</h3><p>{copy("有空就来，随时开聊。", "Drop in whenever. Stay a little longer.")}</p></div>
            </div>}
            {demoRoom && <>
            <div className="cd-date"><span>{copy("今天", "Today")}</span></div>
            <article className="cd-message">
              <Avatar index={0} /><div><header><strong>{name(0)}</strong><time>20:42</time></header>
                <p>{copy("都到齐了吗？就差一个人了。", "Everyone here? We need one more.")}</p></div>
            </article>
            <article className="cd-message">
              <Avatar index={1} /><div><header><strong>{name(1)}</strong><time>20:43</time></header>
                <p>{copy("来了。这次绝对不跳空。", "Here. Definitely making that jump this time.")}</p>
                {!showingScreens && <div className="cd-inline-preview"><DesignArtwork /><span><Glyph name="gamepad" size={16} />{copy("今晚的目标：过第一关", "Tonight's ambition: finish level one")}</span></div>}
              </div>
            </article>
            <article className="cd-message">
              <Avatar index={2} /><div><header><strong>{name(2)}</strong><time>20:44</time></header>
                <p>{copy("这句话我截图了。", "Saving this for the highlight reel.")}</p>
                <button className="cd-reaction" type="button" aria-label={copy("回应大笑", "React with laughter")}
                  onClick={() => setReactionSelected(!reactionSelected)} aria-pressed={reactionSelected}>😂&nbsp; {reactionSelected ? 3 : 2}</button>
              </div>
            </article>
            </>}
            {messages.map((message, index) => <article className="cd-message" key={index}><Avatar index={3} /><div><header><strong>{name(3)}</strong><time>20:45</time></header><p>{message}</p></div></article>)}
          </div>

          <form className="cd-composer" onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; setRoomMessages({ ...roomMessages, [roomId]: [...messages, draft.trim()] }); setDraft(""); }}>
            <input aria-label={copy("发送消息", "Message")} value={draft} onChange={event => setDraft(event.target.value)}
              placeholder={copy("聊点什么，", "Message ") + roomName + "…"} />
            <ChannelAction icon="send" label={copy("发送", "Send")} hint="hint-chat-send" iconOnly quiet type="submit" disabled={!draft.trim()} />
          </form>
          <div className="cd-mobile-voice" data-connected={joined}>
            <span><Glyph name="headphones" size={15} />{joined ? copy("语音已连接", "Voice connected") : copy("尚未加入语音", "Not in voice")}</span>
            <ChannelAction icon={muted ? "microphoneOff" : "microphone"} label={copy("麦克风", "Microphone")} pressed={muted} quiet iconOnly onClick={() => setMuted(!muted)} />
            <ChannelAction icon={deafened ? "headphonesOff" : "headphones"} label={copy("收听", "Listening")} pressed={deafened} quiet iconOnly onClick={() => setDeafened(!deafened)} />
          </div>
        </div>
      </main>

      <aside className="cd-members" aria-label={copy("频道成员", "Channel members")}>
        <header><h2>{copy("成员", "Members")} <span>5</span></h2>
          <span className="cd-pane-back"><ChannelAction icon="x" label={copy("返回房间", "Back to room")} quiet iconOnly onClick={() => setMobilePane("room")} /></span></header>
        <div className="cd-member-group"><h3>{copy("这个房间", "In this room")}<span>{here.length}</span></h3>
          {here.map(index => <div className="cd-member" key={index}>
            <Avatar index={index} voice={index === 3 ? selfVoice : true} />
            <div><strong>{name(index)}</strong><small>
              {index === 0 ? copy("正在分享", "Sharing screen") : index === 1 ? copy("正在说话", "Speaking") : index === 2 ? copy("麦克风已关闭", "Microphone muted") : copy("就是你", "That's you")}
            </small></div>
            {index === 0 ? <Glyph name="display" size={16} /> : index === 1 ? <span className="cd-speaking" aria-hidden="true"><i /><i /><i /></span> : null}
          </div>)}
        </div>
        <div className="cd-member-group"><h3>{copy("其他房间", "Elsewhere")}<span>{elsewhere.length}</span></h3>
          {elsewhere.map(index => <div className="cd-member is-away" key={index}><Avatar index={index} /><div><strong>{name(index)}</strong><small>{index === 4 ? copy("在客厅", "In the living room") : copy("在再来一局", "In One more round")}</small></div></div>)}
        </div>
        <div className="cd-members-foot"><Glyph name="couch" size={26} /><p>{copy("在一起就很好。", "Better with company.")}</p></div>
      </aside>
    </div>
    {scene === "create" && <DesignRoomDialog copy={copy} onClose={() => onScene("chat")} onCreate={newRoom => {
      setRooms([...rooms, newRoom]); setRoomId(newRoom.id); setDraft(""); setFocused(3); setMobilePane("room"); onScene("chat");
    }} />}
  </>;
}
