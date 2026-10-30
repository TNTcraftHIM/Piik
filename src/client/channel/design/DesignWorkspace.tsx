import { useEffect, useState } from "react";
import { Glyph } from "../../ui/icons";
import { WelcomeLine } from "../../components/living/WelcomeLine";
import { ChannelAction } from "../components/ChannelMedia";
import { ChannelNameEditor } from "../components/ChannelNameEditor";
import { ChannelBookmarks } from "../components/ChannelBookmarks";
import { DesignArtwork } from "./DesignArtwork";
import { DesignRoomDialog } from "./DesignRoomDialog";
import { DesignChannelDialog } from "./DesignChannelDialog";
import { DesignAvatar as Avatar } from "./DesignAvatar";
import { DesignConversation, useDesignConversation } from "./DesignConversation";
import { DesignCouch, useDesignReactions } from "./DesignCouch";
import { DesignRoomPanel } from "./DesignRoomPanel";
import { DesignVoiceControls, DesignVoiceJoin } from "./DesignVoiceControls";
import { DesignIdentityMark, type DesignIdentity } from "./DesignIdentityPicker";
import { DesignNames } from "./DesignNames";
import { designPeople, designRooms, type DesignCopy, type DesignRoom, type DesignScene } from "./fixtures";

import "../../components/living/floating-panel.css";
import "../../components/living/room-interactions.css";
import "./design-social.css";

