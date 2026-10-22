// Staged data, real product components. This sandbox never starts a room,
// requests capture permission, or connects to an API/signaling service.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  AppHeader,
  LedStrip,
} from "../../../../src/client/components/living/Header";
import {
  StageTv,
  StaticNoise,
} from "../../../../src/client/components/living/Stage";
import { CaptureSourcePicker } from "../../../../src/client/components/living/CaptureSourcePicker";
import { RoomInteractions } from "../../../../src/client/components/living/RoomInteractions";
import { RoomInteractionSession } from "../../../../src/client/lib/room-interactions";
import { RoomChatToggle } from "../../../../src/client/components/living/RoomChatOverlay";
import { HostShareControls } from "../../../../src/client/components/living/HostShareControls";
import { HostRemoteControl } from "../../../../src/client/components/living/HostRemoteControl";
import { RoomVoiceControls, RoomVoicePanel, RoomVoiceSettings, type RoomVoiceView } from "../../../../src/client/room-voice/RoomVoicePanel";
import type { RoomVoiceSnapshot } from "../../../../src/client/room-voice/session";
import { PlaybackControlsView } from "../../../../src/client/components/living/PlaybackControls";
import { StatusIndicator } from "../../../../src/client/components/living/StatusIndicator";
import { Lcd, RoomChip, RoomCodePlaceholder, RoomAdmissionBadge } from "../../../../src/client/components/living/RoomChip";
import { Tooltip } from "../../../../src/client/components/living/Tooltip";
import {
  Btn,
  Row,
  RowGroup,
  NameTag,
  FieldCap,
  Cap,
  SwitchItem,
} from "../../../../src/client/components/living/primitives";
import { Glyph } from "../../../../src/client/ui/icons";
import { setCopy, useCopy } from "../../../../src/client/ui/copy";
import { deriveHostStatus, deriveParticipantStatus, deriveViewerStatus } from "../../../../src/client/ui/media-status";
import {
  deriveViewerPresentation,
  INITIAL_VIEWER_PRESENTATION_STATE,
  reduceViewerPresentation,
  type ViewerPresentationAction,
} from "../../../../src/client/media/viewer-presentation";
import { partyMarkup } from "../game.js";
import { BEAT, UI_CUES as cues } from "../ui-score.js";
import { HOST as host, GUESTS as guests, cast } from "../cast.js";
import { point } from "./cursor";
import "../../../../src/client/styles.css";
import "./ui.css";

type Shot = "idle" | "picker" | "host" | "copied" | "chat" | "draft" | "sent" | "viewer" | "viewer-chat"
  | "voice-closed" | "voice-open" | "voice-host-mic" | "voice-viewer" | "voice-joined" | "voice-mic"
  | "control-off" | "control-on" | "control-pending" | "control-active";
const noop = () => {};
const roomId = "9527";
const inviteUrl = `https://invite.piik.example/r/${roomId}`;

let filmTime = 0;
let filmSpeaker: number | undefined;
function sampleVoice(shot: Shot, viewer: boolean): RoomVoiceView {
  const enabled = shot !== "voice-closed";
  const joined = viewer ? ["voice-joined", "voice-mic"].includes(shot) : enabled;
  const microphone = shot === "voice-host-mic" || shot === "voice-mic";
  const snapshot: RoomVoiceSnapshot = {
    peerId: viewer ? guests[0] : host, role: viewer ? "viewer" : "host", connected: true,
    microphone, capturePending: false, deafened: false, listeningVolume: 1,
    peerVolumes: new Map(), autoplayBlocked: false, error: null, muted: new Set(),
    input: { deviceId: "", volume: 1, voiceProcessing: true },
    room: { type: "room-voice-state", revision: 1, enabled, hostPeerId: host,
      publications: [], connections: [], unavailable: [],
      members: [host, ...guests.slice(0, 2)].map((peerId, i) => ({
        peerId, connected: true,
        joined: i === 0 ? enabled : viewer ? joined : false,
        publicationId: i === 0 ? viewer || microphone ? "film-host-mic" : undefined
          : microphone && viewer ? `film-friend-${i}` : undefined,
        upstream: i === 0 ? { kind: "none" as const } : { kind: "peer" as const, peerId: host },
      })),
    },
  };
  return {
    subscribe: () => noop, getSnapshot: () => snapshot,
    command: () => true, resumeAudio: noop, startMicrophone: async () => {}, stopMicrophone: noop,
    deafen: noop, configureInput: async () => {}, setVolume: noop,
    setListeningVolume: noop, setPeerVolume: noop, muteVoice: noop,
    microphones: async () => [],
    activity: async () => {
      return new Map(filmSpeaker !== undefined ? [[filmSpeaker === 0 ? host : guests[filmSpeaker - 1],
        .08 + .08 * Math.abs(Math.sin(filmTime * 18))]] : []);
    },
  };
}

