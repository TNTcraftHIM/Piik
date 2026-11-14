import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelRoomInvitation } from "../channel/components/ChannelRoomInvitation";
import { ChannelShareControl } from "../channel/components/ChannelShareControl";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { snapshotSchema, type ChannelMessage, type ChannelRoom, type ChannelSnapshot, type ChannelTopology, type RoomSettings } from "../channel/protocol";
import type { ChannelController } from "../channel/types";
import { ChannelAttachments } from "../channel/attachments";
import { readBackup } from "../channel/backup-archive";
import { FeedbackAudio, type FeedbackCue } from "../channel/feedback-audio";
import { validateCustomFeedbackClip } from "../channel/feedback-clip";
import { QUALITY_PROFILES, type QualityProfile } from "../media/quality";
import { usePreviewInteractions } from "./use-preview-interactions";
import { useCopy } from "../ui/copy";
import type { NativeCaptureSources } from "../channel/app-link";
import type { BrowserVideoCodecMode } from "../webrtc/video-codec";
import { SOURCES, previewCameras, previewSource } from "./preview-sources";
import "./channel-preview.css";
import "./channel-guide-preview.css";

const invitation = "https://friends.example/#room=friday&invite=sample";
const pending = new Set<string>();
const roomBackupAvailable = async () => false;
const sources: NativeCaptureSources = { ...SOURCES, codecs: ["h264", "vp8"], softwareEncodingCodecs: ["h264", "vp8"], videoAdaptation: true, externalInput: false,
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
  const [profile, setProfile] = useState<{ name: string; avatar: string | null }>({ name: "Ada", avatar: null });
  const settings = settingsByRoom.friday ?? {};
  const roomName = settings.name ?? (zh ? "周五小聚" : "Friday with friends");
  const [quality, setQuality] = useState<QualityProfile>(QUALITY_PROFILES["1080p30"]);
  const [encodingExecution, setEncodingExecution] = useState<ChannelController["encodingExecution"]>("auto");
  const [codec, setCodec] = useState<BrowserVideoCodecMode>("auto");
  const [feedbackSound, setFeedbackSound] = useState<ChannelController["feedbackSound"]>({ enabled: false, volume: 1 });
  const feedbackCurrent = useRef(feedbackSound), feedbackImport = useRef(0);
  const [feedbackAudio] = useState(() => new FeedbackAudio());
  useEffect(() => () => { feedbackImport.current++; feedbackAudio.close(); }, [feedbackAudio]);
  function updateFeedback(patch: Partial<typeof feedbackSound>) {
    const next = { ...feedbackCurrent.current, ...patch };
    feedbackCurrent.current = next; setFeedbackSound(next); feedbackAudio.configure(next);
    if (next.enabled) feedbackAudio.activate();
  }
  const [voiceByRoom, setVoiceByRoom] = useState<Record<string, { muted: boolean; deafened: boolean }>>({
    friday: { muted: false, deafened: false },
  });
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
  // No session or FileStore is attached: these confirmed sample bytes stay in this page.
  const [attachments] = useState(() => new ChannelAttachments(async () => {}, async () => {}));
  const nextMessage = useRef(3);
  useEffect(() => () => attachments.reset(), [attachments]);
  const onSend: ChannelController["sendMessage"] = async (roomId, text, files = [], signal, options = {}) => {
    const prepared = await attachments.describe(files, signal);
    signal?.throwIfAborted();
    const seq = nextMessage.current++;
    const target = options.reply && [...(messagesByRoom[roomId] ?? []), ...sampleMessages].find(message => message.seq === options.reply?.seq);
    const message: ChannelMessage = { id: `sample-${roomId}-${seq}`, seq, userId: "sample-ada", text, mentions: options.mentions,
      ...(target && options.reply ? { reply: { seq: target.seq, userId: target.userId, text: target.text.slice(0, 160), notify: options.reply.notify } } : {}),
      time: new Date(2020, 0, 1, 20, seq).getTime(), attachments: prepared.map(file => file.attachment),
      inlineImages: Object.fromEntries(prepared.flatMap(file => file.inlineImage ? [[file.id, file.inlineImage]] : [])) };
    attachments.confirmed(roomId, message, prepared);
    setMessagesByRoom(previous => ({ ...previous, [roomId]: [...(previous[roomId] ?? []), message] }));
  };
  const [messageReactions, setMessageReactions] = useState<Record<number, import("../channel/protocol").MessageReactions>>({});
  const [publicationReactions, setPublicationReactions] = useState(new Map<string, import("../channel/protocol").PublicationReactionSnapshot>());
  const { session: interaction } = usePreviewInteractions(false, { self: { peerId: "sample-ada", displayName: "Ada" }, friend: { peerId: "sample-bo", displayName: "Bo" } }, (reaction, target) => {
    if ("messageSeq" in target) setMessageReactions(previous => ({ ...previous, [target.messageSeq]: {
      revision: (previous[target.messageSeq]?.revision ?? 0) + 1,
      counts: { ...previous[target.messageSeq]?.counts, [reaction]: (previous[target.messageSeq]?.counts[reaction] ?? 0) + 1 },
    } }));
    else setPublicationReactions(previous => new Map(previous).set(target.publicationId, {
      publicationId: target.publicationId, revision: (previous.get(target.publicationId)?.revision ?? 0) + 1,
      counts: { ...previous.get(target.publicationId)?.counts, [reaction]: (previous.get(target.publicationId)?.counts[reaction] ?? 0) + 1 },
    }));
  });
  const sampleMessages: ChannelMessage[] = [
    { id: "hello", seq: 1, userId: "sample-ada", text: zh ? "晚上好！先在这里聊聊。" : "Hi! We can chat here first.", time: new Date(2020, 0, 1, 20, 0).getTime(), attachments: [] },
    { id: "ready", seq: 2, userId: "sample-bo", text: zh ? "我也加入语音了，随时可以开始。" : "I've joined voice too. Ready when you are.", time: new Date(2020, 0, 1, 20, 1).getTime(), attachments: [] },
    ...(messagesByRoom.friday ?? []),
  ];
  const users = (multiRoom ? ["Ada", "Bo", "Coco", "Dora", "Eli", "Finn", "Gia", "Hana", "Iris"] : ["Ada", "Bo"])
    .map(name => ({ id: `sample-${name.toLowerCase()}`, name, avatar: null, ...(name === "Ada" ? profile : {}), version: "0".repeat(64) }));
  const rooms = [{ id: "friday", name: roomName, icon: "couch" },
    ...(multiRoom ? [{ id: "studio", name: zh ? "创作小屋" : "Creative studio", icon: "star" }] : [])]
    .map(room => ({ creatorId: "sample-ada", access: "private" as const, hidden: false, hasPassword: false,
      authorized: true, canManage: true, available: true, reading: true, lastMessageSeq: room.id === "friday" ? sampleMessages.at(-1)?.seq ?? 0 : messagesByRoom[room.id]?.at(-1)?.seq ?? 0,
      delivery: { hostSessionId: "sample-ada-session", bindingId: `sample-binding-${room.id}`, nextHops: {} },
      realtimeSessionIds: room.id === "studio" ? (voiceByRoom.studio ? ["sample-ada-session"] : []) : ["sample-bo-session", ...(voiceByRoom.friday ? ["sample-ada-session"] : [])],
      participantSessionIds: room.id === "studio" ? ["sample-coco-session", ...(voiceByRoom.studio ? ["sample-ada-session"] : [])] : ["sample-ada-session", "sample-bo-session"], capabilities: { attachments: true },
      ...room, ...settingsByRoom[room.id] }));
  const state = snapshotSchema.parse({ channel: { id: "sample", name: "Friends", icon: "couch", ownerId: "sample-ada", historyWindow: 1000, userCount: users.length,
    rooms }, users: users.map(({ avatar: _avatar, ...user }) => user),
    sessions: users.map(user => ({ id: `${user.id}-session`, userId: user.id, online: user.id !== "sample-iris", signingKey: Array(32).fill(0) })),
    publications: Object.keys(voiceByRoom).map(roomId => ({ audience: [], id: `voice-${roomId}`, kind: "voice", roomId,
      sessionId: "sample-ada-session", userId: "sample-ada", paused: false })),
    voice: [...Object.entries(voiceByRoom).map(([roomId, voice]) => ({ sessionId: "sample-ada-session", roomId, ...voice })),
      { sessionId: "sample-bo-session", roomId: "friday", muted: false, deafened: false }],
    subscriptions: [], watchActivities: [], watchSubscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  } satisfies z.input<typeof snapshotSchema>);
  const channel = {
    inspectRoomCopy: async (file: Blob) => {
      const metadata = await readBackup(file);
      if (metadata.kind !== "room_copy") throw new Error("expected_room_copy");
      return metadata.roomInfo ?? {};
    },
    exportRoomCopy: async () => { received(); throw new Error("preview_only"); },
    importRoomCopy: async () => { received(); throw new Error("preview_only"); },
    feedbackSound, setFeedbackSound: updateFeedback,
    setFeedbackClip: async (cue: FeedbackCue, file: File | null) => {
      const current = ++feedbackImport.current;
      const clip = file ? await validateCustomFeedbackClip(file) : undefined;
      if (current !== feedbackImport.current) return;
      const clips = { ...feedbackCurrent.current.clips };
      if (clip) clips[cue] = clip; else delete clips[cue];
      updateFeedback({ clips });
    },
    previewFeedbackSound: feedbackAudio.preview,
    updateProfile: async (value: { name: string; avatar: string | null }) => setProfile(value),
    state, self: users[0], profiles: new Map(users.map(user => [user.id, user])),
    loadProfiles: async (ids: readonly string[]) => users.filter(user => ids.includes(user.id)),
    queryProfiles: async ({ after, query }: { after?: string; query?: string }) => {
      const matches = users.filter(user => !query || user.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.id.localeCompare(b.id));
      const rows = matches.filter(user => !after || user.id > after), page = rows.slice(0, 32);
      return { profiles: page, total: matches.length, nextCursor: rows.length > page.length ? page.at(-1)!.id : null };
    },
    sessionId: "sample-ada-session", connection: "connected", appConnected: true, pending, attachments, sendMessage: onSend,
    readByRoom: {}, markRead: () => {}, loadMessage: async () => {},
    quality, setQuality, encodingExecution, setEncodingExecution, screenEncodingExecution: () => undefined, videoCodecMode: codec, setVideoCodecMode: setCodec, ownedScreens: new Set<string>(), localScreens: new Set<string>(), streams: new Map<string, MediaStream>(),
    messagesByRoom: { ...messagesByRoom, friday: sampleMessages.map(message => ({ ...message, reactions: messageReactions[message.seq] })) },
    interactionsByRoom: new Map(interaction ? [["friday", interaction]] : []), publicationReactions, roomBackupAvailable,
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
    sourceSelectionCommitting: () => false,
    externalInput: () => undefined, startExternalScreen: async () => received(),
    nativeSources: async () => sources, nativePreview: previewSource, cameraPreviews: previewCameras,
    setScreenTitle: async () => received(),
    sourceMicrophones: async () => [], startScreen: async () => received(), startNativeScreen: async () => received(),
    voiceInput, listeningVolume, voiceActivity,
    roomTopology: async (roomId: string, publicationId?: string) => sampleRoomTopology(state, roomId, publicationId),
    connectionMetrics: async () => [],
    appConnectionMetrics: async () => { throw new Error("No native room in this preview"); },
    canUnmute: () => true,
    setMuted: async (roomId: string, muted: boolean) => setVoiceByRoom(previous => previous[roomId]
      ? { ...previous, [roomId]: { ...previous[roomId], muted } } : previous),
    setDeafened: async (roomId: string, deafened: boolean) => setVoiceByRoom(previous => previous[roomId]
      ? { ...previous, [roomId]: { ...previous[roomId], deafened } } : previous),
    leaveVoice: async (roomId: string) => setVoiceByRoom(previous => { const next = { ...previous }; delete next[roomId]; return next; }),
    joinVoice: async (roomId: string, listenOnly = false) => setVoiceByRoom(previous => ({
      ...previous, [roomId]: previous[roomId] ?? { muted: listenOnly, deafened: false },
    })),
    setInputVolume: (volume: number) => setVoiceInput(previous => ({ ...previous, volume })), setListeningVolume,
    microphones: async () => [{ id: "sample-microphone", label: zh ? "示例麦克风" : "Sample microphone" }],
    configureVoiceInput: async (next: Partial<typeof voiceInput>) => setVoiceInput(previous => ({ ...previous, ...next })),
    setRoomVoiceBitrate: async (roomId: string, voiceBitrate: number) => setSettingsByRoom(previous => ({ ...previous, [roomId]: { ...previous[roomId], voiceBitrate } })),
  } satisfies Partial<ChannelController> as unknown as ChannelController;
  return { channel, roomName, sampleMessages, messageReactions, settingsByRoom, notice, received, onSend, voiceLevel, setVoiceLevel };
}

