// Staged data, real product components. This sandbox never starts a room,
// requests capture permission, or connects to an API/signaling service.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  AppHeader,
  LedStrip,
} from "../../../src/client/components/living/Header";
import { LauncherForm } from "../../../src/client/components/living/LauncherForm";
import {
  StageTv,
  StaticNoise,
} from "../../../src/client/components/living/Stage";
import { CaptureSourcePicker } from "../../../src/client/components/living/CaptureSourcePicker";
import { RoomInteractions } from "../../../src/client/components/living/RoomInteractions";
import { RoomInteractionSession } from "../../../src/client/lib/room-interactions";
import { RoomChatToggle } from "../../../src/client/components/living/RoomChatOverlay";
import { HostMicrophone } from "../../../src/client/components/living/HostMicrophone";
import { PlaybackControlsView } from "../../../src/client/components/living/PlaybackControls";
import { StatusIndicator } from "../../../src/client/components/living/StatusIndicator";
import { Lcd, RoomChip, RoomCodePlaceholder, RoomAdmissionBadge } from "../../../src/client/components/living/RoomChip";
import { Tooltip } from "../../../src/client/components/living/Tooltip";
import {
  Btn,
  Row,
  RowGroup,
  NameTag,
  FieldCap,
  Cap,
  SwitchItem,
} from "../../../src/client/components/living/primitives";
import { Glyph } from "../../../src/client/ui/icons";
import { setCopy, useCopy } from "../../../src/client/ui/copy";
import { initTheme } from "../../../src/client/ui/theme";
import { deriveHostStatus, deriveParticipantStatus, deriveViewerStatus } from "../../../src/client/ui/media-status";
import {
  deriveViewerPresentation,
  INITIAL_VIEWER_PRESENTATION_STATE,
  reduceViewerPresentation,
  type ViewerPresentationAction,
} from "../../../src/client/media/viewer-presentation";
import { gameMarkup, createGame } from "../../assets/game.js";
import { sketchMarkup } from "../../assets/sketch.js";
import { BEAT, INVITE_CUES } from "../score.js";
import { point } from "./cursor";
import "../../../src/client/styles.css";
import "./ui.css";

type Shot = "desktop" | "local" | "link" | "idle" | "picker" | "host" | "copied" | "chat" | "draft" | "sent" | "viewer";
const noop = () => {};
const roomId = "9527";
const inviteUrl = `https://invite.piik.example/r/${roomId}`;
const host = "d27a938b-61f5-4ab2-b8e4-3fc090c3ae18";
const guests = [
  "779594c8-a92c-48d9-918f-a7d0befa46d1",
  "7e3c8491-04c9-44b0-a233-b2f4d894058b",
  "c8f606ea-0e95-40d6-9018-436bedbdc742",
];
const cast = (zh: boolean) => ({
  name: zh ? "摸鱼办主任" : "ThisIsFine",
  names: zh ? ["派大星", "大聪明", "咸鱼突刺"] : ["Leeroy", "Kenobi", "NotABot"],
});

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
function Game() {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    ref.current!.innerHTML = gameMarkup("ui-game");
    drawGame = createGame(ref.current!, "ui-game");
    return () => {
      drawGame = undefined;
    };
  }, []);
  return (
    <svg
      ref={ref}
      className="sample-game"
      viewBox="0 0 1600 900"
      aria-hidden="true"
    />
  );
}
const thumbnail =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">${gameMarkup("thumb")}</svg>`,
  );
