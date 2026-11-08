import { useState } from "react";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelRoomControls } from "../channel/components/ChannelRoomControls";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { snapshotSchema, type ChannelMessage, type RoomSettings } from "../channel/protocol";
import type { ChannelController } from "../channel/types";
import { QUALITY_PROFILES, type QualityProfile } from "../media/quality";
import { useCopy } from "../ui/copy";
import type { NativeCaptureSources } from "../channel/app-link";
import type { BrowserVideoCodecMode } from "../webrtc/video-codec";
import { SOURCES, previewCameras, previewSource } from "./preview-sources";
import "./channel-preview.css";
import "./channel-guide-preview.css";

const invitation = "https://friends.example/#room=friday&invite=sample";
const pending = new Set<string>();
const roomBackupAvailable = async () => false;
const sources: NativeCaptureSources = { ...SOURCES, codecs: ["h264", "vp8"],
  sources: SOURCES.sources.filter(source => source.kind === "display" || source.sourceId === "101" || source.sourceId === "102") };

/** Guide and room previews share local sample props, never a Session or backend. */
export function useChannelGuideSample() {
  const { lang } = useCopy(), zh = lang === "zh";
  const [settings, setSettings] = useState<Partial<RoomSettings>>({});
  const roomName = settings.name ?? (zh ? "周五小聚" : "Friday with friends");
  const [quality, setQuality] = useState<QualityProfile>(QUALITY_PROFILES["1080p30"]);
  const [codec, setCodec] = useState<BrowserVideoCodecMode>("auto");
  const [muted, setMuted] = useState(false), [deafened, setDeafened] = useState(false);
  const [joined, setJoined] = useState(true);
  const [voiceInput, setVoiceInput] = useState({ deviceId: "", voiceProcessing: true, volume: 1 });
  const [listeningVolume, setListeningVolume] = useState(1);
  const [invite, setInvite] = useState(invitation);
  const [notice, setNotice] = useState("");
  const received = () => setNotice(zh ? "预览已收到操作，不会采集设备或改变真实房间。" : "Preview action received. No device capture or live room was changed.");
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const sampleMessages: ChannelMessage[] = [
    { id: "hello", seq: 1, userId: "sample-ada", text: zh ? "晚上好！先在这里聊聊。" : "Hi! We can chat here first.", time: new Date(2020, 0, 1, 20, 0).getTime(), attachments: [] },
    { id: "ready", seq: 2, userId: "sample-bo", text: zh ? "我也加入语音了，随时可以开始。" : "I've joined voice too. Ready when you are.", time: new Date(2020, 0, 1, 20, 1).getTime(), attachments: [] },
    ...messages,
  ];
  const state = snapshotSchema.parse({ channel: { id: "sample", name: "Friends", icon: "couch", ownerId: "sample-ada", historyWindow: 1000,
    access: "private", hasPassword: false, inviteHash: "0".repeat(64), rooms: [{ id: "friday", name: roomName, icon: "couch", creatorId: "sample-ada",
      access: "private", hidden: false, hasPassword: false, authorized: true, canManage: true, available: true, reading: true,
      participantSessionIds: ["sample-ada-session", "sample-bo-session"], capabilities: { attachments: false }, ...settings }] },
    users: [{ id: "sample-ada", name: "Ada" }, { id: "sample-bo", name: "Bo" }],
    sessions: ["sample-ada", "sample-bo"].map(id => ({ id: `${id}-session`, userId: id, online: true, signingKey: Array(32).fill(0) })),
    publications: joined ? [{ id: "voice", kind: "voice", roomId: "friday", sessionId: "sample-ada-session", userId: "sample-ada", paused: false }] : [],
    voice: [...(joined ? [{ sessionId: "sample-ada-session", roomId: "friday", muted, deafened }] : []),
      { sessionId: "sample-bo-session", roomId: "friday", muted: false, deafened: false }],
    subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  const channel = {
    state, self: state.users[0], sessionId: "sample-ada-session", connection: "connected", appConnected: true, pending,
    quality, setQuality, videoCodecMode: codec, setVideoCodecMode: setCodec, ownedScreens: new Set<string>(), streams: new Map<string, MediaStream>(),
    messagesByRoom: { friday: sampleMessages }, roomBackupAvailable, getRoomInvite: async () => ({ state: "available" as const, url: invite }),
    createRoomInvite: async () => { const next = `${invite}-new`; setInvite(next); received(); return next; },
    updateRoom: async (_room: string, next: RoomSettings) => { setSettings(next); received(); },
    deleteRoom: async () => { received(); return { dataRemoved: false }; },
    setRelayOverride: async (_room: string, relayOverride: number | null) => { setSettings(previous => ({ ...previous, relayOverride })); received(); },
    nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined,
    nativeSources: async () => sources, nativePreview: previewSource, cameraPreviews: previewCameras,
    sourceMicrophones: async () => [], startScreen: async () => received(), startNativeScreen: async () => received(),
    voiceInput, listeningVolume,
    canUnmute: () => true, setMuted: async (_room: string, next: boolean) => setMuted(next),
    setDeafened: async (_room: string, next: boolean) => setDeafened(next), leaveVoice: async () => setJoined(false),
    joinVoice: async () => setJoined(true),
    setInputVolume: (volume: number) => setVoiceInput(previous => ({ ...previous, volume })), setListeningVolume,
    microphones: async () => [{ id: "", label: zh ? "默认麦克风" : "Default microphone" }],
    configureVoiceInput: async (next: Partial<typeof voiceInput>) => setVoiceInput(previous => ({ ...previous, ...next })),
    setRoomVoiceBitrate: async (_room: string, voiceBitrate: number) => setSettings(previous => ({ ...previous, voiceBitrate })),
  } satisfies Partial<ChannelController> as unknown as ChannelController;
  const onSend: ChannelController["sendMessage"] = async (_room, text) => {
    setMessages(previous => [...previous, { id: `sample-${previous.length}`, seq: previous.length + 3,
      userId: "sample-ada", text, time: new Date(2020, 0, 1, 20, 2 + previous.length).getTime(), attachments: [] }]);
  };
  return { channel, roomName, sampleMessages, notice, received, onSend };
}

/** Guide images use these production controls with local sample props. */
export function ChannelGuidePreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const { channel, roomName, sampleMessages, notice, received, onSend } = useChannelGuideSample();
  const state = channel.state!;
  return <section id="channel-guide-preview" className="cp-card">
    <header><h2>{zh ? "3.0 房间与分享" : "3.0 rooms and sharing"}</h2></header>
    <p>{zh ? "正式组件与示例房间，不连接服务、不采集设备。邀请链接为示例。" : "Production components with a sample room. No service or device capture; the invitation is an example."}</p>
    <div className="c3-guide-room">
      <header className="c3-guide-heading"><div className="c3-guide-title"><ChannelIdentityMark icon="couch" /><strong>{roomName}</strong>
        <ChannelRoomControls channel={channel} room={state.channel.rooms[0]} /></div>
        <ChannelShareControl channel={channel} roomId="friday" disabled={false} /></header>
      <ChannelConversation roomId="friday" roomName={roomName} messages={sampleMessages} users={state.users} selfUserId="sample-ada"
        canSend sending={false} hidden={false} available attachments={channel.attachments} attachmentsAvailable={false}
        history={{ hasMore: false, atLatest: true }} loadingHistory={false} onHistory={async () => {}} onLatest={async () => {}}
        isReactionPending={() => false} onReaction={async () => received()} onSend={onSend} />
      <ChannelVoiceDock channel={channel} selected="friday" onSelect={received} onBrowse={received} />
    </div>
    <p role="status">{notice}</p>
  </section>;
}
