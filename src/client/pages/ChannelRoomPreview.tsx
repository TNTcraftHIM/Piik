import { useEffect, useId, useRef, useState } from "react";
import { ChannelRoomPage } from "./ChannelPreviewPage";
import { sampleRoomTopology, useChannelGuideSample } from "./ChannelGuidePreview";
import { Btn, Chip } from "../components/living/primitives";
import { participantColor } from "../components/living/participant-color";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { screenVideoSettings } from "../media/quality";
import type { ChannelController } from "../channel/types";
import type { ChannelRoom } from "../channel/protocol";
import { useAnchoredPopover } from "../components/living/use-anchored-popover";
import "./channel-room-preview.css";

const screenCounts = [0, 1, 2, 3, 4, 8];
const fileStatus = { busy: false, error: null };
const fileStore = { subscribe: () => () => {}, status: () => fileStatus };

/** The production room view with local samples. No Session, device access or App discovery. */
export function ChannelRoomPreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const sample = useChannelGuideSample(true);
  const [longNames, setLongNames] = useState(() => new URLSearchParams(location.search).has("long-names"));
  const [roomCount, setRoomCount] = useState(() => new URLSearchParams(location.search).has("no-rooms") ? 0 : 2);
  const [emptyChat, setEmptyChat] = useState(() => new URLSearchParams(location.search).has("empty-chat"));
  const [fileSample, setFileSample] = useState(() => new URLSearchParams(location.search).has("file"));
  const [audienceSample, setAudienceSample] = useState(() => new URLSearchParams(location.search).has("audience"));
  const [createdRooms, setCreatedRooms] = useState<ChannelRoom[]>([]);
  const [sharingRoom, setSharingRoom] = useState<string | null>(null);
  const optionsId = useId(), optionsTrigger = useRef<HTMLSpanElement>(null), optionsPanel = useRef<HTMLDivElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useAnchoredPopover(optionsTrigger, optionsPanel);
  const users = sample.channel.state!.users.map((user, index) => ({ ...user, name: longNames && index < 2
    ? ["一起看电影的阿达和她的小伙伴们", "Benjamin watching with friends tonight"][index] : user.name }));
  const screenUsers = [users[1], users[2], users[0], ...users.slice(3)];
  const [selected, setSelected] = useState(() => roomCount ? "friday" : ""), [count, setCount] = useState(() => {
    const value = Number(new URLSearchParams(location.search).get("screens"));
    return screenCounts.includes(value) ? value : 0;
  });
  const [streams, setStreams] = useState(new Map<string, MediaStream>());
  const [unwatched, setUnwatched] = useState(new Set<string>());
  const [stopped, setStopped] = useState(new Set<string>());
  const [mixed, setMixed] = useState(false);
  const canvases = useRef<HTMLCanvasElement[]>([]);
  const rooms = [...sample.channel.state!.channel.rooms.slice(0, roomCount),
    ...createdRooms.map(room => ({ ...room, ...sample.settingsByRoom[room.id] }))];
  const roomIds = new Set(rooms.map(room => room.id));
  const publications = (sharingRoom ? [{ audience: [], id: "sample-screen-2", roomId: sharingRoom,
    sessionId: sample.channel.sessionId!, userId: users[0].id, kind: "screen" as const, paused: false,
    videoSettings: screenVideoSettings(sample.channel.quality) }] : Array.from({ length: count }, (_, index) => ({ audience: [], id: `sample-screen-${index}`, roomId: "friday",
    sessionId: `${screenUsers[index].id}-session`, userId: screenUsers[index].id,
    kind: "screen" as const, paused: false, videoSettings: screenVideoSettings(sample.channel.quality) })))
    .filter(publication => roomIds.has(publication.roomId) && !stopped.has(publication.id))
    .map(publication => ({ ...publication, audience: audienceSample ? users.filter(user => user.id !== publication.userId).slice(0, 5)
      .map((user, index) => ({ sessionId: `${user.id}-session`, state: index < 3 ? "active" as const : index === 3 ? "preparing" as const : "failed" as const })) : [] }));
  const ownedScreens = new Set(publications.filter(publication => publication.userId === "sample-ada").map(publication => publication.id));
  const subscriptions = publications.filter(publication => !unwatched.has(publication.id)).map(publication => publication.id);
  const needsSamples = ownedScreens.size > 0 || subscriptions.length > 0;
  // Keep the same samples while any player needs them.
  useEffect(() => {
    if (!needsSamples) { setStreams(new Map()); return; }
    const palette = getComputedStyle(document.documentElement);
    const captures = screenUsers.map((user, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = mixed && index % 2 === 0 ? 540 : 960; canvas.height = mixed && index % 2 === 0 ? 960 : 540;
      canvases.current[index] = canvas;
      const context = canvas.getContext("2d")!;
      const paint = () => { context.fillStyle = palette.getPropertyValue("--paper").trim(); context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = palette.getPropertyValue("--ink").trim(); context.font = "32px sans-serif"; context.fillText(user.name, 44, 64);
        context.fillStyle = participantColor(user.id); context.beginPath(); context.arc(canvas.width * .7, canvas.height / 2, Math.min(canvas.width, canvas.height) / 4, 0, Math.PI * 2); context.fill(); };
      paint(); return { stream: canvas.captureStream(4), timer: setInterval(paint, 250) };
    });
    setStreams(new Map(captures.map((capture, index) => [`sample-screen-${index}`, capture.stream])));
    return () => {
      for (const capture of captures) { clearInterval(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); }
      canvases.current = [];
    };
  }, [needsSamples]);
  const state = { ...sample.channel.state!, channel: { ...sample.channel.state!.channel,
    rooms: rooms.map(room => ({ ...room,
      name: longNames && room.id === "friday" ? zh ? "周五一起看电影与交流的朋友们" : "Friday with friends: a shared evening together" : room.name,
      participantSessionIds: [...new Set([
      ...room.participantSessionIds, ...publications.filter(publication => publication.roomId === room.id).map(publication => publication.sessionId),
    ])] })),
  }, publications: [...sample.channel.state!.publications.filter(publication => roomIds.has(publication.roomId)), ...publications],
    voice: sample.channel.state!.voice.filter(voice => roomIds.has(voice.roomId)),
    users,
    subscriptions,
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
  const channel = { ...sample.channel, state, self: state.users[0], streams, error: null, siteURL: "https://friends.example/",
    messagesByRoom,
    attachments: { ...fileStore, download: async () => sample.received(), cancelDownload: sample.received } as unknown as ChannelController["attachments"],
    interactionsByRoom: sample.channel.interactionsByRoom,
    ownedScreens,
    screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), voicePlaybackByUser: new Map(),
    browse: () => {}, sendMessage: sample.onSend,
    loadHistory: async () => sample.received(), loadLatestHistory: async () => sample.received(),
    historyByRoom: Object.fromEntries(state.channel.rooms.map(room => [room.id, { hasMore: false, atLatest: true }])),
    roomTopology: async (roomId, publicationId) => sampleRoomTopology(state, roomId, publicationId),
    screenQuality: () => ({ requested: sample.channel.quality, applied: sample.channel.quality }), screenCodecMode: () => sample.channel.videoCodecMode,
    sourceAudio: () => undefined, sourceMicrophone: () => undefined,
    setSourceAudio: async () => sample.received(),
    setScreenQuality: async (_id, profile) => sample.channel.setQuality(profile),
    watch: async id => setUnwatched(previous => { const next = new Set(previous); next.delete(id); return next; }),
    unwatch: async id => setUnwatched(previous => new Set(previous).add(id)), stopScreen: async id => { setStopped(previous => new Set(previous).add(id)); sample.received(); },
    startScreen: async roomId => { setStopped(new Set()); setSharingRoom(roomId); },
    startNativeScreen: async roomId => { setStopped(new Set()); setSharingRoom(roomId); },
    setScreenPaused: async () => sample.received(),
    inputPolicy: async () => sample.received(), inputDecide: async () => sample.received(), inputSimultaneous: async () => sample.received(),
    inputShortcut: async () => { throw new Error("No input device in this preview"); },
    screenPresentation: () => {}, reconnect: sample.received, clearError: sample.received,
    setVoiceMuted: () => sample.received(), setVoiceVolume: () => sample.received(),
    renameSelf: async () => sample.received(), updateDomain: async () => sample.received(),
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
    <ChannelRoomPage channel={channel} selected={selected} onSelect={setSelected}
      appControl={<span ref={optionsTrigger} className="c3-room-preview-trigger"><Btn icon="sliders" title={{ text: zh ? "预览选项" : "Preview options" }}
          cap={{ text: zh ? "预览选项" : "Preview options" }} quiet size="compact" hint="hint-advanced"
          expanded={optionsOpen} controls={optionsId} popoverTarget={optionsId} /></span>} />
    <div ref={optionsPanel} id={optionsId} popover="auto" role="dialog" aria-label={zh ? "预览选项" : "Preview options"}
          className="lr-anchored-card c3-room-preview-options" onToggle={event => {
            if (event.target === event.currentTarget) setOptionsOpen(event.newState === "open");
          }}>
          <header><h2>{zh ? "预览选项" : "Preview options"}</h2><Btn icon="x" title="common.close" hint="hint-close" quiet size="compact"
            onClick={() => optionsPanel.current?.hidePopover()} /></header>
          <p>{zh ? "画面为本地合成样本，没有实际网络连接。" : "Pictures are local synthetic samples, without network connections."}</p>
          <fieldset><legend>{zh ? "画面数量" : "Screens"}</legend><div className="c3-room-preview-tools">
            {screenCounts.map(value => <Chip key={value} title={zh ? `${value} 个画面` : `${value} screen${value === 1 ? "" : "s"}`} selected={count === value}
              onClick={() => { setCount(value); setSharingRoom(null); setStopped(new Set()); setUnwatched(new Set()); }}>{value}</Chip>)}
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
