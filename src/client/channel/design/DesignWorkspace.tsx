import { useEffect, useState } from "react";
import { REACTION_DURATION_MS, REACTION_IDS, type ReactionId } from "../../../shared/room-interactions";
import { Glyph } from "../../ui/icons";
import { BrandMark } from "../../components/living/BrandMark";
import { WelcomeLine } from "../../components/living/WelcomeLine";
import { RoomQuickReactions } from "../../components/living/RoomQuickReactions";
import { RoomReactionActivity } from "../../components/living/RoomReactionActivity";
import type { RoomInteraction } from "../../lib/room-interactions";
import { ChannelAction } from "../components/ChannelMedia";
import { DesignArtwork } from "./DesignArtwork";
import { DesignRoomDialog } from "./DesignRoomDialog";
import { DesignChannelDialog } from "./DesignChannelDialog";
import { DesignAvatar as Avatar } from "./DesignAvatar";
import { DesignConversation } from "./DesignConversation";
import { DesignIdentityMark, type DesignIdentity } from "./DesignIdentityPicker";
import { designPeople, designRooms, type DesignCopy, type DesignScene } from "./fixtures";

import "../../components/living/floating-panel.css";
import "../../components/living/room-interactions.css";
import "./design-social.css";

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
  const [focused, setFocused] = useState(0);
  const [channelName, setChannelName] = useState<string>();
  const [channelIdentity, setChannelIdentity] = useState<DesignIdentity>({ icon: "couch" });
  const [editingChannel, setEditingChannel] = useState(false);
  const [personMenu, setPersonMenu] = useState<{ index: number; trigger: HTMLElement } | null>(null);
  const [activity, setActivity] = useState<(RoomInteraction & { expiresAt: number }) | null>(null);
  const room = rooms.find(item => item.id === roomId)!;
  const roomName = designRooms(copy).find(item => item.id === roomId)?.name ?? room.name;
  const demoRoom = roomId === "games";
  const sharing = sharingRoom === roomId;
  const screenIds = [...(demoRoom ? [0, 1] : []), ...(sharing ? [3] : [])];
  const showingScreens = screenIds.length > 0 && !screensHidden && (scene === "screens" || scene === "focus" || sharing);
  const selfVoice = joined ? { microphone: !muted, deafened } : false;
  const here = demoRoom ? [0, 1, 2, 3] : [3];
  const elsewhere = demoRoom ? [4] : [0, 1, 2, 4];
  const name = (index: number) => copy(designPeople[index].name, designPeople[index].english);

  const channelTitle = channelName ?? copy("下班以后", "After hours");
  const interact = (index: number, trigger: HTMLElement) => setPersonMenu({ index, trigger });
  const participants = designPeople.map((person, index) => ({ peerId: person.id, displayName: name(index) }));
  useEffect(() => { setMobilePane("room"); setScreensHidden(false); setPersonMenu(null); setActivity(null); }, [scene, roomId]);
  useEffect(() => {
    if (!activity) return;
    const timer = setTimeout(() => setActivity(null), Math.max(0, activity.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [activity]);
  function react(reaction: ReactionId, targetPeerId?: string) {
    const occurredAt = Date.now();
    setActivity({ type: "room-interaction", id: crypto.randomUUID(), requestId: crypto.randomUUID(), occurredAt,
      sender: { peerId: designPeople[3].id, role: "viewer", displayName: name(3) },
      payload: { kind: "reaction", reaction, targetPeerId }, expiresAt: occurredAt + REACTION_DURATION_MS });
  }

  return <>
    <div className="cd-workspace" data-pane={mobilePane}>
      <nav className="cd-channel-rail" aria-label={copy("频道", "Channels")}>
        <span className="cd-rail-brand" aria-label="Piik"><BrandMark size={30} /></span>
        <span className="cd-rail-rule" />
        <button type="button" className="lr-btn cd-channel-icon is-on" aria-label={channelTitle}
          onClick={() => { setRoomId("games"); setMobilePane("rooms"); }}>
          <DesignIdentityMark value={channelIdentity} size={28} />
        </button>
        <span className="cd-rail-bottom">3.0</span>
      </nav>

      <aside className="cd-rooms" aria-label={copy("房间", "Rooms")}>
        <header className="cd-channel-heading">
          <div><small>{copy("一个属于朋友的频道", "A place for your people")}</small><h2>{channelTitle}</h2></div>
          <ChannelAction icon="pencil" label={copy("频道外观", "Channel appearance")} iconOnly quiet hint="hint-rename" onClick={() => setEditingChannel(true)} />
          <span className="cd-pane-back"><ChannelAction icon="x" label={copy("返回房间", "Back to room")} quiet iconOnly onClick={() => setMobilePane("room")} /></span>
        </header>
        <div className="cd-room-nav">
          <div className="cd-section-label"><span>{copy("房间", "Rooms")}</span>
            <ChannelAction icon="plus" label={copy("创建房间", "Create room")} hint="hint-create-room" quiet iconOnly onClick={() => onScene("create")} />
          </div>
          <nav aria-label={copy("房间列表", "Room list")}>
            {rooms.map(item => <button key={item.id} type="button" className="cd-room-link"
              aria-current={roomId === item.id ? "page" : undefined}
              onClick={() => { setRoomId(item.id); setMobilePane("room"); setFocused(item.id === "games" ? 0 : 3); }}>
              <DesignIdentityMark value={item} size={21} />
              <span>{designRooms(copy).find(preset => preset.id === item.id)?.name ?? item.name}</span>
              {item.id === "games" ? <small>4</small> : item.private ? <Glyph name={item.hidden ? "eyeOff" : "lock"} size={14} /> : null}
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
            <Avatar index={3} voice={selfVoice} onInteract={interact} /><div className="cd-self-name"><strong>{name(3)}</strong><small>{copy("在线", "Online")}</small></div>
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
          <span className="cd-room-heading-icon"><DesignIdentityMark value={room} size={23} /></span>
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

          <DesignConversation room={room} roomName={roomName} copy={copy} showingScreens={showingScreens} onInteract={interact} />
          {activity && <div className="cd-live-interaction"><RoomReactionActivity key={activity.id} reaction={activity} participants={participants} hostPeerId={designPeople[0].id} now={Date.now} /></div>}
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
          {here.map(index => <button type="button" className="cd-member cd-member-button" key={index} aria-label={copy("与", "Interact with ") + name(index) + copy("互动", "")}
            onClick={event => interact(index, event.currentTarget)}>
            <Avatar index={index} voice={index === 3 ? selfVoice : true} />
            <div><strong>{name(index)}</strong><small>
              {index === 0 ? copy("正在分享", "Sharing screen") : index === 1 ? copy("正在说话", "Speaking") : index === 2 ? copy("麦克风已关闭", "Microphone muted") : copy("就是你", "That's you")}
            </small></div>
            {index === 0 ? <Glyph name="display" size={16} /> : index === 1 ? <span className="cd-speaking" aria-hidden="true"><i /><i /><i /></span> : null}
          </button>)}
        </div>
        <div className="cd-member-group"><h3>{copy("其他房间", "Elsewhere")}<span>{elsewhere.length}</span></h3>
          {elsewhere.map(index => <div className="cd-member is-away" key={index}><Avatar index={index} /><div><strong>{name(index)}</strong><small>{index === 4 ? copy("在客厅", "In the living room") : copy("在再来一局", "In One more round")}</small></div></div>)}
        </div>
        <div className="cd-members-foot"><Glyph name="couch" size={26} /><WelcomeLine still /></div>
      </aside>
    </div>
    {scene === "create" && <DesignRoomDialog copy={copy} onClose={() => onScene("chat")} onCreate={newRoom => {
      setRooms([...rooms, newRoom]); setRoomId(newRoom.id); setFocused(3); setMobilePane("room"); onScene("chat");
    }} />}
    {editingChannel && <DesignChannelDialog copy={copy} name={channelTitle} identity={channelIdentity} onClose={() => setEditingChannel(false)}
      onSave={(newName, identity) => { setChannelName(newName); setChannelIdentity(identity); setEditingChannel(false); }} />}
    {personMenu && <RoomQuickReactions id="cd-person-actions" trigger={personMenu.trigger} person={participants[personMenu.index]}
      selfPeerId={designPeople[3].id} hostPeerId={designPeople[0].id} reactionIds={REACTION_IDS} canSend
      onSend={react} onClose={() => setPersonMenu(null)} />}
  </>;
}