export function DesignWorkspace({ copy, scene, peopleCount, onScene }: {
  copy: DesignCopy; scene: DesignScene; peopleCount: number; onScene(scene: DesignScene): void;
}) {
  const [roomChanges, setRoomChanges] = useState<Record<string, DesignRoom>>({});
  const presetRooms = designRooms(copy);
  const rooms = [...presetRooms.map(room => roomChanges[room.id] ?? room),
    ...Object.values(roomChanges).filter(room => !presetRooms.some(preset => preset.id === room.id))];
  const [roomId, setRoomId] = useState("games");
  const [mobilePane, setMobilePane] = useState<"room" | "rooms" | "members">("room");
  const [joined, setJoined] = useState(true);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [inputVolume, setInputVolume] = useState(1);
  const [listeningVolume, setListeningVolume] = useState(1);
  const [sharingRoom, setSharingRoom] = useState<string | null>(null);
  const [screensHidden, setScreensHidden] = useState(false);
  const [focused, setFocused] = useState(0);
  const [channelName, setChannelName] = useState<string>();
  const [channelIdentity, setChannelIdentity] = useState<DesignIdentity>({ icon: "couch" });
  const [editingChannel, setEditingChannel] = useState(false);
  const [editingRoom, setEditingRoom] = useState(false);
  const [selfName, setSelfName] = useState<string>();
  const name = (index: number) => index === 3 && selfName !== undefined ? selfName : copy(designPeople[index].name, designPeople[index].english);
  const conversation = useDesignConversation();
  const reactions = useDesignReactions(roomId, name(3));
  const voice = { joined, muted, deafened, inputVolume, listeningVolume, setInputVolume, setListeningVolume,
    toggleJoined: () => { setJoined(!joined); if (joined) setMuted(true); },
    toggleMuted: () => setMuted(!muted), toggleDeafened: () => setDeafened(!deafened) };
  const room = rooms.find(item => item.id === roomId)!;
  const roomName = room.name;
  const demoRoom = roomId === "games";
  const sharing = sharingRoom === roomId;
  const screenIds = [...(demoRoom ? [0, 1] : []), ...(sharing ? [3] : [])];
  const showingScreens = screenIds.length > 0 && !screensHidden && (scene === "screens" || scene === "focus" || sharing);
  const selfVoice = joined ? { microphone: !muted, deafened } : false;
  const demoPeople = [0, 1, 2, 3, ...Array.from({ length: peopleCount - 4 }, (_, index) => index + 5)];
  const here = demoRoom ? demoPeople : [3];
  const elsewhere = demoRoom ? [4] : [...demoPeople.filter(index => index !== 3), 4];

  const channelTitle = channelName ?? copy("下班以后", "After hours");
  useEffect(() => { setMobilePane("room"); setScreensHidden(false); }, [scene, roomId]);

  return <DesignNames.Provider value={name}>
    <div className="cd-workspace" data-pane={mobilePane}>
      <ChannelBookmarks className="cd-channel-rail" currentName={channelTitle} currentIcon={<DesignIdentityMark value={channelIdentity} size={28} />}
        onCurrent={() => { setRoomId("games"); setMobilePane("rooms"); }} />

      <aside className="cd-rooms" aria-label={copy("房间", "Rooms")}>
        <header className="cd-channel-heading c3-editable">
          <div className="cd-channel-heading-text"><small>{copy("一个属于朋友的频道", "A place for your people")}</small><h2>{channelTitle}</h2></div>
          <span className="c3-edit-action"><ChannelAction icon="pencil" label={copy("频道外观", "Channel appearance")} iconOnly quiet hint="hint-rename" onClick={() => setEditingChannel(true)} /></span>
          <span className="cd-pane-back"><ChannelAction icon="x" label={copy("返回房间", "Back to room")} hint="hint-collapse" quiet iconOnly onClick={() => setMobilePane("room")} /></span>
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
              <span>{item.name}</span>
              {item.id === "games" ? <small>{demoPeople.length - Number(!demoRoom)}</small> : item.private ? <Glyph name={item.hidden ? "eyeOff" : "lock"} size={14} /> : null}
            </button>)}
          </nav>
        </div>
        <div className="cd-nav-bottom">
          <div className="cd-voice-session" data-connected={joined}>
            <div className="cd-voice-title"><Glyph name="headphones" size={17} /><strong>{joined ? copy("语音已连接", "Voice connected") : copy("随时来聊聊", "Come hang out")}</strong></div>
            <div className="cd-voice-detail"><span>{roomName}</span><DesignVoiceJoin voice={voice} /></div>
          </div>
          <div className="cd-self">
            <Avatar index={3} voice={selfVoice} /><div className="cd-self-name">
              <div className="cd-self-heading c3-editable"><strong>{name(3)}</strong><ChannelNameEditor name={name(3)} disabled={false} onSave={setSelfName} /></div>
              <small>{copy("在线", "Online")}</small></div>
            <DesignVoiceControls voice={voice} />
          </div>
        </div>
      </aside>

      <main className="cd-room">
        <header className="cd-room-heading">
          <div className="cd-room-title">
            <span className="cd-mobile-rooms"><ChannelAction icon="arrowLeft" label={copy("房间列表", "Rooms")} hint="hint-collapse" quiet iconOnly onClick={() => setMobilePane("rooms")} /></span>
            <span className="cd-room-heading-icon"><DesignIdentityMark value={room} size={23} /></span>
            <div className="cd-room-heading-text"><div className="cd-room-heading-name c3-editable"><h2>{roomName}</h2>
              <span className="c3-edit-action"><ChannelAction icon="pencil" label={copy("房间设置", "Room settings")} hint="hint-rename" iconOnly quiet onClick={() => setEditingRoom(true)} /></span>
            </div><span>{demoRoom ? copy("输赢不重要，人在就好。", "Good company. Questionable skills.") : copy("留个地方，一起聊聊。", "A place to get together.")}</span></div>
          </div>
          <DesignCouch key={roomId} people={here} selfVoice={selfVoice} copy={copy} reactions={reactions} />
          <div className="cd-room-actions">
            <DesignRoomPanel room={room} roomName={roomName} people={here} conversation={conversation} reactions={reactions} voice={voice} copy={copy} />
            <span className="cd-header-action"><ChannelAction icon={sharing ? "stop" : "share"} primary={!sharing} hint={sharing ? "hint-share-stop" : "hint-share-start"}
              label={sharing ? copy("停止分享", "Stop sharing") : copy("分享屏幕", "Share screen")} onClick={() => {
                setSharingRoom(sharing ? null : roomId); setScreensHidden(false);
                setFocused(sharing ? 0 : 3);
              }} /></span>
            <span className="cd-mobile-members"><ChannelAction icon="users" label={copy("成员", "Members")} hint="hint-details" quiet iconOnly onClick={() => setMobilePane("members")} /></span>
          </div>
        </header>

        <div className="cd-room-content">
          {showingScreens ? <section className={"cd-stage" + (scene === "focus" ? " is-focused" : "")} aria-label={copy("分享的画面", "Shared screens")}>
            <div className="cd-stage-heading"><span><Glyph name="display" size={16} />{copy("正在观看", "Watching")} <b>{screenIds.length}</b></span>
              <ChannelAction icon="x" label={copy("收起画面", "Hide screens")} hint="hint-collapse" quiet onClick={() => setScreensHidden(true)} />
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

          <DesignConversation room={room} roomName={roomName} copy={copy} showingScreens={showingScreens} model={conversation} />
          <div className="cd-mobile-voice" data-connected={joined}>
            <span><Glyph name="headphones" size={15} />{joined ? copy("语音已连接", "Voice connected") : copy("尚未加入语音", "Not in voice")}</span>
            <DesignVoiceControls voice={voice} /><DesignVoiceJoin voice={voice} />
          </div>
        </div>
      </main>

      <aside className="cd-members" aria-label={copy("频道成员", "Channel members")}>
        <header><h2>{copy("成员", "Members")} <span>{here.length + elsewhere.length}</span></h2>
          <span className="cd-pane-back"><ChannelAction icon="x" label={copy("返回房间", "Back to room")} hint="hint-collapse" quiet iconOnly onClick={() => setMobilePane("room")} /></span></header>
        <div className="cd-member-list">
          <div className="cd-member-group"><h3>{copy("这个房间", "In this room")}<span>{here.length}</span></h3>
            {here.map(index => <div className="cd-member" key={index}>
              <Avatar index={index} voice={index === 3 ? selfVoice : true} />
              <div><strong>{name(index)}</strong><small>
                {index === 0 ? copy("正在分享", "Sharing screen") : index === 1 ? copy("正在说话", "Speaking") : index === 2 ? copy("麦克风已关闭", "Microphone muted") : index === 3 ? copy("就是你", "That's you") : copy("正在收听", "Listening")}
              </small></div>
              {index === 0 ? <Glyph name="display" size={16} /> : index === 1 ? <span className="cd-speaking" aria-hidden="true"><i /><i /><i /></span> : null}
            </div>)}
          </div>
          <div className="cd-member-group"><h3>{copy("其他房间", "Elsewhere")}<span>{elsewhere.length}</span></h3>
            {elsewhere.map(index => <div className="cd-member is-away" key={index}><Avatar index={index} /><div><strong>{name(index)}</strong>
              <small>{copy("在", "In ")}{rooms.find(item => item.id === (index === 4 ? "lounge" : "games"))!.name}</small>
            </div></div>)}
          </div>
        </div>
        <div className="cd-members-foot"><Glyph name="couch" size={26} /><WelcomeLine still /></div>
      </aside>
    </div>
    {scene === "create" && <DesignRoomDialog copy={copy} onClose={() => onScene("chat")} onSave={newRoom => {
      setRoomChanges(previous => ({ ...previous, [newRoom.id]: newRoom })); setRoomId(newRoom.id); setFocused(3); setMobilePane("room"); onScene("chat");
    }} />}
    {editingRoom && <DesignRoomDialog key={room.id} copy={copy} room={room} onClose={() => setEditingRoom(false)}
      onSave={updated => { setRoomChanges(previous => ({ ...previous, [updated.id]: updated })); setEditingRoom(false); }} />}
    {editingChannel && <DesignChannelDialog copy={copy} name={channelTitle} identity={channelIdentity} onClose={() => setEditingChannel(false)}
      onSave={(newName, identity) => { setChannelName(newName); setChannelIdentity(identity); setEditingChannel(false); }} />}
  </DesignNames.Provider>;
}