/** Guide images use these production controls with local sample props. */
export function ChannelGuidePreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const { channel, roomName, notice, received, onSend } = useChannelGuideSample();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const state = channel.state!;
  return <section id="channel-guide-preview" className="cp-card">
    <header><h2>{zh ? "3.0 房间与分享" : "3.0 rooms and sharing"}</h2></header>
    <p>{zh ? "正式组件与示例房间，不连接服务、不采集设备。文件仅保留在本页，邀请链接为示例。" : "Production components with a sample room. No service or device capture. Files stay in this page; invitations are examples."}</p>
    <div className="c3-guide-room">
      <aside className="c3-guide-navigation" aria-label={zh ? "房间" : "Rooms"}>
        <ChannelRoomItem room={state.channel.rooms[0]} selected settingsOpen={settingsOpen}
          voice={state.voice.some(voice => voice.roomId === state.channel.rooms[0].id && voice.sessionId === channel.sessionId)}
          onSelect={() => {}} onManage={() => setSettingsOpen(true)} />
      </aside>
      <div className="c3-guide-main">
      <header className="c3-guide-heading"><div className="c3-guide-title"><ChannelIdentityMark icon="couch" /><strong>{roomName}</strong>
        <ChannelRoomInvitation channel={channel} room={state.channel.rooms[0]} />
        </div>
        <ChannelShareControl channel={channel} roomId="friday" disabled={false} /></header>
      <ChannelConversation domainId={state.channel.id} selfUserId={channel.self?.id} roomId="friday" roomName={roomName} messages={channel.messagesByRoom.friday} users={state.users} profiles={channel.profiles} queryProfiles={channel.queryProfiles}
        canSend sending={false} hidden={false} available attachments={channel.attachments} attachmentsAvailable
        history={{ hasMore: false, atLatest: true }} loadingHistory={false} onHistory={async () => {}} onLatest={async () => {}}
        interaction={channel.interactionsByRoom.get("friday") ?? null} onSend={onSend} />
      <ChannelVoiceDock channel={channel} selected="friday" onSelect={received} onBrowse={received} />
      </div>
    </div>
    {settingsOpen && <ChannelRoomSettingsDialog channel={channel} room={state.channel.rooms[0]} onClose={() => setSettingsOpen(false)} />}
    <p role="status">{notice}</p>
  </section>;
}
