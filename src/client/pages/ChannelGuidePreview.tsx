import { useCallback, useState } from "react";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { snapshotSchema, type ChannelMessage, type ChannelRoom, type ChannelSnapshot, type ChannelTopology, type RoomSettings } from "../channel/protocol";
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
const sources: NativeCaptureSources = { ...SOURCES, codecs: ["h264", "vp8"], videoAdaptation: true,
  sources: SOURCES.sources.filter(source => source.kind === "display" || source.sourceId === "101" || source.sourceId === "102") };

/** Local samples have identities, but no measured or simulated network paths. */
export function sampleRoomTopology(state: ChannelSnapshot, roomId: string, publicationId?: string): ChannelTopology {
  const delivery = state.channel.rooms.find(room => room.id === roomId)!.delivery!;
  const screen = state.publications.find(value => value.roomId === roomId && value.id === publicationId && value.kind === "screen");
  return { bindingId: delivery.bindingId, base: { rootSessionId: delivery.hostSessionId, edges: [] },
    screen: screen ? { publicationId: screen.id, sourceSessionId: screen.sessionId, edges: [] } : null };
}

/** Guide and room previews share local sample props, never a Session or backend. */
export function useChannelGuideSample(multiRoom = false) {
  const { lang } = useCopy(), zh = lang === "zh";
  const [settingsByRoom, setSettingsByRoom] = useState<Record<string, Partial<RoomSettings & Pick<ChannelRoom, "relayOverride">>>>({});
  const settings = settingsByRoom.friday ?? {};
  const roomName = settings.name ?? (zh ? "周五小聚" : "Friday with friends");
  const [quality, setQuality] = useState<QualityProfile>(QUALITY_PROFILES["1080p30"]);
  const [codec, setCodec] = useState<BrowserVideoCodecMode>("auto");
  const [muted, setMuted] = useState(false), [deafened, setDeafened] = useState(false);
  const [joined, setJoined] = useState(true);
  const [voiceLevel, setVoiceLevel] = useState<number>();
  const voiceActivity = useCallback(async () => new Map(voiceLevel === undefined ? [] : [
    ["sample-ada-session", voiceLevel], ["sample-bo-session", voiceLevel / 2],
  ]), [voiceLevel]);
  const [voiceInput, setVoiceInput] = useState({ deviceId: "", voiceProcessing: true, volume: 1 });
  const [listeningVolume, setListeningVolume] = useState(1);
  const [invites, setInvites] = useState<Record<string, string>>({ friday: invitation });
  const [notice, setNotice] = useState("");
  const received = () => setNotice(zh ? "预览已收到操作，不会采集设备或改变真实房间。" : "Preview action received. No device capture or live room was changed.");
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChannelMessage[]>>({});
  const sampleMessages: ChannelMessage[] = [
    { id: "hello", seq: 1, userId: "sample-ada", text: zh ? "晚上好！先在这里聊聊。" : "Hi! We can chat here first.", time: new Date(2020, 0, 1, 20, 0).getTime(), attachments: [] },
    { id: "ready", seq: 2, userId: "sample-bo", text: zh ? "我也加入语音了，随时可以开始。" : "I've joined voice too. Ready when you are.", time: new Date(2020, 0, 1, 20, 1).getTime(), attachments: [] },
    ...(messagesByRoom.friday ?? []),
  ];
  const users = (multiRoom ? ["Ada", "Bo", "Coco", "Dora", "Eli", "Finn", "Gia", "Hana"] : ["Ada", "Bo"])
    .map(name => ({ id: `sample-${name.toLowerCase()}`, name }));
  const rooms = [{ id: "friday", name: roomName, icon: "couch" },
    ...(multiRoom ? [{ id: "studio", name: zh ? "创作小屋" : "Creative studio", icon: "star" }] : [])]
    .map(room => ({ creatorId: "sample-ada", access: "private", hidden: false, hasPassword: false,
      authorized: true, canManage: true, available: true, reading: true,
      delivery: { hostSessionId: "sample-ada-session", bindingId: `sample-binding-${room.id}`, nextHops: {} },
      participantSessionIds: ["sample-ada-session", "sample-bo-session"], capabilities: { attachments: false },
      ...room, ...settingsByRoom[room.id] }));
  const state = snapshotSchema.parse({ channel: { id: "sample", name: "Friends", icon: "couch", ownerId: "sample-ada", historyWindow: 1000,
    access: "private", hasPassword: false, inviteHash: "0".repeat(64), rooms }, users,
    sessions: users.map(user => ({ id: `${user.id}-session`, userId: user.id, online: true, signingKey: Array(32).fill(0) })),
    publications: joined ? [{ id: "voice", kind: "voice", roomId: "friday", sessionId: "sample-ada-session", userId: "sample-ada", paused: false }] : [],
    voice: [...(joined ? [{ sessionId: "sample-ada-session", roomId: "friday", muted, deafened }] : []),
      { sessionId: "sample-bo-session", roomId: "friday", muted: false, deafened: false }],
    subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  const channel = {
    state, self: state.users[0], sessionId: "sample-ada-session", connection: "connected", appConnected: true, pending,
    quality, setQuality, videoCodecMode: codec, setVideoCodecMode: setCodec, ownedScreens: new Set<string>(), streams: new Map<string, MediaStream>(),
    messagesByRoom: { ...messagesByRoom, friday: sampleMessages }, roomBackupAvailable,
    getRoomInvite: async (roomId: string) => ({ state: "available" as const, url: invites[roomId] ?? `https://friends.example/#room=${roomId}&invite=sample` }),
    createRoomInvite: async (roomId: string) => {
      const next = `${invites[roomId] ?? `https://friends.example/#room=${roomId}&invite=sample`}-new`;
      setInvites(previous => ({ ...previous, [roomId]: next })); received(); return next;
    },
    updateRoom: async (roomId: string, next: RoomSettings) => { setSettingsByRoom(previous => ({ ...previous, [roomId]: { ...previous[roomId], ...next } })); received(); },
    deleteRoom: async () => { received(); return { dataRemoved: false }; },
    setRelayOverride: async (roomId: string, relayOverride: number | null) => {
      setSettingsByRoom(previous => ({ ...previous, [roomId]: { ...previous[roomId], relayOverride } })); received();
    },
    nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined,
    nativeSources: async () => sources, nativePreview: previewSource, cameraPreviews: previewCameras,
    sourceMicrophones: async () => [], startScreen: async () => received(), startNativeScreen: async () => received(),
    voiceInput, listeningVolume, voiceActivity,
    roomTopology: async (roomId: string, publicationId?: string) => sampleRoomTopology(state, roomId, publicationId),
    connectionMetrics: async () => [],
    appConnectionMetrics: async () => { throw new Error("No native room in this preview"); },
    canUnmute: () => true, setMuted: async (_room: string, next: boolean) => setMuted(next),
    setDeafened: async (_room: string, next: boolean) => setDeafened(next), leaveVoice: async () => setJoined(false),
    joinVoice: async () => setJoined(true),
    setInputVolume: (volume: number) => setVoiceInput(previous => ({ ...previous, volume })), setListeningVolume,
    microphones: async () => [{ id: "", label: zh ? "默认麦克风" : "Default microphone" }],
    configureVoiceInput: async (next: Partial<typeof voiceInput>) => setVoiceInput(previous => ({ ...previous, ...next })),
    setRoomVoiceBitrate: async (roomId: string, voiceBitrate: number) => setSettingsByRoom(previous => ({ ...previous, [roomId]: { ...previous[roomId], voiceBitrate } })),
  } satisfies Partial<ChannelController> as unknown as ChannelController;
  const onSend: ChannelController["sendMessage"] = async (roomId, text) => {
    setMessagesByRoom(previous => {
      const messages = previous[roomId] ?? [];
      return { ...previous, [roomId]: [...messages, { id: `sample-${roomId}-${messages.length}`, seq: messages.length + 3,
        userId: "sample-ada", text, time: new Date(2020, 0, 1, 20, 2 + messages.length).getTime(), attachments: [] }] };
    });
  };
  return { channel, roomName, sampleMessages, notice, received, onSend, voiceLevel, setVoiceLevel };
}

/** Guide images use these production controls with local sample props. */
export function ChannelGuidePreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const { channel, roomName, sampleMessages, notice, received, onSend } = useChannelGuideSample();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const state = channel.state!;
  return <section id="channel-guide-preview" className="cp-card">
    <header><h2>{zh ? "3.0 房间与分享" : "3.0 rooms and sharing"}</h2></header>
    <p>{zh ? "正式组件与示例房间，不连接服务、不采集设备。邀请链接为示例。" : "Production components with a sample room. No service or device capture; the invitation is an example."}</p>
    <div className="c3-guide-room">
      <aside className="c3-guide-navigation" aria-label={zh ? "房间" : "Rooms"}>
        <ChannelRoomItem room={state.channel.rooms[0]} selected settingsOpen={settingsOpen} voice
          onSelect={() => {}} onManage={() => setSettingsOpen(true)} />
      </aside>
      <div className="c3-guide-main">
      <header className="c3-guide-heading"><div className="c3-guide-title"><ChannelIdentityMark icon="couch" /><strong>{roomName}</strong>
        </div>
        <ChannelShareControl channel={channel} roomId="friday" disabled={false} /></header>
      <ChannelConversation roomId="friday" roomName={roomName} messages={sampleMessages} users={state.users} selfUserId="sample-ada"
        canSend sending={false} hidden={false} available attachments={channel.attachments} attachmentsAvailable={false}
        history={{ hasMore: false, atLatest: true }} loadingHistory={false} onHistory={async () => {}} onLatest={async () => {}}
        isReactionPending={() => false} onReaction={async () => received()} onSend={onSend} />
      <ChannelVoiceDock channel={channel} selected="friday" onSelect={received} onBrowse={received} />
      </div>
    </div>
    {settingsOpen && <ChannelRoomSettingsDialog channel={channel} room={state.channel.rooms[0]} onClose={() => setSettingsOpen(false)} />}
    <p role="status">{notice}</p>
  </section>;
}
