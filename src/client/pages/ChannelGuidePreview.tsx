import sampleThumbnail from "../../../public/favicon.png?url&inline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { ChannelConversation } from "../channel/components/ChannelConversation";
import { ChannelIdentityMark } from "../channel/components/ChannelIdentity";
import { ChannelRoomSettingsDialog } from "../channel/components/ChannelRoomControls";
import { ChannelRoomItem } from "../channel/components/ChannelRoomItem";
import { ChannelRoomInvitation } from "../channel/components/ChannelRoomInvitation";
import { ChannelShareControl, WatchSourceDialog } from "../channel/components/ChannelShareControl";
import { ChannelVoiceDock } from "../channel/components/ChannelVoiceDock";
import { snapshotSchema, type ChannelMessage, type ChannelSnapshot, type ChannelTopology, type DomainSettings, type RoomSettings } from "../channel/protocol";
import { messageRemoved, type ChannelController } from "../channel/types";
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
const sampleAttachment = {
  id: "sample-thumbnail", size: 11076, mediaType: "image/png" as const,
  sha256: "525b0ef5296cb8e7ecdc0bc8c07e85e7e8dabd2daff3453baf9394548acd01e2",
};
const sampleAttachmentSeq = 3;

class GuideAttachments extends ChannelAttachments {
  override originalAvailability(...args: Parameters<ChannelAttachments["originalAvailability"]>) {
    const [key] = args;
    if (key.roomId === "friday" && key.messageSeq === sampleAttachmentSeq && key.attachmentId === sampleAttachment.id) return false;
    return super.originalAvailability(...args);
  }
}

const pending = new Set<string>();
const roomBackupAvailable = async () => false;
const appSessionId = "sample-ada-app-session";
const sources: NativeCaptureSources = { ...SOURCES, codecs: ["h264", "vp8"], softwareEncodingCodecs: ["h264", "vp8"], videoAdaptation: true,
  sources: SOURCES.sources.filter(source => source.kind === "display" || source.sourceId === "101" || source.sourceId === "102") };

/** Local samples have identities, but no measured or simulated network paths. */
export function sampleRoomTopology(state: ChannelSnapshot, roomId: string, publicationId?: string): ChannelTopology {
  const room = state.channel.rooms.find(room => room.id === roomId)!;
  const delivery = room.delivery!;
  const screen = state.publications.find(value => value.roomId === roomId && value.id === publicationId && value.kind === "screen");
  const sessionIds = [...new Set([delivery.hostSessionId, ...room.participantSessionIds])].sort();
  return { serviceAvailable: room.serviceRelay?.available ?? false, serviceEnabled: room.serviceRelay?.enabled ?? false,
    bindingId: delivery.bindingId, transitSession: null, sessionIds, pairs: [],
    screen: screen ? { publicationId: screen.id, sourceSessionId: screen.sessionId, edges: [] } : null };
}

