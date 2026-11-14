import { useEffect, useId, useRef, useState } from "react";
import { ChannelRoomPage } from "./ChannelPreviewPage";
import { sampleRoomTopology, useChannelGuideSample } from "./ChannelGuidePreview";
import { Btn, Chip } from "../components/living/primitives";
import { participantColor } from "../components/living/participant-color";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { screenVideoSettings } from "../media/quality";
import type { ChannelController } from "../channel/types";
import type { ChannelRoom, WatchActivity } from "../channel/protocol";
import { WatchPlayer } from "../channel/watch-playback";
import { useAnchoredPopover } from "../components/living/use-anchored-popover";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import type { AppDiscovery } from "../native/discovery";
import type { InterfaceLayout } from "../lib/room-preferences";
import "./channel-room-preview.css";

const screenCounts = [0, 1, 2, 3, 4, 8];
const previewAppDiscovery: AppDiscovery = {
  health: async () => null, connect: async () => null, isIncompatible: () => false,
};

/** The production room view with local samples. No Session, device access or App discovery. */
export function ChannelRoomPreview({ firstUse = false }: { firstUse?: boolean }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const sample = useChannelGuideSample(true);
  const invitedRoom = new URLSearchParams(location.search).get("invite-preview") === "studio" ? "studio" : null;
  const [layout, setLayout] = useState<InterfaceLayout>(new URLSearchParams(location.search).get("layout") === "quick" ? "quick" : "workspace");
  const [offerLayout, setOfferLayout] = useState(firstUse);
  const changeLayout = (value: InterfaceLayout) => { setLayout(value); setOfferLayout(false); };
  const [longNames, setLongNames] = useState(() => new URLSearchParams(location.search).has("long-names"));
  const [roomCount, setRoomCount] = useState(() => firstUse || new URLSearchParams(location.search).has("no-rooms") ? 0 : 2);
  const [emptyChat, setEmptyChat] = useState(() => new URLSearchParams(location.search).has("empty-chat"));
  const [fileSample, setFileSample] = useState(() => new URLSearchParams(location.search).has("file"));
  const [audienceSample, setAudienceSample] = useState(() => new URLSearchParams(location.search).has("audience"));
  const [createdRooms, setCreatedRooms] = useState<ChannelRoom[]>([]);
  const [sharingRoom, setSharingRoom] = useState<string | null>(null);
  const [watchMode, setWatchMode] = useState(new URLSearchParams(location.search).get("watch") ?? "off");
  const [watchActivity, setWatchActivity] = useState<WatchActivity | null>(() => watchMode === "off" ? null : ({
    id: "sample-watch", roomId: "friday", userId: watchMode === "owner" ? "sample-ada" : "sample-bo",
    sessionId: watchMode === "owner" ? "sample-ada-session" : "sample-bo-session", url: "https://media.example/evening.mp4?private=not-in-title",
    playback: { position: 0, paused: true, rate: 1, anchorTime: 0 },
  }));
  const [watchPlayers, setWatchPlayers] = useState(new Map<string, WatchPlayer>());
  const optionsId = useId(), optionsTrigger = useRef<HTMLSpanElement>(null), optionsPanel = useRef<HTMLDivElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useAnchoredPopover(optionsTrigger, optionsPanel);
  const users = sample.channel.state!.users.map((user, index) => ({ ...user, name: longNames && index < 2
    ? ["一起看电影的阿达和她的小伙伴们", "Benjamin watching with friends tonight"][index] : user.name }));
  const screenUsers = [users[1], users[2], users[0], ...users.slice(3)];
  const [selected, setSelected] = useState(() => invitedRoom === "studio" && roomCount > 1 ? invitedRoom : roomCount ? "friday" : ""), [count, setCount] = useState(() => {
    const value = Number(new URLSearchParams(location.search).get("screens"));
    return screenCounts.includes(value) ? value : 0;
  });
  const [streams, setStreams] = useState(new Map<string, MediaStream>());
  const [unwatched, setUnwatched] = useState(new Set<string>());
  const [stopped, setStopped] = useState(new Set<string>());
  const [mixed, setMixed] = useState(false);
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [sourceSounds, setSourceSounds] = useState<Partial<Record<string, { level: number; muted: boolean; bitrate?: number }>>>({});
  const canvases = useRef<HTMLCanvasElement[]>([]);
  const rooms = [...sample.channel.state!.channel.rooms.slice(0, roomCount),
    ...createdRooms.map(room => ({ ...room, ...sample.settingsByRoom[room.id] }))];
  const roomIds = new Set(rooms.map(room => room.id));
  const publications = (sharingRoom ? [{ audience: [], id: "sample-screen-2", roomId: sharingRoom,
    sessionId: sample.channel.sessionId!, userId: users[0].id, kind: "screen" as const, paused: false,
    source: { kind: "screen" as const, name: "A little place to stay" }, title: null,
    videoSettings: screenVideoSettings(sample.channel.quality) }] : Array.from({ length: count }, (_, index) => ({ audience: [], id: `sample-screen-${index}`, roomId: "friday",
    sessionId: `${screenUsers[index].id}-session`, userId: screenUsers[index].id,
    kind: "screen" as const, source: { kind: index === 1 ? "camera" as const : "screen" as const, name: longNames ? "A shared evening with friends and a very long source name" : ["A little place to stay", "Studio camera", "Drawing together"][index % 3] }, title: null, paused: false, videoSettings: screenVideoSettings(sample.channel.quality) })))
    .filter(publication => roomIds.has(publication.roomId) && !stopped.has(publication.id))
    .map(publication => ({ ...publication, title: titles[publication.id] ?? null, audience: audienceSample ? users.filter(user => user.id !== publication.userId).slice(0, 5)
      .map((user, index) => ({ sessionId: `${user.id}-session`, state: index < 3 ? "active" as const : index === 3 ? "preparing" as const : "failed" as const })) : [] }));
  const ownedScreens = new Set(publications.filter(publication => publication.userId === "sample-ada").map(publication => publication.id));
  const subscriptions = publications.filter(publication => !unwatched.has(publication.id)).map(publication => publication.id);
  const needsSamples = ownedScreens.size > 0 || subscriptions.length > 0 || !!watchActivity;
  // Keep the same samples while any player needs them.
  useEffect(() => {
    if (!needsSamples) { setStreams(new Map()); return; }
    const palette = getComputedStyle(document.documentElement);
    const audio = new AudioContext();
    const silentTrack = audio.createMediaStreamDestination().stream.getAudioTracks()[0];
    const captures = screenUsers.map((user, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = mixed && index % 2 === 0 ? 540 : 960; canvas.height = mixed && index % 2 === 0 ? 960 : 540;
      canvases.current[index] = canvas;
      const context = canvas.getContext("2d")!;
      const paint = () => { context.fillStyle = palette.getPropertyValue("--paper").trim(); context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = palette.getPropertyValue("--ink").trim(); context.font = "32px sans-serif"; context.fillText(user.name, 44, 64);
        context.fillStyle = participantColor(user.id); context.beginPath(); context.arc(canvas.width * .7, canvas.height / 2, Math.min(canvas.width, canvas.height) / 4, 0, Math.PI * 2); context.fill(); };
      paint();
      const stream = canvas.captureStream(4);
      stream.addTrack(silentTrack);
      return { stream, timer: setInterval(paint, 250) };
    });
    setStreams(new Map(captures.map((capture, index) => [`sample-screen-${index}`, capture.stream])));
    return () => {
      for (const capture of captures) { clearInterval(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); }
      void audio.close();
      canvases.current = [];
    };
  }, [needsSamples]);
  useEffect(() => {
    if (!watchActivity || watchMode === "available") { setWatchPlayers(new Map()); return; }
    const stream = streams.values().next().value;
    if (!stream) return;
    // The real player and controls consume a synthetic picture; no media URL is fetched.
    const player = new WatchPlayer(watchActivity.roomId, watchMode === "owner", "data:video/webm;base64,", () => {});
    player.video.removeAttribute("src"); player.video.srcObject = stream;
    player.blocked = watchMode === "blocked";
    if (!player.blocked) void player.video.play().catch(() => {});
    setWatchPlayers(new Map([[watchActivity.id, player]]));
    return () => player.close();
  }, [watchActivity?.id, watchMode, streams]);
  const state = { ...sample.channel.state!, channel: { ...sample.channel.state!.channel,
    rooms: rooms.map(room => ({ ...room,
      name: longNames && room.id === "friday" ? zh ? "周五一起看电影与交流的朋友们" : "Friday with friends: a shared evening together" : room.name,
      realtimeSessionIds: [...new Set([...room.realtimeSessionIds, ...publications.filter(publication => publication.roomId === room.id).flatMap(publication => [publication.sessionId, ...publication.audience.map(viewer => viewer.sessionId)])])],
      participantSessionIds: [...new Set([
      ...room.participantSessionIds, ...publications.filter(publication => publication.roomId === room.id).map(publication => publication.sessionId),
    ])] })),
  }, publications: [...sample.channel.state!.publications.filter(publication => roomIds.has(publication.roomId)), ...publications],
    voice: sample.channel.state!.voice.filter(voice => roomIds.has(voice.roomId)),
    users,
    subscriptions,
    watchActivities: watchActivity ? [watchActivity] : [],
    watchSubscriptions: watchActivity && watchMode !== "available" ? [watchActivity.id] : [],
  };
  let messagesByRoom = emptyChat ? { ...sample.channel.messagesByRoom,
    friday: sample.channel.messagesByRoom.friday.filter(message => message.seq > 2) } : sample.channel.messagesByRoom;
  if (fileSample && roomIds.has("friday")) {
    const messages = messagesByRoom.friday;
    messagesByRoom = { ...messagesByRoom, friday: [...messages, { id: "sample-file", seq: (messages.at(-1)?.seq ?? 0) + 1,
      userId: users[0].id, text: "", time: new Date(2020, 0, 1, 20, 3).getTime(),
      attachments: [{ id: "sample-document", name: longNames ? "AnnualPlanningNotes_".repeat(3) + "final.pdf" : "Notes.pdf",
        mediaType: "application/octet-stream", size: 12 * 1024 * 1024, sha256: "0".repeat(64) }] }] };
  }
  const profiles = new Map(users.map(user => [user.id, { ...sample.channel.profiles.get(user.id)!, ...user }]));
  const channel = { ...sample.channel, state, self: profiles.get(users[0].id)!, profiles, streams, error: null, siteURL: "https://friends.example/",
    watchPlayers,
    startWatch: async (roomId, url) => {
      setWatchMode("owner"); setWatchActivity({ id: `sample-watch-${crypto.randomUUID()}`, roomId, url,
        userId: "sample-ada", sessionId: "sample-ada-session", playback: { position: 0, paused: true, rate: 1, anchorTime: 0 } });
    },
    joinWatch: async () => setWatchMode("viewer"),
    leaveWatch: async () => setWatchMode("available"), stopWatch: async () => setWatchActivity(null),
    resumeWatch: async id => { const player = watchPlayers.get(id); if (player) { player.blocked = false; await player.play(); setWatchPlayers(new Map(watchPlayers)); } },
    setWatchPlayback: async (_id, patch) => {
      setWatchActivity(previous => previous && ({ ...previous, playback: { ...previous.playback, ...patch } }));
      const video = watchPlayers.values().next().value?.video;
      if (video) { if (patch.paused !== undefined) { if (patch.paused) video.pause(); else await video.play(); } if (patch.rate !== undefined) video.playbackRate = patch.rate; }
    },
    loadProfiles: async (ids: readonly string[]) => [...profiles.values()].filter(user => ids.includes(user.id)),
    queryProfiles: async ({ after, query }: { after?: string; query?: string }) => {
      const matches = [...profiles.values()].filter(user => !query || user.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.id.localeCompare(b.id));
      const rows = matches.filter(user => !after || user.id > after), page = rows.slice(0, 32);
      return { profiles: page, total: matches.length, nextCursor: rows.length > page.length ? page.at(-1)!.id : null };
    },
    messagesByRoom,
    interactionsByRoom: sample.channel.interactionsByRoom,
    ownedScreens, localScreens: ownedScreens,
    screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), voicePlaybackByUser: new Map(),
    browse: () => {}, sendMessage: sample.onSend,
    loadHistory: async () => sample.received(), loadLatestHistory: async () => sample.received(),
    historyByRoom: Object.fromEntries(state.channel.rooms.map(room => [room.id, { hasMore: false, atLatest: true }])),
    roomTopology: async (roomId, publicationId) => sampleRoomTopology(state, roomId, publicationId),
    screenQuality: () => ({ requested: sample.channel.quality, applied: sample.channel.quality }), screenCodecMode: () => sample.channel.videoCodecMode,
    sourceAudio: id => ownedScreens.has(id) ? { level: 1, muted: false, bitrate: sample.channel.quality.maxAudioBitrate ?? 128_000,
      ...sourceSounds[id], hasAudio: true, available: true, canMute: true } : undefined,
    sourceMicrophone: () => undefined,
    setSourceAudio: async (id, settings) => {
      setSourceSounds(previous => ({ ...previous, [id]: { level: 1, muted: false, ...previous[id], ...settings } }));
      sample.received();
    },
    setScreenQuality: async (_id, profile) => sample.channel.setQuality(profile),
    watch: async id => setUnwatched(previous => { const next = new Set(previous); next.delete(id); return next; }),
    unwatch: async id => setUnwatched(previous => new Set(previous).add(id)), stopScreen: async id => { setStopped(previous => new Set(previous).add(id)); setTitles(previous => { const next = { ...previous }; delete next[id]; return next; }); sample.received(); },
    startScreen: async roomId => { setStopped(new Set()); setTitles({}); setSharingRoom(roomId); },
    startNativeScreen: async roomId => { setStopped(new Set()); setTitles({}); setSharingRoom(roomId); },
    setScreenPaused: async () => sample.received(),
    setScreenTitle: async (id, title) => { if (ownedScreens.has(id)) setTitles(previous => ({ ...previous, [id]: title })); },
    inputPolicy: async () => sample.received(), inputDecide: async () => sample.received(), inputSimultaneous: async () => sample.received(),
    inputShortcut: async () => { throw new Error("No input device in this preview"); },
    screenPresentation: () => {}, reconnect: sample.received, clearError: sample.received,
    setVoiceMuted: () => sample.received(), setVoiceVolume: () => sample.received(),
    updateProfile: sample.channel.updateProfile, updateDomain: async () => sample.received(),
    createRoom: async settings => {
      const id = `sample-room-${crypto.randomUUID()}`;
      setCreatedRooms(previous => [...previous, { ...sample.channel.state!.channel.rooms[0], ...settings,
        id, name: settings.name, participantSessionIds: [sample.channel.sessionId!],
        delivery: { hostSessionId: sample.channel.sessionId!, bindingId: `sample-binding-${id}`, nextHops: {} } }]);
      setSelected(id);
      return id;
    }, enterRoom: async () => sample.received(), revokeRoomAccess: async () => sample.received(),
    restoreDomainBackup: async () => { sample.received(); throw new Error("preview_storage_unavailable"); },
    restoreRoomBackup: async () => { sample.received(); throw new Error("preview_storage_unavailable"); },
  } satisfies Partial<ChannelController> as unknown as ChannelController;
  return <div className="c3-room-preview">
    <ChannelRoomPage channel={channel} layout={layout} offerLayout={offerLayout} onLayoutChange={changeLayout} selected={selected} onSelect={setSelected}
      appControl={<><AppConnectionButton discovery={previewAppDiscovery} connected={false} />
        <span ref={optionsTrigger} className="c3-room-preview-trigger"><Btn icon="sliders" title={{ text: zh ? "预览选项" : "Preview options" }}
          quiet size="compact" hint="hint-advanced" expanded={optionsOpen} controls={optionsId} popoverTarget={optionsId} /></span></>} />
    <div ref={optionsPanel} id={optionsId} popover="auto" role="dialog" aria-label={zh ? "预览选项" : "Preview options"}
          className="lr-anchored-card c3-room-preview-options" onToggle={event => {
            if (event.target === event.currentTarget) setOptionsOpen(event.newState === "open");
          }}>
          <header><h2>{zh ? "预览选项" : "Preview options"}</h2><Btn icon="x" title="common.close" hint="hint-close" quiet size="compact"
            onClick={() => optionsPanel.current?.hidePopover()} /></header>
          <p>{zh ? "画面为本地合成样本，没有实际网络连接。" : "Pictures are local synthetic samples, without network connections."}</p>
          <fieldset><legend>{zh ? "界面入口" : "Interface entry"}</legend><div className="c3-room-preview-tools">
            <Btn icon="sidebar" quiet size="compact" cap={{ text: zh ? "首次使用提示" : "First-use suggestion" }}
              title={{ text: zh ? "首次使用提示" : "First-use suggestion" }} onClick={() => { optionsPanel.current?.hidePopover(); setRoomCount(0); setCreatedRooms([]); setCount(0); setSharingRoom(null); setSelected(""); setLayout("workspace"); setOfferLayout(true); }} />
            {rooms.some(room => room.id === "studio") && <Btn icon="link" quiet size="compact" cap={{ text: zh ? "模拟邀请到创作小屋" : "Preview studio invitation" }}
              title={{ text: zh ? "模拟邀请到创作小屋" : "Preview studio invitation" }} onClick={() => { optionsPanel.current?.hidePopover(); setSelected("studio"); }} />}
          </div></fieldset>
          <fieldset><legend>{zh ? "画面数量" : "Screens"}</legend><div className="c3-room-preview-tools">
            {screenCounts.map(value => <Chip key={value} title={zh ? `${value} 个画面` : `${value} screen${value === 1 ? "" : "s"}`} selected={count === value}
              onClick={() => { setCount(value); setSharingRoom(null); setStopped(new Set()); setUnwatched(new Set()); }}>{value}</Chip>)}
          </div></fieldset>
          <fieldset><legend>{zh ? "同步观看" : "Watch together"}</legend><div className="c3-room-preview-tools">
            {["off", "owner", "viewer", "available", "blocked"].map((mode, index) => <Chip key={mode}
              title={zh ? ["关闭", "分享者", "观看者", "尚未加入", "等待手动播放"][index] : ["Off", "Sharer", "Viewer", "Available", "Playback blocked"][index]}
              selected={watchMode === mode} onClick={() => {
                setWatchMode(mode); setWatchActivity(mode === "off" ? null : { id: "sample-watch", roomId: "friday",
                  userId: mode === "owner" ? "sample-ada" : "sample-bo", sessionId: mode === "owner" ? "sample-ada-session" : "sample-bo-session",
                  url: "https://media.example/evening.mp4?private=not-in-title", playback: { position: 0, paused: true, rate: 1, anchorTime: 0 } });
              }}>{zh ? ["关闭", "分享者", "观看者", "尚未加入", "等待手动播放"][index] : ["Off", "Sharer", "Viewer", "Available", "Playback blocked"][index]}</Chip>)}
          </div></fieldset>
          <div className="c3-room-preview-tools">
            <Chip title={zh ? "横竖混合" : "Mixed orientation"} selected={mixed} onClick={() => {
              const next = !mixed; setMixed(next);
              canvases.current.forEach((canvas, index) => { canvas.width = next && index % 2 === 0 ? 540 : 960; canvas.height = next && index % 2 === 0 ? 960 : 540; });
            }}>{zh ? "横竖混合" : "Mixed orientation"}</Chip>
            <Chip title={zh ? "长名字" : "Long names"} selected={longNames} onClick={() => setLongNames(!longNames)}>{zh ? "长名字" : "Long names"}</Chip>
            <Chip title={zh ? "没有房间" : "No rooms"} selected={!rooms.length} onClick={() => { setRoomCount(rooms.length ? 0 : 2); setSelected(rooms.length ? "" : "friday"); setCreatedRooms([]); setCount(0); setSharingRoom(null); }}>{zh ? "没有房间" : "No rooms"}</Chip>
            <Chip title={zh ? "空聊天" : "Empty chat"} selected={emptyChat} onClick={() => setEmptyChat(!emptyChat)}>{zh ? "空聊天" : "Empty chat"}</Chip>
            <Chip title={zh ? "附件样本" : "File sample"} selected={fileSample} onClick={() => setFileSample(!fileSample)}>{zh ? "附件样本" : "File sample"}</Chip>
            <Chip title={zh ? "观看者样本" : "Viewer sample"} selected={audienceSample} onClick={() => setAudienceSample(!audienceSample)}>{zh ? "观看者样本" : "Viewer sample"}</Chip>
          </div>
          <fieldset><legend>{zh ? "合成语音电平（不采集设备）" : "Synthetic voice level (no device capture)"}</legend><div className="c3-room-preview-tools">
            {([undefined, .05, .2] as const).map((level, index) => <Chip key={index}
              title={zh ? ["无采样", "低电平", "高电平"][index] : ["No sample", "Low level", "High level"][index]}
              selected={sample.voiceLevel === level} onClick={() => sample.setVoiceLevel(level)}>
              {zh ? ["无采样", "低", "高"][index] : ["No sample", "Low", "High"][index]}
            </Chip>)}
          </div></fieldset>
          <a className="lr-btn is-compact is-quiet" href="/__tooltip-preview#channel-guide-preview"><Glyph name="book" size={18} />{zh ? "返回控件目录" : "Back to UI catalogue"}</a>
    </div><span className="visually-hidden" role="status">{sample.notice}</span>
  </div>;
}
