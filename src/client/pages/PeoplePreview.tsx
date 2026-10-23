import { useMemo, useState } from "react";
import type { RoomVoiceSnapshot, RoomVoiceSession } from "../room-voice/session";
import { voiceConnectionDetails } from "../room-voice/VoiceConnectionDetails";
import type { VoiceConnectionMetric } from "../room-voice/browser-endpoint";
import { EMPTY_METRICS } from "../types";
import { PREVIEW_METRICS } from "./preview-metrics";
import { CaptureMetricCells } from "../components/living/Metrics";
import { ConnectionDetails } from "../components/living/ConnectionDetails";
import { Couch } from "../components/living/Couch";
import { PawnSvg } from "../components/living/Pawn";
import { PawnDetail } from "../components/living/PawnDetail";
import { RouteTree } from "../components/living/RouteTree";
import { ViewerOverview } from "../components/living/ViewerOverview";
import { Chip, Row, SwitchItem } from "../components/living/primitives";
import { participantColor } from "../components/living/participant-color";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import { participantConnection } from "../lib/participant-connection";
import { deriveParticipantStatus } from "../ui/media-status";
import { useCopy } from "../ui/copy";

const HOST_ID = "d27a938b-61f5-4ab2-b8e4-3fc090c3ae18";
const VIEWER_IDS = [
  "779594c8-a92c-48d9-918f-a7d0befa46d1", "7e3c8491-04c9-44b0-a233-b2f4d894058b",
  "c8f606ea-0e95-40d6-9018-436bedbdc742", "14bf617a-60a0-47b5-b5c8-f7c883a4d41e",
  "6d2b0957-3778-45a3-a79b-67c6aed7e0f6", "813f2dd9-ea4d-48d7-b16c-7c5526809482",
  "f7e34a66-8bd3-4280-82f1-b175fccd2b72", "aa9f7a0f-91c9-4a67-9b0c-bf2bd8c818d3",
  "e0400758-64a8-4134-8d78-e3c2c78f22c7", "35742451-0f6d-4860-aa36-598095fa4f3b",
  "0052af9b-6634-44ad-97e4-f0eb14a888a0", "c03b8829-0f5a-49bf-8f62-257b2b048aaa",
  "10608e40-c169-4da6-b5d3-a7e8668b4f30", "82a2087c-a9d4-437a-ad10-a449d2c8f032",
  "36b3c67c-f502-4151-8e78-a16600cfd8f9", "d568a261-67c2-451c-b089-ebf090ccb563",
  "4f787ab3-877d-445b-a2e0-e121a08b9983", "548eed4c-7572-4c69-9de3-10f1cb93ef39",
  "9f0a89a1-f2d5-4cbd-a4ee-62a4a345d6ed", "a088c8c8-37e6-4d8a-86cf-9a48015e458b",
];
const NAMES = ["小桃", "阿白", "栗子", "小满", "橘子", "小岛", "可乐", "七七", "石头", "圆圆", "木木", "阿南", "小北", "豆子", "月亮", "一帆", "小鱼", "阿树", "点点", "安安"];