const sources = [
  {
    kind: "window" as const,
    sourceId: "101",
    pid: 1,
    creationTime: "1",
    title: "RPG",
  },
  {
    kind: "window" as const,
    sourceId: "102",
    pid: 2,
    creationTime: "2",
    title: "Sketchbook",
  },
];
const preview = async (target: { sourceId: string }) =>
  target.sourceId === "101"
    ? thumbnail
    : "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 720">${sketchMarkup('thumb-sketch')}</svg>`,
      );

function Folder({size}: {size: number}) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><path d="M3 10V7q0-2 2-2h8l4 4h10q2 0 2 2v14q0 2-2 2H5q-2 0-2-2Z" fill="#f3cc68" stroke="#203037" strokeWidth="1.6" /><path d="M3 12h26" stroke="#203037" strokeWidth="1.6" /></svg>;
}

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
  const viewer = shot === "viewer";
  const session = useMemo(() => sampleInteractions(lang === "zh", viewer), [lang, viewer]);
  useEffect(() => () => session.close(), [session]);
  if (shot === "desktop") return (
    <main className="desktop">
      <div className="desktop-folder">
        <div className="desktop-path"><Folder size={25} /> Piik App</div>
        <div className="desktop-files">
          <button id="desktop-app" type="button">
            <img src="../../assets/favicon.svg" width="96" height="96" alt="" />
            <span>piik-app.exe</span>
          </button>
          <div className="desktop-runtime"><Folder size={70} /><span>runtime</span></div>
        </div>
      </div>
      <div className="desktop-taskbar"><img src="../../assets/favicon.svg" width="34" height="34" alt="" /></div>
    </main>
  );
  const launcher = shot === "local" || shot === "link";
  const chat = shot === "chat" || shot === "draft" || shot === "sent";
  const live = shot === "host" || shot === "copied" || shot === "viewer" || chat;
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
        led={
          launcher ? undefined : (
            <LedStrip
              state={hostStatus.connection.tone}
              comic={hostStatus.connection.comic}
              label={t(hostStatus.connection.labelKey)}
            />
          )
        }
      />
      {launcher ? (
        <main className="lr-client-launch">
          <LauncherForm
            mode={shot}
            onModeChange={noop}
            site=""
            onSiteChange={noop}
            localAccessPassword=""
            onLocalAccessPasswordChange={noop}
            onSubmit={(event) => event.preventDefault()}
          />
        </main>
      ) : (
        <main className="lr-room">
          <div className="lr-scene">
            <StageTv
              live={live}
              hasEntry={!live}
              label={t("host.stageAria")}
              indicator={<StatusIndicator status={shot === "viewer" ? viewerTelevision : hostStatus.television} />}
            >
              {live ? <Game /> : <StaticNoise />}
              {viewer && <PlaybackControlsView
                audio={{ level: 1, muted: false, boostAvailable: true }} paused={false}
                hasAudio canPlay theaterMode={false}
                fullscreen={{ supported: true, ready: true, active: false }}
                picture={{ supported: true, active: false, failed: false, toggle: async () => {} }}
                togglePlayback={noop} toggleFullscreen={noop} toggleMute={noop} setLevel={noop}
                onToggleTheater={noop} onReconnect={noop} reconnectAvailable
                extraActions={<RoomChatToggle session={session} />} />}
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
            {!viewer && <div className="lr-host-share-controls lr-media-controls" role="group" aria-label={t("host.shareControls")}>
              <HostMicrophone enabled={false} volume={1} onToggle={noop} />
              {live && <>
                <Btn icon="pause" cap="host.pause" title="host.pause" hint="hint-pause" draw="host-share-toggle" />
                <Btn icon="switchSource" cap="host.switchSource" title="host.switchSource" hint="hint-switch-source" />
              </>}
              <Btn icon="sliders" cap="host.settings.button" title="host.advanced" hint="hint-advanced" expanded={false} />
              {live && <Btn icon="stop" tone="danger" cap="host.stop" title="host.stop" hint="hint-share-stop" />}
            </div>}
            <div className="lr-stage-notices" />
            <RoomInteractions
              session={live ? session : null}
              view={viewer ? "viewer" : "host"}
              host={{ key: host, name, you: !viewer }}
              entries={
                shot === "viewer"
                  ? guests.map((key, i) => ({
                      key,
                      name: names[i],
                      status,
                      you: i === 0,
                    }))
                  : []
              }
            />
          </div>
          <div className="lr-deck">
            <div className={`lr-row${viewer ? " lr-viewer-summary-row" : ""}`}>
              <div className={`lr-row-group${viewer ? " lr-viewer-room-slot" : ""}`}>
                <FieldCap k="common.roomCode" />
                {viewer ? <Lcd code={roomId} /> : live ? <>
                  <RoomChip roomId={roomId} onReplace={noop} />
                  <RoomAdmissionBadge policy="private" passwordEnabled={false} />
                </> : <RoomCodePlaceholder />}
              </div>
              {viewer ? <div className="lr-row-group lr-viewer-host-slot"><Glyph name="tv" size={18} /><b>{name}</b></div> : <span className="lr-spacer" />}
              <div className={viewer ? "lr-viewer-personal-controls" : "lr-host-personal-controls"}>
                <div className={`lr-row-group lr-group-name ${viewer ? "lr-viewer-self-slot" : "lr-host-identity-slot"}`}>
                  <NameTag name={viewer ? names[0] : name} identity={viewer ? guests[0] : host} />
                  <Btn icon="pencil" cap="common.edit" title="host.nameEdit" hint="hint-rename" />
                </div>
                <div className={`lr-row-group lr-group-actions ${viewer ? "lr-viewer-actions-slot" : "lr-host-diagnostics-slot"}`}>
                  <Btn icon="gauge" cap="host.details" title="host.details" hint="hint-details" disabled={!live} />
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
                    <span className="lr-toggle" role="group" aria-label={t("host.policy")} data-selected="private">
                      <button type="button" aria-pressed={false}><Glyph name="globe" size={19} /><Cap k="host.policy.open" /></button>
                      <button type="button" className="is-selected" aria-pressed><Glyph name="lock" size={19} /><Cap k="host.policy.private" /></button>
                    </span>
                    <Btn icon="key" cap="join.password" title="host.password.setAction" hint="hint-password" />
                  </RowGroup>
                </Row>
            ) : null}
          </div>
        </main>
      )}
      {chat && <Chat shot={shot} />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
const camera = document.getElementById("camera")!;
const cursor = document.getElementById("cursor")!;
const params = new URLSearchParams(location.search);
const still = params.get("still");
// README stills share the film fixture and product controls, at natural page size.
if (still === "host" || still === "viewer" || still === "picker" || still === "idle") {
  document.documentElement.classList.add("is-still");
  document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
  initTheme(undefined, false);
  setCopy({ lang: params.get("lang") === "zh" ? "zh" : "en", vis: false });
  flushSync(() => root.render(<Screen shot={still} />));
  const paintStill = () => {
    drawGame?.(17.6);
    document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 17600; });
  };
  paintStill();
  requestAnimationFrame(() => requestAnimationFrame(paintStill));
  cursor.setAttribute("hidden", "");
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
let current = "";
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const ease = (n: number) => 1 - (1 - clamp(n)) ** 4;
const cues = {
  mode: 1.5 * BEAT,
  launch: 4 * BEAT,
  share: 1.5 * BEAT,
  source: 4 * BEAT,
  live: 4.5 * BEAT,
  ...INVITE_CUES,
};
type Frame = {
  scene: "desktop" | "launch" | "share" | "invite";
  local: number;
  time: number;
  lang: "en" | "zh-CN";
};
let settling = 0;
// The opaque sandbox cannot persist its sample locale/theme to the real app.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (
    event.source !== parent ||
    data?.type !== "piik-film-ui" ||
    !["desktop", "launch", "share", "invite"].includes(data.scene) ||
    !["en", "zh-CN"].includes(data.lang) ||
    !Number.isFinite(data.time) ||
    !Number.isFinite(data.local)
  )
    return;
  const t = data.local;
  const shot: Shot =
    data.scene === "desktop"
      ? data.scene
      : data.scene === "launch"
      ? t >= cues.launch + BEAT / 2
        ? "idle"
        : t < cues.mode + BEAT / 4
        ? "local"
        : "link"
      : data.scene === "share"
        ? t < cues.share + BEAT / 4
          ? "idle"
          : t < cues.live
            ? "picker"
            : "host"
        : t < cues.copy + BEAT / 4
          ? "host"
          : t < cues.chat ? "copied"
          : t < cues.paste ? "chat"
          : t < cues.send + BEAT / 4 ? "draft"
          : t < cues.viewer ? "sent" : "viewer";
  const key = `${data.lang}:${shot}`;
  if (key !== current) {
    current = key;
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
  drawGame?.(data.time);
  // Product CSS gestures use the film clock, including pause, seek and replay.
  document.getAnimations().forEach((animation) => {
    animation.pause();
    animation.currentTime = data.time * 1000;
  });
  camera.style.transform = "none";
  if (data.scene === "invite" && t >= cues.viewer) {
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
  const center = (element: HTMLElement | null | undefined) => {
    const box = element?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
  };
  let from = { x: 1040, y: 710 };
  let target: ReturnType<typeof center>;
  let moveAt = BEAT / 2, moveFor = BEAT, clickAt = 0, hideAt = 0;
  if (data.scene === "desktop") {
    target = center(document.getElementById("desktop-app"));
    clickAt = 2.5 * BEAT;
    hideAt = 4 * BEAT;
    moveFor = 1.5 * BEAT;
    const press = Math.sin(clamp((t - clickAt) / (BEAT / 2)) * Math.PI);
    document.getElementById("desktop-app")!.style.transform = `scale(${1 - .04 * press})`;
  }
  if (data.scene === "launch") {
    const mode = center(document.querySelectorAll<HTMLElement>('[role="radio"]')[1]);
    target = mode;
    clickAt = cues.mode;
    hideAt = cues.launch + BEAT / 2;
    if (t >= 2 * BEAT && mode) {
      from = mode;
      target = center(document.querySelector<HTMLElement>('button[type="submit"]'));
      moveAt = 2 * BEAT;
      moveFor = 1.5 * BEAT;
      clickAt = cues.launch;
    }
  }
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