/** Guide and room previews share local sample props, never a Session or backend. */
export function useChannelGuideSample({ multiRoom = false, multiVoice = false, showSampleAttachment = false } = {}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const [site, setSite] = useState({ name: "Friends", icon: "couch" });
  const [settingsByRoom, setSettingsByRoom] = useState<Record<string, Partial<RoomSettings>>>({});
  const [forwardingLimit, setForwardingLimit] = useState(-1);
  const [appRelayLimit, setAppRelayLimit] = useState<number | null>(null);
  const appRelayCapacity = useCallback<ChannelController["appRelayCapacity"]>(async signal => {
    signal?.throwIfAborted();
    return { sessionId: appSessionId, relayOverride: appRelayLimit };
  }, [appRelayLimit]);
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
    ...(multiRoom && multiVoice ? { studio: { muted: true, deafened: false } } : {}),
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
  const [historyChangesByRoom, setHistoryChangesByRoom] = useState<ChannelController["historyChangesByRoom"]>({});
  // No session or FileStore is attached: these confirmed sample bytes stay in this page.
  const [attachments] = useState(() => new GuideAttachments(async () => {}, async () => {}));
  const nextMessage = useRef(showSampleAttachment ? sampleAttachmentSeq + 1 : 3);
  useEffect(() => () => attachments.reset(), [attachments]);
  const onSend: ChannelController["sendMessage"] = async (roomId, text, files = [], signal, options = {}, preparation) => {
    const preparationSignal = preparation && signal ? AbortSignal.any([preparation.signal, signal]) : preparation?.signal ?? signal;
    const prepared = files.length ? await attachments.describe(files, preparationSignal, preparation?.progress) : [];
    preparationSignal?.throwIfAborted();
    preparation?.progress(null);
    const seq = nextMessage.current++;
    const target = options.reply && [...(messagesByRoom[roomId] ?? []), ...sampleMessages].find(message => message.seq === options.reply?.seq && message.id === options.reply.messageId);
    if (options.reply && !target) throw new Error("message_unavailable");
    const message: ChannelMessage = { id: `sample-${roomId}-${seq}`, seq, userId: "sample-ada", text, mentions: options.mentions,
      ...(target && options.reply ? { reply: { seq: target.seq, userId: target.userId, text: target.text.slice(0, 160), notify: options.reply.notify } } : {}),
      time: new Date(2020, 0, 1, 20, seq).getTime(), attachments: prepared.map(file => file.attachment),
      inlineImages: Object.fromEntries(prepared.flatMap(file => file.inlineImage ? [[file.id, file.inlineImage]] : [])) };
    attachments.confirmed(roomId, message, prepared);
    setMessagesByRoom(previous => ({ ...previous, [roomId]: [...(previous[roomId] ?? []), message] }));
  };
  const [messageReactions, setMessageReactions] = useState<Record<string, import("../channel/protocol").MessageReactions>>({});
  const [publicationReactions, setPublicationReactions] = useState(new Map<string, import("../channel/protocol").PublicationReactionSnapshot>());
  const { session: interaction } = usePreviewInteractions(false, { self: { peerId: "sample-ada", displayName: "Ada" }, friend: { peerId: "sample-bo", displayName: "Bo" } }, (reaction, target) => {
    if ("messageSeq" in target) setMessageReactions(previous => ({ ...previous, [target.messageId]: {
      revision: (previous[target.messageId]?.revision ?? 0) + 1,
      counts: { ...previous[target.messageId]?.counts, [reaction]: (previous[target.messageId]?.counts[reaction] ?? 0) + 1 },
    } }));
    else setPublicationReactions(previous => new Map(previous).set(target.publicationId, {
      publicationId: target.publicationId, revision: (previous.get(target.publicationId)?.revision ?? 0) + 1,
      counts: { ...previous.get(target.publicationId)?.counts, [reaction]: (previous.get(target.publicationId)?.counts[reaction] ?? 0) + 1 },
    }));
  });
  const sampleMessages = visibleMessages("friday", [
    { id: "hello", seq: 1, userId: "sample-ada", text: zh ? "晚上好！先在这里聊聊。" : "Hi! We can chat here first.", time: new Date(2020, 0, 1, 20, 0).getTime(), attachments: [] },
    { id: "ready", seq: 2, userId: "sample-bo", text: zh ? "我也加入语音了，随时可以开始。" : "I've joined voice too. Ready when you are.", time: new Date(2020, 0, 1, 20, 1).getTime(), attachments: [] },
    ...(showSampleAttachment ? [{
      id: "sample-image", seq: sampleAttachmentSeq, userId: "sample-bo", text: "",
      time: new Date(2020, 0, 1, 20, 2).getTime(),
      attachments: [{ ...sampleAttachment, name: zh ? "皮克图标.png" : "Piik icon.png" }],
      inlineImages: { [sampleAttachment.id]: { data: sampleThumbnail.split(",")[1], mediaType: "image/png" as const, original: false, width: 96, height: 96 } },
    }] : []),
    ...(messagesByRoom.friday ?? []),
  ]);
  function visibleMessages(roomId: string, messages: ChannelMessage[]): ChannelMessage[] {
    const changes = historyChangesByRoom[roomId];
    if (!changes) return messages;
    return messages.filter(message => !messageRemoved(changes, message.seq))
      .map(message => message.reply && messageRemoved(changes, message.reply.seq) ? { ...message, reply: undefined } : message);
  }
  const users = (multiRoom ? ["Ada", "Bo", "Coco", "Dora", "Eli", "Finn", "Gia", "Hana", "Iris"] : ["Ada", "Bo"])
    .map(name => ({ id: `sample-${name.toLowerCase()}`, name, avatar: null, ...(name === "Ada" ? profile : {}), version: "0".repeat(64) }));
  const rooms = [{ id: "friday", name: roomName, icon: "couch" },
    ...(multiRoom ? [{ id: "studio", name: zh ? "创作小屋" : "Creative studio", icon: "star" }] : [])]
    .map(room => ({ creatorId: "sample-ada", access: "private" as const, hidden: false, hasPassword: false,
      authorized: true, canManage: true, available: true, reading: true, lastMessageSeq: room.id === "friday" ? sampleMessages.at(-1)?.seq ?? 0 : messagesByRoom[room.id]?.at(-1)?.seq ?? 0,
      delivery: { hostSessionId: appSessionId, bindingId: `sample-binding-${room.id}` },
      serviceRelay: { enabled: settingsByRoom[room.id]?.allowServiceRelay ?? false, available: false },
      fileActivity: [],
      participantSessionIds: room.id === "studio" ? ["sample-coco-session", ...(voiceByRoom.studio ? ["sample-ada-session"] : [])]
        : ["sample-ada-session", "sample-bo-session", ...(multiRoom ? ["sample-dora-session"] : [])], capabilities: { attachments: true },
      ...room, ...settingsByRoom[room.id], picture: settingsByRoom[room.id]?.picture ?? undefined }));
  const state = snapshotSchema.parse({ channel: { id: "sample", ...site, ownerId: "sample-ada", roomCreationPolicy: "ordinary", hostingMode: "lightweight", historyWindow: 1000, userCount: users.length,
    rooms, managedRoomIds: rooms.map(room => room.id) }, users: users.map(({ avatar: _avatar, ...user }) => user),
    sessions: [...users.map(user => ({ id: `${user.id}-session`, userId: user.id, online: user.id !== "sample-iris", signingKey: Array(32).fill(0) })),
      { id: appSessionId, userId: "sample-ada", online: true, signingKey: Array(32).fill(0) }],
    publications: Object.keys(voiceByRoom).map(roomId => ({ audience: [], id: `voice-${roomId}`, kind: "voice", roomId,
      sessionId: "sample-ada-session", userId: "sample-ada", paused: false })),
    voice: [...Object.entries(voiceByRoom).map(([roomId, voice]) => ({ sessionId: "sample-ada-session", roomId, ...voice })),
      { sessionId: "sample-bo-session", roomId: "friday", muted: false, deafened: false }],
    subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  } satisfies z.input<typeof snapshotSchema>);
  const channel = {
    inspectRoomCopy: async (file: Blob) => {
      const metadata = await readBackup(file);
      if (metadata.kind !== "room_copy") throw new Error("expected_room_copy");
      return { settings: metadata.roomInfo ?? {}, retainedFileCount: metadata.retainedFiles.length };
    },
    exportRoomCopy: async () => { received(); throw new Error("preview_only"); },
    clearLocalRoomCache: async () => received(),
    importRoomCopy: async () => { received(); throw new Error("preview_only"); },
    setConversationPopout: () => {},
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
    updateDomain: async (changes: Partial<DomainSettings>) => setSite(previous => ({
      name: changes.name ?? previous.name, icon: changes.icon ?? previous.icon,
    })),
    updateProfile: async (value: { name?: string; avatar?: string | null }) => setProfile(previous => ({
      name: value.name ?? previous.name, avatar: value.avatar === undefined ? previous.avatar : value.avatar,
    })),
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
    messagesByRoom: { ...Object.fromEntries(Object.entries(messagesByRoom).map(([roomId, messages]) => [roomId, visibleMessages(roomId, messages)])),
      friday: sampleMessages.map(message => ({ ...message, reactions: messageReactions[message.id] })) },
    historyChangesByRoom,
    deleteMessage: async (roomId, seq, messageId) => {
      const messages = roomId === "friday" ? sampleMessages : messagesByRoom[roomId] ?? [];
      if (!visibleMessages(roomId, messages).some(message => message.seq === seq && message.id === messageId)) throw new Error("message_unavailable");
      setHistoryChangesByRoom(previous => ({ ...previous, [roomId]: { clearedThrough: previous[roomId]?.clearedThrough ?? 0,
        deleted: new Set([...(previous[roomId]?.deleted ?? []), seq]) } }));
    },
    purgeRoomHistory: async roomId => {
      setHistoryChangesByRoom(previous => ({ ...previous, [roomId]: { clearedThrough: nextMessage.current - 1, deleted: new Set() } }));
    },
    interactionsByRoom: new Map(interaction ? [["friday", interaction]] : []), publicationReactions, roomBackupAvailable,
    getRoomInvite: async (roomId: string) => ({ state: "available" as const, url: invites[roomId] ?? `https://friends.example/#room=${roomId}&invite=sample` }),
    createRoomInvite: async (roomId: string) => {
      const next = `${invites[roomId] ?? `https://friends.example/#room=${roomId}&invite=sample`}-new`;
      setInvites(previous => ({ ...previous, [roomId]: next })); received(); return next;
    },
    updateRoom: async (roomId: string, next: Partial<RoomSettings>) => { setSettingsByRoom(previous => ({ ...previous, [roomId]: { ...previous[roomId], ...next } })); received(); },
    deleteRoom: async () => { received(); return { dataRemoved: false }; },
    forwardingLimit, setForwardingLimit, appRelayCapacity,
    setAppRelayOverride: async (previous, capacity) => {
      setAppRelayLimit(capacity);
      return { ...previous, relayOverride: capacity };
    },
    nativeCaptureRequest: () => undefined, nativeCaptureSelection: () => undefined,
    sourceSelectionCommitting: () => false,
    browserCapturePreparation: () => undefined,
    pagePlayer: false, externalScreenInputAvailable: false, watchPage: () => undefined, watchEmbed: () => undefined,
    startWatch: async () => received(),
    prepareWatchEmbed: async () => { throw new Error("watch_media_unsupported"); },
    confirmWatchEmbed: async () => { throw new Error("watch_source_unavailable"); },
    externalInput: () => undefined, startExternalScreen: async () => received(),
    nativeSources: async () => sources, nativePreview: previewSource, cameraPreviews: previewCameras,
    setScreenTitle: async () => received(),
    sourceMicrophones: async () => [], startScreen: async () => received(), startNativeScreen: async () => received(),
    voiceInput, listeningVolume, voiceActivity,
    roomTopology: async (roomId: string, publicationId?: string) => sampleRoomTopology(state, roomId, publicationId),
    connectionMetrics: async () => ({ samples: [], unavailable: false }),
    appConnectionMetrics: async roomId => ({ sessionId: appSessionId, bindingId: `sample-binding-${roomId}`, connections: [] }),
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
  const { channel, roomName, notice, received, onSend } = useChannelGuideSample({ showSampleAttachment: true });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchPage, setWatchPage] = useState<ReturnType<ChannelController["watchPage"]>>();
  const watchChannel: ChannelController = {
    ...channel, pagePlayer: true, watchPage: () => watchPage,
    prepareWatchPage: async (_roomId, url) => setWatchPage({ url, candidates: [
      { id: "10000000-0000-4000-8000-000000000001", title: zh ? "山径漫步完整版" : "Mountain trail walk — full film",
        url: "https://media.example/films/mountain-trail.mp4", duration: 1480 },
      { id: "10000000-0000-4000-8000-000000000002", title: zh ? "幕后花絮" : "Behind the scenes",
        url: null, duration: 206 },
    ] }),
    selectWatchPage: async (_roomId, candidateId, _activityId, _reportError, mode) => {
      const candidate = watchPage?.candidates.find(item => item.id === candidateId);
      if (!watchPage || !candidate) throw new Error("watch_page_unavailable");
      if (mode === "original-page" || (candidate.url && mode !== "choose-source")) { received(); return true; }
      setWatchPage({ ...watchPage, watchSources: { choices: [
        { id: "20000000-0000-4000-8000-000000000001", name: candidate.title, format: "file",
          displayURL: candidate.url ?? "https://media.example/films/behind-the-scenes.mp4" },
        { id: "20000000-0000-4000-8000-000000000002", name: zh ? "自适应高清播放列表" : "Adaptive HD playback",
          format: "hls", displayURL: "https://media.example/films/adaptive-hd/master.m3u8" },
      ], indexed: [], mpd: [] } });
      return false;
    },
    selectWatchBrowserSource: async () => received(),
    selectWatchForwardSource: async () => received(),
    focusWatchPage: async () => received(),
    cancelScreenSelection: async () => setWatchPage(undefined),
  };
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
        <ChannelShareControl channel={channel} roomId="friday" disabled={false} onWatch={() => setWatchOpen(true)} /></header>
      <ChannelConversation domainId={state.channel.id} selfUserId={channel.self?.id} roomId="friday" roomName={roomName} messages={channel.messagesByRoom.friday} users={state.users} profiles={channel.profiles} queryProfiles={channel.queryProfiles}
        canSend sending={false} hidden={false} available attachments={channel.attachments} attachmentsAvailable
        history={{ hasMore: false, atLatest: true }} loadingHistory={false} onHistory={async () => {}} onLatest={async () => {}}
        interaction={channel.interactionsByRoom.get("friday") ?? null} onSend={onSend} />
      <ChannelVoiceDock channel={channel} selected="friday" onSelect={received} onBrowse={received} />
      </div>
    </div>
    {settingsOpen && <ChannelRoomSettingsDialog channel={channel} room={state.channel.rooms[0]} onClose={() => setSettingsOpen(false)} />}
    {watchOpen && <WatchSourceDialog channel={watchChannel} roomId="friday" onClose={() => { setWatchPage(undefined); setWatchOpen(false); }} />}
    <p role="status">{notice}</p>
  </section>;
}
