import { useEffect, useRef, useState } from "react";
import { ChannelRoomPage } from "./ChannelPreviewPage";
import { useChannelGuideSample } from "./ChannelGuidePreview";
import { usePreviewInteractions } from "./use-preview-interactions";
import { Btn, Chip } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { screenVideoCeiling } from "../media/quality";
import type { ChannelController } from "../channel/types";
import "./channel-room-preview.css";

/** The production room view with local samples. No Session, device access or App discovery. */
export function ChannelRoomPreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const sample = useChannelGuideSample();
  const { session: interactions } = usePreviewInteractions(false, {
    self: { peerId: "sample-ada", displayName: "Ada" }, friend: { peerId: "sample-bo", displayName: "Bo" },
  });
  const [selected, setSelected] = useState("friday"), [count, setCount] = useState(0);
  const [streams, setStreams] = useState(new Map<string, MediaStream>());
  const [unwatched, setUnwatched] = useState(new Set<string>());
  const [stopped, setStopped] = useState(new Set<string>());
  const [mixed, setMixed] = useState(false);
  const canvases = useRef<HTMLCanvasElement[]>([]);
  useEffect(() => {
    const captures = ["#375c63", "#626348", "#5b4e68", "#795443"].map((color, index) => {
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540; canvases.current[index] = canvas;
      const context = canvas.getContext("2d")!;
      const paint = () => { context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#f4ecd8"; context.font = "32px sans-serif"; context.fillText(["A quiet evening", "Sketchbook", "A short film", "Drawing together"][index], 44, 64);
        context.fillStyle = "#8ebda5"; context.beginPath(); context.arc(670, 270, 130, 0, Math.PI * 2); context.fill(); };
      paint(); return { stream: canvas.captureStream(4), timer: setInterval(paint, 250) };
    });
    setStreams(new Map(captures.map((capture, index) => [`sample-screen-${index}`, capture.stream])));
    return () => { for (const capture of captures) { clearInterval(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); } };
  }, []);
  const publications = Array.from({ length: count }, (_, index) => ({ id: `sample-screen-${index}`, roomId: "friday",
    sessionId: `${["sample-bo", "sample-coco", "sample-ada", "sample-dora"][index]}-session`, userId: ["sample-bo", "sample-coco", "sample-ada", "sample-dora"][index],
    kind: "screen" as const, paused: false, videoCeiling: screenVideoCeiling(sample.channel.quality) })).filter(publication => !stopped.has(publication.id));
  const state = { ...sample.channel.state!, channel: { ...sample.channel.state!.channel,
    rooms: sample.channel.state!.channel.rooms.map(room => ({ ...room, participantSessionIds: [...new Set([
      ...room.participantSessionIds, ...publications.filter(publication => publication.roomId === room.id).map(publication => publication.sessionId),
    ])] })),
  }, publications: [...sample.channel.state!.publications, ...publications],
    users: [...sample.channel.state!.users, { id: "sample-coco", name: "Coco" }, { id: "sample-dora", name: "Dora" }],
    sessions: [...sample.channel.state!.sessions, ...["sample-coco", "sample-dora"].map(id => ({ id: `${id}-session`, userId: id, online: true, signingKey: Array(32).fill(0) }))],
    subscriptions: publications.filter(publication => !unwatched.has(publication.id)).map(publication => publication.id),
  };
  const channel = { ...sample.channel, state, streams, error: null, inviteURL: "https://friends.example/#invite=sample",
    interactionsByRoom: new Map(interactions ? [["friday", interactions]] : []),
    ownedScreens: new Set(publications.filter(publication => publication.userId === "sample-ada").map(publication => publication.id)),
    screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), voicePlaybackByUser: new Map(),
    browse: () => {}, sendMessage: sample.onSend, setMessageReaction: async () => sample.received(),
    loadHistory: async () => sample.received(), loadLatestHistory: async () => sample.received(),
    historyByRoom: { friday: { hasMore: false, atLatest: true } },
    screenQuality: () => ({ requested: sample.channel.quality, applied: sample.channel.quality }), screenCodecMode: () => sample.channel.videoCodecMode,
    sourceAudio: () => undefined, sourceMicrophone: () => undefined,
    setSourceAudio: async () => sample.received(),
    setScreenQuality: async (_id, profile) => sample.channel.setQuality(profile),
    watch: async id => setUnwatched(previous => { const next = new Set(previous); next.delete(id); return next; }),
    unwatch: async id => setUnwatched(previous => new Set(previous).add(id)), stopScreen: async id => { setStopped(previous => new Set(previous).add(id)); sample.received(); },
    startScreen: async () => { setStopped(new Set()); setCount(previous => Math.max(3, previous)); },
    startNativeScreen: async () => { setStopped(new Set()); setCount(previous => Math.max(3, previous)); },
    setScreenPaused: async () => sample.received(),
    inputPolicy: async () => sample.received(), inputDecide: async () => sample.received(), inputSimultaneous: async () => sample.received(),
    inputShortcut: async () => { throw new Error("No input device in this preview"); },
    screenPresentation: () => {}, reconnect: sample.received, clearError: sample.received,
    setVoiceMuted: () => sample.received(), setVoiceVolume: () => sample.received(),
    renameSelf: async () => sample.received(), resetDomainInvite: async () => sample.received(), updateDomain: async () => sample.received(),
    createRoom: async () => { sample.received(); return "friday"; }, enterRoom: async () => sample.received(), revokeRoomAccess: async () => sample.received(),
    restoreDomainBackup: async () => { sample.received(); throw new Error("preview_storage_unavailable"); },
    restoreRoomBackup: async () => { sample.received(); throw new Error("preview_storage_unavailable"); },
  } satisfies Partial<ChannelController> as unknown as ChannelController;
  return <div className="c3-room-preview">
    <ChannelRoomPage channel={channel} selected={selected} onSelect={setSelected}
      appControl={<div className="c3-room-preview-tools">
        <a className="lr-btn is-compact is-quiet" href="/__tooltip-preview#channel-guide-preview" aria-label={zh ? "返回控件目录" : "Back to UI catalogue"}><Glyph name="book" size={18} /></a>
        <Btn icon="window" title={{ text: zh ? "App（预览）" : "App (preview)" }} cap={{ text: "App" }} quiet size="compact" onClick={sample.received} />
        {[0, 1, 3, 4].map(value => <Chip key={value} title={zh ? `${value} 个画面` : `${value} screen${value === 1 ? "" : "s"}`} selected={count === value}
          onClick={() => { setCount(value); setStopped(new Set()); setUnwatched(new Set()); }}>{value}</Chip>)}
        <Chip title={zh ? "横竖混合" : "Mixed orientation"} selected={mixed} onClick={() => {
          const next = !mixed; setMixed(next);
          canvases.current.forEach((canvas, index) => { canvas.width = next && index % 2 === 0 ? 540 : 960; canvas.height = next && index % 2 === 0 ? 960 : 540; });
        }}>{zh ? "横竖" : "Mixed"}</Chip><span className="visually-hidden" role="status">{sample.notice}</span>
      </div>} />
  </div>;
}
