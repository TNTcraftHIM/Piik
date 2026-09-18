import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppHeader } from "../../components/living/Header";
import { Couch } from "../../components/living/Couch";
import { StageTv } from "../../components/living/Stage";
import { PawnSvg } from "../../components/living/Pawn";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { STATUS_CATALOG } from "../../ui/media-status";
import { InteractionSession } from "./session";
import { interactionCopy } from "./copy";
import { propKeys, roomCode } from "./protocol";
import { PropArt, PropEffects } from "./Props";
import "./interactions.css";

function DeviceIcon({ camera = false, off = false }: { camera?: boolean; off?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {camera ? <><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10 5-3v10l-5-3" /></>
      : <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>}
    {off ? <path d="m3 3 18 18" /> : null}
  </svg>;
}

function StreamElement({ stream, muted, playLabel }: {
  stream: MediaStream; muted: boolean; playLabel: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = ref.current!;
    let active = true;
    setBlocked(false);
    element.srcObject = stream;
    void element.play().catch(() => { if (active) setBlocked(true); });
    return () => { active = false; element.pause(); element.srcObject = null; };
  }, [stream]);
  return <>
    <video ref={ref} autoPlay playsInline muted={muted} className="ip-camera" />
    {blocked ? <button type="button" className="lr-btn is-primary ip-play" onClick={() => {
      // Call play in the user gesture; mobile browsers may reject an effect later.
      const element = ref.current!;
      void element.play().then(() => { if (element.srcObject === stream) setBlocked(false); }).catch(() => {});
    }}><Glyph name="play" />{playLabel}</button> : null}
  </>;
}

function PreviewScene() {
  return <div className="ip-scene" aria-hidden="true">
    <svg viewBox="0 0 800 450" preserveAspectRatio="xMidYMid slice">
      <rect width="800" height="450" fill="#c2dfdd" />
      <circle cx="615" cy="88" r="38" fill="#f8e7af" />
      <path d="M0 277 140 122 287 285 401 115 610 301 735 177 860 292V450H0" fill="#90bfb3" />
      <path d="m339 186 62-71 80 103-56-25-28 13-26-30Z" fill="#e8f2e8" />
      <path d="M0 303Q210 220 424 321T800 277V450H0" fill="#679986" />
      <path d="M0 362Q251 274 445 372T800 355V450H0" fill="#4e7d67" />
      <path d="M350 450q100-42 40-95t89-55" stroke="#ddc48d" strokeWidth="37" fill="none" />
      <g fill="#315b50"><path d="m82 324 32-101 32 101Z" /><path d="m668 357 36-115 38 115Z" /></g>
      <g fill="#e4e1b3"><circle cx="205" cy="359" r="3" /><circle cx="237" cy="339" r="3" /><circle cx="534" cy="396" r="3" /></g>
      <g className="ip-cloud" fill="#f7faf0" opacity=".8"><rect x="101" y="72" width="109" height="14" rx="7" /><rect x="140" y="59" width="45" height="22" rx="11" /></g>
    </svg>
    <div className="ip-scene-pawn"><PawnSvg color="#a8c3e8" identity="7fa9d8c1-3d81-4d65-93b4-c3137e376aaa" /></div>
  </div>;
}