export function PeoplePreview() {
  const { t, lang } = useCopy();
  const en = lang === "en";
  const sample = new URLSearchParams(location.search).get("people");
  const initialMode = sample && ["room", "voice", "stopped", "both", "voice-failed", "relay-voice"].includes(sample) ? sample : "mixed";
  const [count, setCount] = useState(initialMode === "mixed" ? 20 : 3);
  const [mode, setMode] = useState(initialMode);
  const [view, setView] = useState<"host" | "viewer">(initialMode === "relay-voice" ? "viewer" : "host");
  const [longNames, setLongNames] = useState(false);
  const [selected, setSelected] = useState<string | null>(["voice", "both", "stopped"].includes(initialMode) ? VIEWER_IDS[0]! : null);
  const [overviewOpen, setOverviewOpen] = useState(initialMode !== "mixed");
  const hostName = en ? "Amu" : "阿沐";
  const peerCount = Math.max(1, Math.floor(count * .6));
  const sourceActive = !["room", "voice", "stopped"].includes(mode);
  const voiceActive = ["voice", "stopped", "both", "voice-failed", "relay-voice"].includes(mode);
  const deepChain = mode === "relay" || mode === "relay-voice";
  const { viewers: routedViewers } = labelParticipantSnapshot(VIEWER_IDS.slice(0, count).map((peerId, index) => ({
    role: "viewer" as const, peerId,
    displayName: longNames ? (en ? `Friend with a long name ${index + 1}` : `这是名字稍微长一点的朋友 ${index + 1}`) : en ? `Friend ${index + 1}` : NAMES[index]!,
    upstream: mode === "pending" || (mode === "mixed" && index > 2 && index >= count - 2)
      ? { kind: "none" as const }
      : deepChain ? { kind: "peer" as const, peerId: index === 0 ? HOST_ID : VIEWER_IDS[index - 1]! }
      : index < peerCount ? { kind: "peer" as const, peerId: index === 0 ? HOST_ID : VIEWER_IDS[Math.floor((index - 1) / 2)]! }
      : index < peerCount + 2 ? { kind: "sfu" as const }
      : { kind: "peer" as const, peerId: VIEWER_IDS[peerCount + (index % 2)]! },
    mediaReady: mode !== "pending" && index % 7 !== 6 && !(mode === "mixed" && index > 2 && index >= count - 2) ? true as const : undefined,
  })));
  const self = VIEWER_IDS[0]!;
  const viewers = sourceActive ? routedViewers : routedViewers.map(viewer => ({ ...viewer, upstream: { kind: "none" as const }, mediaReady: undefined }));
  const voice = useMemo<Pick<RoomVoiceSession, "getSnapshot" | "subscribe"> | undefined>(() => {
    if (!voiceActive) return undefined;
    const state: RoomVoiceSnapshot = {
      peerId: view === "host" ? HOST_ID : self, role: view, connected: true,
      room: { type: "room-voice-state", revision: 1, enabled: true, hostPeerId: HOST_ID, bitrate: 96_000,
        members: [{ peerId: HOST_ID, connected: true, joined: true, upstream: { kind: "none" } },
          ...routedViewers.map(viewer => ({ peerId: viewer.peerId, connected: true, joined: true, upstream: viewer.upstream }))],
        publications: [], connections: [], unavailable: [] },
      capturePending: false, microphone: false, deafened: false, autoplayBlocked: false, muted: new Set(), error: mode === "voice-failed" ? "transport" : null,
      input: { deviceId: "", volume: 1, voiceProcessing: true }, listeningVolume: 1, peerVolumes: new Map(),
    };
    return { getSnapshot: () => state, subscribe: () => () => {} };
  }, [voiceActive, count, view, self, mode]);
  const roomVoice = voice?.getSnapshot().room;
  const localPeerId = view === "host" ? HOST_ID : self;
  const remotePeers = (view === "host" ? routedViewers.map(viewer => viewer.peerId) : [HOST_ID, ...routedViewers.map(viewer => viewer.peerId)])
    .filter(id => id !== localPeerId);
  const receivedVoice = voiceActive && mode !== "voice-failed" ? remotePeers.map((peerId, index): VoiceConnectionMetric => {
    const viaPeerId = deepChain ? view === "host" ? VIEWER_IDS[0]! : peerId === HOST_ID ? HOST_ID : VIEWER_IDS[1]!
      : view === "viewer" ? HOST_ID : index < peerCount ? peerId : null;
    return { connectionId: `voice-example-${viaPeerId ?? "sfu"}`, peerId, viaPeerId,
      direction: "receive", route: viaPeerId ? "p2p" : "sfu",
      metrics: { ...EMPTY_METRICS, bitrateKbps: 82 - index * 2, packetLossPercent: index * .2,
        sampleWindowMs: 1000, intervalPacketsReceived: 1000 - index * 2, intervalPacketsLost: index * 2,
        jitterMs: 2.1 + index * .4, rttMs: viaPeerId ? viaPeerId === HOST_ID || viaPeerId === VIEWER_IDS[0] ? 32 : 40 : 48,
        audioCodec: "audio/opus", audioJitterBufferDelayMs: 24 },
    };
  }) : [];
  const voiceConnections = [...new Map(receivedVoice.map(item => [item.connectionId, item])).values()];
  const voiceMetrics: readonly VoiceConnectionMetric[] = [...receivedVoice,
    ...voiceConnections.map((item, index): VoiceConnectionMetric => ({ ...item, peerId: localPeerId, direction: "send",
      metrics: { ...item.metrics, bitrateKbps: 88 - index * 2, packetLossPercent: .1 + index * .2, jitterMs: 1.8,
        intervalPacketsReceived: null, intervalPacketsLost: null },
    })),
    ...(voiceConnections.length > 1 ? [{ ...receivedVoice.find(item => item.connectionId !== voiceConnections[0]!.connectionId)!,
      connectionId: voiceConnections[0]!.connectionId, viaPeerId: voiceConnections[0]!.viaPeerId, route: voiceConnections[0]!.route,
      direction: "send" as const, metrics: { ...voiceConnections[0]!.metrics, bitrateKbps: 80, packetLossPercent: .2,
        intervalPacketsReceived: null, intervalPacketsLost: null },
    }] : []),
  ];
  const pictureMetrics = sourceActive ? PREVIEW_METRICS : null;
  const connectionFor = (viewer: (typeof viewers)[number]) => participantConnection(viewer, sourceActive, roomVoice);
  const routeFor = (viewer: (typeof viewers)[number]) => {
    const upstream = viewer.upstream;
    return upstream.kind === "none" ? null : upstream.kind === "sfu" ? "sfu" as const : "p2p" as const;
  };
  const selectable = viewers.filter((viewer) => {
    const upstream = connectionFor(viewer).upstream;
    return view === "host" || upstream.kind === "peer" && upstream.peerId === self;
  })
    .map((viewer) => viewer.peerId);
  const entries = viewers.map((viewer) => ({
    key: viewer.peerId, name: viewer.label, you: view === "viewer" && viewer.peerId === self,
    status: deriveParticipantStatus(viewer, sourceActive, undefined, roomVoice), selectable: selectable.includes(viewer.peerId),
  }));
  const selectedViewer = viewers.find((viewer) => viewer.peerId === selected && selectable.includes(viewer.peerId));
  const select = (key: string) => {
    setSelected((current) => current === key ? null : key);
    setOverviewOpen(true);
  };
  return <section id="people-preview" className="cp-section">
    <header className="cp-section-head"><span className="cp-number">05</span><div>
      <h2>{en ? "A seat for everyone" : "人多，也坐得下。"}</h2>
      <p>{en ? "Try the full room, long names and relay depth. Click a person to inspect the same identity in each view."
        : "试试满员、长名字和多层转发。点击小人，沙发、连接图和详情会选中同一个人。"}</p>
    </div></header>
    <div className="cp-tools">
      <div role="group" aria-label={en ? "Viewer count" : "观众人数"}>{[0, 3, 8, 20].map(value => <Chip key={value}
        title={`${value} ${t("common.viewers")}`} selected={count === value} onClick={() => setCount(value)}>{value}</Chip>)}</div>
      <div role="group" aria-label={en ? "Perspective" : "观察视角"}>{(["host", "viewer"] as const).map(value => <Chip key={value}
        title={t(value === "host" ? "common.host" : "common.you")} selected={view === value} onClick={() => setView(value)}>
        {en ? value === "host" ? "Host view" : "Viewer view" : value === "host" ? "房主视角" : "观众视角"}</Chip>)}</div>
      <SwitchItem checked={longNames} onChange={setLongNames} label={en ? "Long names" : "换成长名字"} />
    </div>
    <div className="cp-people-room">
      <div className="cp-sync" role="group" aria-label={en ? "The same Host in two places" : "同一位房主，两个位置"}>
        <span><PawnSvg color={participantColor(HOST_ID)} identity={HOST_ID} host /><small>{en ? "Host view" : "房主这边"}</small></span>
        <span className="cp-sync-caption">{en ? "One person, the same gesture" : "同一个人，同一个小动作"}</span>
        <span><PawnSvg color={participantColor(HOST_ID)} identity={HOST_ID} host /><small>{en ? "Viewer view" : "朋友那边"}</small></span>
      </div>
      <Couch view={view} host={{ key: HOST_ID, name: hostName, you: view === "host" }}
        entries={entries} selectedKey={selectedViewer?.peerId} onSelect={select} />
    </div>
    <div className="cp-tools" role="group" aria-label={en ? "Connection example" : "连接示例"}>
      {[{ id: "room", label: en ? "Room only" : "仅在房间" },
        { id: "voice", label: en ? "Voice before sharing" : "未开播 · 语音已连" },
        { id: "stopped", label: en ? "Picture stopped, voice stays" : "停播 · 语音继续" },
        { id: "both", label: en ? "Picture + voice" : "画面与语音" },
        { id: "relay-voice", label: en ? "Relay + voice" : "接力与语音" },
        { id: "voice-failed", label: en ? "Picture ready, voice failed" : "画面正常 · 语音失败" },
        { id: "mixed", label: en ? "Peers + SFU" : "P2P + SFU" },
        { id: "relay", label: en ? "Deep relay chain" : "多层接力" },
        { id: "pending", label: en ? "Waiting for a route" : "等待连接" }].map(item =>
        <Chip key={item.id} title={item.label} selected={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</Chip>)}
    </div>
    {!sourceActive && <p className="cp-note">{en
      ? voiceActive ? "Voice routes stay visible without a picture. Select a person to inspect their route." : "Everyone is in the room. Media connections begin when sharing or voice starts."
      : voiceActive ? "没有分享画面时，语音线路仍会显示。点击小人查看对应连接。" : "大家都在房间里。开始分享或加入语音后，再建立媒体连接。"}</p>}
    <details className="cp-disclosure" open={overviewOpen} onToggle={event => setOverviewOpen(event.currentTarget.open)}>
      <summary>{t("host.details")}</summary>
      {overviewOpen && (sourceActive || voice) && <Row sub><ConnectionDetails rows={[
        ...(sourceActive ? [{ key: "picture", media: "video" as const, label: t(view === "host" ? "stats.localCapture" : "stats.sharedMedia"),
          icon: view === "host" ? "share" as const : "arrowDown" as const,
          cells: view === "host" ? <CaptureMetricCells resolution="2560x1440" frameRate={60} codec="h264" hasSourceAudio /> : undefined,
          route: view === "viewer" ? "p2p" as const : null, metrics: view === "viewer" ? pictureMetrics : null,
          direction: view === "viewer" ? "receive" as const : "send" as const,
        }] : []),
        ...(sourceActive && view === "viewer" && viewers.some(viewer => viewer.upstream.kind === "peer" && viewer.upstream.peerId === self)
          ? [{ key: "relay", media: "video" as const, label: t("stats.relay"), direction: "send" as const, route: "p2p" as const, metrics: pictureMetrics }] : []),
        ...voiceConnectionDetails({ voice: voice?.getSnapshot(), metrics: voiceMetrics, t,
          peerName: id => viewers.find(viewer => viewer.peerId === id)?.label ?? hostName }),
      ]} /></Row>}
      {overviewOpen && view === "host" && count > 0 ? <ViewerOverview entries={entries.map((entry, index) => ({ ...entry, metrics: pictureMetrics,
        route: sourceActive ? routeFor(viewers[index]!) : null,
      }))} pictureActive={sourceActive} voice={voice?.getSnapshot()} voiceMetrics={voiceMetrics} selectedKey={selectedViewer?.peerId ?? null} onSelect={select} /> : null}
      {overviewOpen && selectedViewer ? <PawnDetail pawnKey={selectedViewer.peerId} name={selectedViewer.label}
        route={sourceActive ? routeFor(selectedViewer) : null}
        metrics={pictureMetrics} direction={view === "host" ? "send" : "receive"} onClose={() => setSelected(null)}
        voiceDetails={voiceConnectionDetails({ voice: voice?.getSnapshot(), peerId: selectedViewer.peerId, metrics: voiceMetrics, t,
          peerName: id => viewers.find(viewer => viewer.peerId === id)?.label ?? hostName })}
      /> : null}
    </details>
    <div className="cp-connection-panel">
      <RouteTree hostPeerId={HOST_ID} hostLabel={hostName} viewers={viewers} pictureActive={sourceActive} voice={voice}
        selfPeerId={view === "viewer" ? self : HOST_ID} selectedPeerId={selectedViewer?.peerId}
        selectablePeerIds={selectable} onSelectPeer={select} />
    </div>
  </section>;
}