function sampleInteractions(zh: boolean, viewer: boolean) {
  const session = new RoomInteractionSession(() => true, () => 0);
  const { name, names } = cast(zh);
  session.authenticated(viewer ? guests[0] : host);
  session.receive({ type: "room-interactions-ready", serverTime: 0 });
  if (!viewer) return session;
  [
    { peerId: host, role: "host" as const, displayName: name, text: zh ? "来，看点好康的。" : "Come on in." },
    { peerId: guests[0], role: "viewer" as const, displayName: names[0], text: zh ? "前排就位。" : "Front row, reporting in." },
  ].forEach(({ text, ...sender }, index) => session.receive({
    type: "room-interaction", id: `sample-${index}`, requestId: `sample-${index}`,
    occurredAt: 0, sender, payload: { kind: "chat", text },
  }));
  return session;
}
const status = deriveParticipantStatus(
  { mediaReady: true, upstream: { kind: "peer", peerId: host } },
  true,
);
const viewerActions: ViewerPresentationAction[] = [
  { type: "access", access: "ready" },
  { type: "signal", signal: "connected" },
  { type: "host", host: "online" },
  { type: "route", revision: 1, phase: "active", kind: "p2p" },
  { type: "media-bound", generation: 1, revision: 1 },
  { type: "connection", revision: 1, connection: "connected" },
  { type: "frame-presented", generation: 1, proofEpoch: 0, revision: 1 },
];
const viewerTelevision = deriveViewerStatus(
  deriveViewerPresentation(viewerActions.reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE)),
  "connected",
  "p2p",
).television;
let drawGame: ((time: number) => void) | undefined;
function Game({ waiting }: { waiting: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    drawGame = time => { ref.current!.innerHTML = partyMarkup(time, waiting); };
    drawGame(0);
    return () => {
      drawGame = undefined;
    };
  }, [waiting]);
  return (
    <svg
      ref={ref}
      className="sample-game"
      viewBox="0 0 1600 900"
      aria-hidden="true"
    />
  );
}
const sources = [{
  kind: "window" as const, sourceId: "101", pid: 1, creationTime: "1", title: "跳跳派对 · 双人夺旗",
}];
const preview = async () => "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">${partyMarkup(0, true)}</svg>`,
);

function Chat({shot}: {shot: Shot}) {
  const {lang} = useCopy();
  const zh = lang === "zh";
  return <section className="film-chat" aria-label={zh ? "聊天软件示意" : "Chat app example"}>
    <header><span className="chat-avatar"><Glyph name="users" size={36} /></span><div><small>{zh ? "聊天软件示意" : "CHAT APP EXAMPLE"}</small><strong>{zh ? "周末小分队" : "Weekend crew"}</strong></div></header>
    <div className="chat-messages"><p className="chat-bubble">{zh ? "人呢？" : "You joining?"}</p>
      {shot === "sent" && <p className="chat-bubble chat-mine">{inviteUrl}<span>✓</span></p>}
    </div>
    <div className="chat-compose"><input id="chat-draft" value={shot === "draft" ? inviteUrl : ""} readOnly aria-label={zh ? "消息" : "Message"} /><button id="chat-send" type="button"><Glyph name="arrowRight" size={24} />{zh ? "发送" : "Send"}</button></div>
  </section>;
}

function Screen({ shot }: { shot: Shot }) {
  const { t, lang } = useCopy();
  const viewer = shot === "viewer" || shot === "viewer-chat" || ["voice-viewer", "voice-joined", "voice-mic"].includes(shot);
  const voiceShot = shot.startsWith("voice-");
  const controlShot = shot.startsWith("control-");
  const session = useMemo(() => sampleInteractions(lang === "zh", viewer), [lang, viewer]);
  useEffect(() => () => session.close(), [session]);
  const voice = useMemo(() => sampleVoice(shot, viewer), [shot, viewer]);
  const chat = shot === "chat" || shot === "draft" || shot === "sent";
  const live = shot === "host" || shot === "copied" || viewer || chat || voiceShot || controlShot;
  const hostStatus = deriveHostStatus({
    phase: live ? "live" : "idle",
    paused: false,
    signal: "connected",
    roomReady: live,
  });
  const { name, names } = cast(lang === "zh");
  return (
    <div className="lr-app">
      <AppHeader
        homeHref="/"
        atHome={!viewer}
        showAppConnection={false}
        led={
          (
            <LedStrip
              state={hostStatus.connection.tone}
              comic={hostStatus.connection.comic}
              label={t(hostStatus.connection.labelKey)}
            />
          )
        }
      />
        <main className="lr-room">
          <div className="lr-scene">
            <StageTv
              live={live}
              hasEntry={!live}
              label={t("host.stageAria")}
              indicator={<StatusIndicator status={shot === "viewer" ? viewerTelevision : hostStatus.television} />}
            >
              {live ? <Game waiting={shot !== "control-active"} /> : <StaticNoise />}
              {viewer && <PlaybackControlsView
                audio={{ level: 1, muted: false, boostAvailable: true }} paused={false}
                hasAudio canPlay theaterMode={false}
                fullscreen={{ supported: true, ready: true, active: false }}
                picture={{ supported: true, active: false, failed: false, toggle: async () => {} }}
                togglePlayback={noop} toggleFullscreen={noop} toggleMute={noop} setLevel={noop}
                onToggleTheater={noop} onReconnect={noop} reconnectAvailable
                overlayAction={<RoomChatToggle session={session} />} />}
              {shot === "picker" && (
                <CaptureSourcePicker
                  nativeSources={{
                    kind: "ready",
                    processAudio: true,
                    systemAudio: true,
                    processAudioExclusion: true,
                    captureBorderControl: true,
                    sources,
                  }}
                  onBrowser={noop}
                  onCamera={noop}
                  loadCameras={async (_signal, publish) => publish([])}
                  onNative={noop}
                  onPreview={preview}
                  onRefresh={noop}
                  onCancel={noop}
                />
              )}
              {!live && (
                <div className="lr-tv-overlay" style={{ visibility: shot === "picker" ? "hidden" : undefined }}>
                  <div className="lr-entry-actions">
                    {(["host.start", "host.join"] as const).map((key, i) => (
                      <span className="lr-entry-action" key={key}>
                        <button
                          type="button"
                          className={`lr-tv-big${i === 0 ? " is-action is-ripple" : ""}`}
                          aria-label={t(key)}
                        >
                          <Glyph
                            name={i === 0 ? "cast" : "door"}
                            size={i === 0 ? 34 : 30}
                            draw={i === 0 ? "entry-cast" : "entry-door"}
                          />
                        </button>
                        <span className="lr-tv-msg">{t(key)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </StageTv>
            {!viewer && <HostShareControls actions={live ? <>
                <Btn icon="switchSource" cap="host.switchSource" title="host.switchSource" hint="hint-switch-source" />
              </> : null}
              remote={controlShot && <HostRemoteControl mode={shot === "control-off" ? "off" : "ask"} platform="windows"
                requests={shot === "control-pending" || shot === "control-active"
                  ? [{ id: "film-request", peerId: guests[0], state: shot === "control-active" ? "active" : "pending", name: names[0] }] : []}
                onPolicy={async () => {}} onDecide={async () => {}} />}
              settings={<Btn icon="sliders" cap="host.settings.button" title="host.advanced" hint="hint-advanced" expanded={false} />}
              pause={live && <Btn icon="pause" cap="host.pause" title="host.pause" hint="hint-pause" draw="host-share-toggle" />}
              ending={live && <Btn icon="stop" tone="danger" cap="host.stop" title="host.stop" hint="hint-share-stop" />}
            />}
            <div className="lr-stage-notices" />
            <RoomInteractions
              session={live ? session : null}
              voice={voiceShot ? {
                content: select => <RoomVoicePanel session={voice} names={new Map([[host, name], ...guests.map((id, i) => [id, names[i]] as const)])} onSelectParticipant={select} />,
                controls: <RoomVoiceControls session={voice} />,
                settings: <RoomVoiceSettings session={voice} />,
              } : undefined}
              view={viewer ? "viewer" : "host"}
              host={{ key: host, name, you: !viewer }}
              entries={
                viewer || voiceShot || controlShot
                  ? guests.map((key, i) => ({
                      key,
                      name: names[i],
                      status,
                      you: viewer && i === 0,
                    }))
                  : []
              }
            />
          </div>
          <div className="lr-deck">
            <div className={`lr-row ${viewer ? "lr-viewer-summary-row" : "lr-host-summary-row"}`}>
              <div className={`lr-row-group ${viewer ? "lr-viewer-room-slot" : "lr-host-room-slot"}`}>
                <FieldCap k="common.roomCode" />
                {viewer ? <Lcd code={roomId} /> : live ? <>
                  <RoomChip roomId={roomId} onReplace={noop} />
                  <RoomAdmissionBadge policy="private" passwordEnabled={false} />
                </> : <RoomCodePlaceholder />}
              </div>
              {viewer && <div className="lr-row-group lr-viewer-host-slot"><Glyph name="tv" size={18} /><b>{name}</b></div>}
              <div className={viewer ? "lr-viewer-personal-controls" : "lr-host-personal-controls"}>
                <div className={`lr-row-group lr-group-name ${viewer ? "lr-viewer-self-slot" : "lr-host-identity-slot"}`}>
                  <NameTag name={viewer ? names[0] : name} identity={viewer ? guests[0] : host} />
                  <Btn icon="pencil" cap="common.edit" title="host.nameEdit" hint="hint-rename" />
                </div>
                <div className={`lr-row-group lr-group-actions ${viewer ? "lr-viewer-actions-slot" : "lr-host-diagnostics-slot"}`}>
                  <Btn icon="gauge" cap="host.details" title="host.details.show" hint="hint-details" disabled={!live} />
                  <Btn icon="network" cap="host.topology" title="host.topology.show" hint="hint-topology" />
                </div>
              </div>
            </div>
            {live && !viewer ? (
                <Row label={t("host.policy")}>
                  <RowGroup actions>
                    <Btn
                      icon={shot === "copied" || chat ? "check" : "link"}
                      cap="common.copy"
                      title={
                        shot === "copied" || chat ? "common.copied" : "host.invite.copy"
                      }
                      hint="hint-copy-invite"
                      hintTone={shot === "copied" || chat ? "live" : undefined}
                      hintMotion={shot === "copied" || chat ? "still" : undefined}
                    />
                    <Btn
                      icon="refresh"
                      cap="host.invite.rotateShort"
                      title="host.invite.rotate"
                      hint="hint-rotate-invite"
                    />
                    <Btn
                      icon="linkOff"
                      tone="danger"
                      cap="host.invite.revokeShort"
                      title="host.invite.revoke"
                      hint="hint-revoke-invite"
                    />
                  </RowGroup>
                  <div className="lr-invite-field">
                  <Tooltip kind="hint-invite-link" text={inviteUrl} className="lr-invite-hint"><input
                    className="lr-invite-url"
                    readOnly
                    value={inviteUrl}
                    aria-label={t("host.invite")}
                  /></Tooltip>
                  <span className="lr-row-group"><Glyph name="key" size={17} />
                    <SwitchItem checked label={t("host.invite.includeCredential")} hint="hint-invite-link"
                      note={t("host.invite.credentialHint")} onChange={noop} />
                  </span>
                  </div>
                  <span className="lr-divider" aria-hidden="true" />
                  <RowGroup>
                    <span className="lr-toggle" role="group" aria-label={t("host.policy")}>
                      <button type="button" aria-pressed={false}><Glyph name="globe" size={19} /><Cap k="host.policy.open" /></button>
                      <button type="button" className="is-selected" aria-pressed><Glyph name="lock" size={19} /><Cap k="host.policy.private" /></button>
                    </span>
                    <Btn icon="key" cap="join.password" title="host.password.setAction" hint="hint-password" />
                  </RowGroup>
                </Row>
            ) : null}
          </div>
        </main>
      {chat && <Chat shot={shot} />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
const camera = document.getElementById("camera")!;
const cursor = document.getElementById("cursor")!;
let current = "";
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const ease = (n: number) => 1 - (1 - clamp(n)) ** 4;
type Frame = {
  scene: "share" | "invite" | "arrive" | "voice" | "control";
  local: number;
  time: number;
  lang: "en" | "zh-CN";
};
const voiceShots: [number, Shot][] = [[0, "voice-closed"], [cues.voice.open, "voice-open"],
  [cues.voice.hostMic, "voice-host-mic"], [cues.voice.viewer, "voice-viewer"],
  [cues.voice.join, "voice-joined"], [cues.voice.viewerMic, "voice-mic"]];
const controlShots: [number, Shot][] = [[0, "control-off"], [cues.control.open, "control-on"],
  [cues.control.request, "control-pending"], [cues.control.approved, "control-active"]];

function shotAt({ scene, local: t }: Frame): Shot {
  if (scene === "arrive") return t < cues.chatOpen ? "viewer" : "viewer-chat";
  if (scene === "voice") return voiceShots.findLast(([at]) => t >= at)![1];
  if (scene === "control") return controlShots.findLast(([at]) => t >= at)![1];
  if (scene === "share") return t < cues.share + BEAT / 4 ? "idle" : t < cues.live ? "picker" : "host";
  if (t < cues.copy + BEAT / 4) return "host";
  if (t < cues.chat) return "copied";
  if (t < cues.paste) return "chat";
  if (t < cues.send + BEAT / 4) return "draft";
  return t < cues.viewer ? "sent" : "viewer";
}
let settling = 0;
// The opaque sandbox cannot persist its sample locale/theme to the real app.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (
    event.source !== parent ||
    data?.type !== "piik-film-ui" ||
    !["share", "invite", "arrive", "voice", "control"].includes(data.scene) ||
    !["en", "zh-CN"].includes(data.lang) ||
    !Number.isFinite(data.time) ||
    !Number.isFinite(data.local)
  )
    return;
  filmTime = data.time;
  filmSpeaker = data.speaker ?? undefined;
  const shot = shotAt(data);
  const key = `${data.lang}:${data.scene}:${shot}`;
  if (key !== current) {
    current = key;
    document.body.dataset.feature = data.scene;
    document.body.dataset.shot = shot;
    setCopy({ lang: data.lang === "en" ? "en" : "zh", vis: false });
    flushSync(() => root.render(<Screen shot={shot} />));
    // A scripted picker must not steal the film's keyboard focus or show its
    // autofocus tooltip. The actual picker retains autofocus in the product.
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  }
  paint(data);
  // A newly shown iframe needs a layout frame; participants also align their
  // gestures on mount. Reapply this same position after both have settled.
  cancelAnimationFrame(settling);
  settling = requestAnimationFrame(() => paint(data));
});
function paint(data: Frame) {
  const t = data.local;
  drawGame?.(0);
  // Product CSS gestures use the film clock, including pause, seek and replay.
  document.getAnimations().forEach((animation) => {
    animation.pause();
    animation.currentTime = data.time * 1000;
  });
  camera.style.transform = "none";
  const center = (element: Element | null | undefined) => {
    const box = element?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
  };
  const showChat = data.scene === "arrive" && t >= cues.chatOpen;
  document.querySelectorAll<HTMLElement>(".lr-floating-panel:popover-open").forEach(panel => {
    if (!((data.scene === "voice" || showChat) && panel.classList.contains("lr-interaction-panel")) &&
        !(data.scene === "control" && panel.classList.contains("lr-remote-panel"))) panel.hidePopover();
  });
  if (data.scene === "voice" || data.scene === "control" || showChat) {
    const voice = data.scene === "voice", interaction = voice || showChat;
    const panel = document.querySelector<HTMLElement>(interaction ? ".lr-interaction-panel" : ".lr-remote-panel");
    const trigger = document.querySelector<HTMLButtonElement>(interaction ? ".lr-interaction-chat-toggle button" : ".lr-remote-trigger button");
    if (panel && trigger && !panel.matches(":popover-open")) panel.showPopover({ source: trigger });
    if (voice) {
      const tab = panel?.querySelector<HTMLButtonElement>('[role="tab"]:last-child');
      if (tab?.getAttribute("aria-selected") === "false") flushSync(() => tab.click());
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (showChat) { cursor.style.opacity = "0"; return; }
    if (voice) {
      const viewer = t >= cues.voice.viewer;
      const joinAt = viewer ? cues.voice.join : cues.voice.open;
      const micAt = viewer ? cues.voice.viewerMic : cues.voice.hostMic;
      const join = center([...panel!.querySelectorAll('.lr-voice-toolbar button')].at(-1));
      const mic = center(panel?.querySelector('.lr-voice-quick-controls button'));
      const toMic = t >= joinAt + BEAT / 4;
      point(cursor, t, toMic && join ? join : { x: 430, y: 650 }, toMic ? mic : join,
        toMic ? joinAt + BEAT / 4 : joinAt - BEAT, toMic ? micAt - joinAt - BEAT / 4 : BEAT,
        toMic ? micAt : joinAt, micAt + BEAT);
      if (viewer) cursor.style.opacity = String(Number(cursor.style.opacity) * ease((t - cues.voice.viewer) / (BEAT / 2)));
    } else {
      const enable = center(panel?.querySelector('[role="switch"]'));
      const approve = center(panel?.querySelector('.lr-remote-request-actions .is-primary'));
      const toApprove = t >= cues.control.request;
      point(cursor, t, toApprove && enable ? enable : { x: 430, y: 650 }, toApprove ? approve : enable,
        toApprove ? cues.control.request + .2 : cues.control.open - BEAT,
        toApprove ? cues.control.allow - cues.control.request - .2 : BEAT,
        toApprove ? cues.control.allow : cues.control.open, cues.control.approved);
    }
    return;
  }
  if (data.scene === "arrive" || data.scene === "invite" && t >= cues.viewer) {
    // The final wide shot includes the current playback bar, sofa, chat and deck.
    // Zoom the whole page, retaining product layout and proportions.
    const scale = Math.min(1, 740 / document.querySelector<HTMLElement>(".lr-app")!.scrollHeight);
    camera.style.transform = `translateX(${1100 * (1 - scale) / 2}px) scale(${scale})`;
    cursor.style.opacity = "0";
    return;
  }
  let pan = 0;
  if (data.scene === "share" && t >= cues.live) {
    const controls = document.querySelector<HTMLElement>(".lr-host-share-controls")!;
    pan = Math.max(0, controls.getBoundingClientRect().bottom - 716) * ease((t - cues.live) / BEAT);
  }
  if (data.scene === "invite") {
    const row = document.querySelector<HTMLElement>(".lr-invite-url");
    pan = row ? Math.max(0, row.getBoundingClientRect().top - 490) : 0;
    pan *= 1 - ease((t - 7 * BEAT) / BEAT);
    pan *= ease(t / BEAT);
    const chat = document.querySelector<HTMLElement>(".film-chat");
    if (chat) chat.style.transform = `translateY(${pan}px)`;
  }
  let from = { x: 1040, y: 710 };
  let target: ReturnType<typeof center>;
  let moveAt = BEAT / 2, moveFor = BEAT, clickAt = 0, hideAt = 0;
  if (data.scene === "share") {
    // The entry stays laid out beneath the picker, so either seek direction
    // uses the actual preceding control as its anchor, without cursor history.
    const entry = center(document.querySelector<HTMLElement>(".lr-entry-action button"));
    target = entry;
    moveFor = BEAT;
    clickAt = cues.share;
    hideAt = cues.live;
    if (t >= 2.25 * BEAT && entry) {
      from = entry;
      target = center(document.querySelector<HTMLElement>(".lr-source-option"));
      moveAt = 2.25 * BEAT;
      moveFor = 1.25 * BEAT;
      clickAt = cues.source;
    }
  }
  if (data.scene === "invite") {
    const copy = center(
      document
        .querySelector<HTMLElement>(".lr-invite-url")
        ?.closest(".lr-row")
        ?.querySelector<HTMLElement>("button"),
    );
    target = copy;
    clickAt = cues.copy;
    hideAt = cues.send + BEAT;
    if (t >= cues.chat && copy) {
      from = copy;
      target = center(document.getElementById('chat-draft'));
      moveAt = cues.chat;
      moveFor = BEAT;
      clickAt = cues.paste;
    }
    if (t >= cues.paste + BEAT / 2) {
      from = center(document.getElementById('chat-draft')) ?? from;
      target = center(document.getElementById('chat-send'));
      moveAt = cues.paste + BEAT / 2;
      moveFor = BEAT;
      clickAt = cues.send;
    }
  }
  point(cursor, t, from, target, moveAt, moveFor, clickAt, hideAt);
  camera.style.transform = `translateY(${-pan}px)`;
}
parent.postMessage({ type: "piik-film-ui-ready" }, "*");