export function InteractionPreviewPage() {
  const { lang } = useCopy();
  const c = interactionCopy(lang);
  const [session] = useState(() => new InteractionSession());
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [room, setRoom] = useState(() => roomCode.safeParse(new URLSearchParams(location.search).get("room")).data ?? "9527");
  const [name, setName] = useState(() => new URLSearchParams(location.search).get("friend") ? (lang === "zh" ? "阿强" : "Player Two") : (lang === "zh" ? "摸鱼王" : "Player One"));
  const [entered, setEntered] = useState(false);
  const [targetId, setTarget] = useState<string | null>(null);
  const [effects, setEffects] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [outputMuted, setOutputMuted] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => () => session.close(), [session]);
  const self = state.members.find((member) => member.id === state.self);
  const host = state.members.find((member) => member.role === "host");
  const isHost = host?.id === state.self;
  const target = state.members.find((member) => member.id === targetId)
    ?? state.members.find((member) => member.id !== state.self) ?? self;
  const sourceKind = isHost ? state.source.kind : host?.source;
  const sharing = state.online && !!sourceKind;
  const sharedStream = isHost ? state.source.stream
    : sourceKind ? state.media.remotes.find((remote) => remote.id === host?.id)?.stream : null;
  const invitation = new URL("/__interaction-preview", location.origin);
  invitation.searchParams.set("room", room);
  invitation.searchParams.set("friend", "1");
  const connect = () => {
    if (!name.trim() || !roomCode.safeParse(room).success) return;
    session.connect(room, name.trim()); setEntered(true);
  };
  const error = state.error ?? (copyFailed ? "clipboard" : null);
  const control = (action: () => void, icon: ReactNode, label: string, active?: boolean, disabled = false) =>
    <button type="button" className={`lr-btn${active ? " is-on" : ""}`} onClick={action} aria-pressed={active} disabled={disabled}>{icon}<span>{label}</span></button>;

  return <div className="lr-app ip-app">
    <AppHeader homeHref="/__interaction-preview" />
    <main className="ip-main">
      <header className="ip-heading"><div><span className="ip-eyebrow">{c.badge}</span><h1>{c.title}</h1><p>{c.subtitle}</p></div>
        <div className="ip-room-code"><span>{c.room}</span><b>{room}</b><small><i className={state.online ? "is-online" : ""} />{state.online ? c.connected : entered ? c.notConnected : "Piik"}</small></div>
      </header>
      {!entered ? <form className="ip-entry" onSubmit={(event) => { event.preventDefault(); connect(); }}>
        <label>{c.name}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} required autoComplete="off" /></label>
        <label>{c.room}<input value={room} onChange={(event) => setRoom(event.target.value)} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required /></label>
        <button className="lr-btn is-primary" type="submit"><Glyph name="door" />{c.enter}</button>
      </form> : <div className="ip-room-actions">
        <a className="lr-btn" href={invitation.href} target="_blank" rel="noopener" title={c.inviteHint}><Glyph name="users" />{c.invite}</a>
        {control(() => { void navigator.clipboard.writeText(invitation.href).then(() => { setCopied(true); setCopyFailed(false); }).catch(() => setCopyFailed(true)); }, <Glyph name={copied ? "check" : "copy"} />, copied ? c.copied : c.copy)}
        {control(() => { session.close(); setEntered(false); setTarget(null); }, <Glyph name="door" />, c.leave)}
      </div>}

      {error ? <div className="ip-error" role="alert"><Glyph name="alert" />
        <span>{c.errors[error as keyof typeof c.errors] ?? c.errors.invalid}</span>
        {!state.online && entered ? <button type="button" className="lr-btn" onClick={connect}>{c.retry}</button> : null}
        <button type="button" className="ip-dismiss" aria-label={c.close} onClick={() => { session.clearError(); setCopyFailed(false); }}><Glyph name="x" /></button>
      </div> : null}

        <section className="ip-living-room" ref={area}>
          <StageTv live={!!sharedStream} label={c.stage} indicator={<span className="ip-stage-caption">{sharedStream ? sourceKind === "camera" ? c.cameraStage : c.displayStage : c.demoStage}</span>}>
            {sharedStream ? <StreamElement stream={sharedStream} muted={isHost || outputMuted} playLabel={c.playAudio} /> : <PreviewScene />}
          </StageTv>
          <div className="ip-media-controls">
            {isHost ? <>
              {control(() => { session.clearError(); void session.source.share("display"); }, <Glyph name="share" />,
                state.source.pending === "display" ? c.displayPending : c.display, sourceKind === "display", !!state.source.pending || !navigator.mediaDevices?.getDisplayMedia)}
              {control(() => { session.clearError(); void session.source.share("camera"); }, <DeviceIcon camera />,
                state.source.pending === "camera" ? c.cameraPending : c.camera, sourceKind === "camera", !!state.source.pending)}
              {control(() => { session.clearError(); void session.source.toggleMicrophone(); }, <DeviceIcon off={!state.source.mic} />,
                state.source.pending === "microphone" ? c.micPending : state.source.mic ? c.micOff : c.micOn, state.source.mic, !sourceKind || !!state.source.pending)}
              {sourceKind || state.source.pending ? control(() => session.source.stop(), <Glyph name="stop" />, c.stopShare) : null}
            </> : null}
            {sharing && !isHost ? control(() => setOutputMuted((muted) => !muted),
              <Glyph name={outputMuted ? "speakerOff" : "speaker"} />, outputMuted ? c.unmuteOutput : c.muteOutput) : null}
          </div>
          {state.online ? <p className="ip-media-status" role="status">{!isHost && sourceKind && state.media.remotes.some((remote) => remote.state === "connecting" || remote.state === "new")
            ? c.connectingMedia : !sourceKind ? isHost ? c.chooseSource : c.waitingHost : host?.mic ? c.hostMicOn : c.hostMicOff}</p> : null}
          <div className="ip-toggles">
            <label><input type="checkbox" checked={effects} onChange={(event) => setEffects(event.target.checked)} />{c.effects}</label></div>
          <Couch view="viewer" host={host ? { key: host.id, name: host.name, you: isHost,
            selected: target?.id === host.id, onSelect: () => setTarget(host.id) } : null}
            entries={state.members.filter((member) => member.role === "viewer").map((member) => ({ key: member.id, name: member.name, you: member.id === state.self,
              status: STATUS_CATALOG.connected }))}
            selectedKey={target?.id} onSelect={setTarget} />
          <div className="ip-props"><span>{!sharing ? c.propsWaiting : target ? `${c.target} ${target.name}${target.id === state.self ? ` · ${c.you}` : ""}` : c.select}</span>
            <div>{propKeys.map((prop) => <button type="button" className="ip-prop-button" key={prop} disabled={!sharing || !target}
              onClick={() => { if (target) session.send({ type: "prop", target: target.id, prop }); }}><PropArt kind={prop} /><span>{c[prop]}</span></button>)}</div>
          </div>
          <PropEffects session={session} area={area} enabled={effects && sharing} />
        </section>
      <footer className="ip-notes"><p>{c.guide}</p><p>{c.prototype}</p><small>{c.cameraHint}</small></footer>
    </main>
  </div>;
}
