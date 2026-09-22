import { useRef, useState } from "react";
import { Btn, Chip, NameTag, Pill, SwitchItem } from "../components/living/primitives";
import { RoomChip, RoomAdmissionBadge } from "../components/living/RoomChip";
import { CaptureSourcePicker, type NativeSourceList } from "../components/living/CaptureSourcePicker";
import { LedStrip } from "../components/living/Header";
import { StageTv } from "../components/living/Stage";
import { HostMicrophone, HostMicrophoneSettings } from "../components/living/HostMicrophone";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { SharingSettings } from "../components/living/SharingSettings";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { QualityPresets } from "../components/living/QualityPresets";
import { RoomCodeInput } from "../components/living/RoomCodeInput";
import type { QualityProfileId } from "../media/quality";
import type { loadCameraPreviews } from "../media/camera-previews";
import { Tooltip } from "../components/living/Tooltip";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { deriveParticipantStatus } from "../ui/media-status";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { PeoplePreview } from "./PeoplePreview";
import "./controls-preview.css";

const POSTER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e8eee6"/><rect x="100" y="60" width="440" height="240" rx="20" fill="#fffdf6"/><path d="M100 100h440" stroke="#c9d7cf" stroke-width="2"/><circle cx="128" cy="81" r="6" fill="#ed9e65"/><circle cx="320" cy="190" r="46" fill="#65b099"/><path d="m310 191 9 9 16-22" fill="none" stroke="#fffdf6" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;
const SOURCES = { kind: "ready", processAudio: true, systemAudio: true, captureBorderControl: true, sources: [
  { kind: "window", sourceId: "101", pid: 1, creationTime: "1", title: "Sketchbook" },
  { kind: "window", sourceId: "102", pid: 2, creationTime: "2", title: "A short film" },
  { kind: "display", sourceId: "103", title: "Display 1" },
] } satisfies NativeSourceList;
const previewSource = async () => POSTER;
const previewCameras: typeof loadCameraPreviews = async (_signal, publish) => publish([
  { id: "built-in", label: "Built-in camera", preview: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#dce9e5"/><rect x="216" y="16" width="82" height="102" rx="7" fill="#fbfcf3"/><path d="M257 16v102M216 66h82" stroke="#b2cbc2" stroke-width="4"/><path d="M106 147q0-62 54-62t54 62" fill="#449986"/><circle cx="160" cy="57" r="29" fill="#449986"/><path d="M151 55v4m18-4v4" stroke="#203c3a" stroke-width="5" stroke-linecap="round"/><path d="M0 151h320v29H0" fill="#d8b898"/><rect x="232" y="131" width="21" height="23" rx="5" fill="#fff7e9"/></svg>')}` },
  { id: "usb", label: "USB Camera", preview: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#e2c5a8"/><path d="M0 25h320M0 157h320" stroke="#cda987" stroke-width="2"/><rect x="53" y="27" width="163" height="124" rx="5" fill="#fffaf0" transform="rotate(-8 135 89)"/><path d="m97 112 30-35 23 25 18-12 18 19" fill="none" stroke="#689b8a" stroke-width="5" stroke-linejoin="round"/><circle cx="166" cy="57" r="11" fill="#ebbd63"/><path d="m245 64 8 77" stroke="#477b73" stroke-width="7" stroke-linecap="round"/><circle cx="266" cy="35" r="19" fill="#f9f5df"/><circle cx="266" cy="35" r="12" fill="#8c6651"/></svg>')}` },
]);
const previewMicrophones = async () => [{ id: "headset", label: "USB Headset" }, { id: "desk", label: "Desk Microphone" }];

export function ControlsPreview() {
  const { t, lang, vis } = useCopy();
  const en = lang === "en";
  const [sound, setSound] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [microphoneVolume, setMicrophoneVolume] = useState(1);
  const [microphoneDevice, setMicrophoneDevice] = useState("");
  const [sharingSettings, setSharingSettings] = useState(false);
  const [launchMode, setLaunchMode] = useState<AppMode>("link");
  const [launchSite, setLaunchSite] = useState("");
  const [launchPassword, setLaunchPassword] = useState("");
  const [preset, setPreset] = useState<QualityProfileId>("1080p30");
  const [policy, setPolicy] = useState<"open" | "private">("open");
  const [roomPassword, setRoomPassword] = useState(false);
  const [includeCredential, setIncludeCredential] = useState(true);
  const roomLink = `https://piik.example/r/9527${includeCredential ? "#v=preview" : ""}`;
  const [paused, setPaused] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [name, setName] = useState("Piik friend");
  const [invalid, setInvalid] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceState, setSourceState] = useState<NativeSourceList["kind"] | "empty">("ready");
  const [captureBorderAvailable, setCaptureBorderAvailable] = useState(true);
  const [showCaptureBorder, setShowCaptureBorder] = useState(false);
  const [roomCode, setRoomCode] = useState("6020");
  const [feedback, setFeedback] = useState("");
  const [dial, setDial] = useState("60");
  const [theater, setTheater] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const notify = () => setFeedback(en ? "Got it. This is a preview." : "收到，只在预览里演示。" );
  return <>
    <div className="cp-grid" id="control-preview">
      <section id="button-preview" className="cp-card">
        <header><span className="cp-number">01</span><h2>{en ? "Buttons, with a little give" : "按钮，按下去有回应。"}</h2></header>
        <p>{en ? "Hover, press, or use Tab and Enter. The disabled one keeps its explanation." : "悬停、按下，或用 Tab 和回车试试。禁用时也能查看原因。"}</p>
        <div className="cp-tools">
          <Btn icon="cast" tone="primary" title="host.start" cap="host.start" hint="hint-share-start" onClick={notify} />
          <Btn icon="stop" tone="danger" title="host.stop" cap="host.stop" hint="hint-share-stop" onClick={notify} />
          <Btn icon={paused ? "play" : "pause"} title={paused ? "host.resume" : "host.pause"} cap={paused ? "host.resume" : "host.pause"}
            hint={paused ? "hint-resume" : "hint-pause"} draw="preview-pause" pressed={paused} onClick={() => setPaused(!paused)} />
          <Btn icon="gauge" tone="on" title="host.details" cap="host.details" hint="hint-details" pressed onClick={notify} />
          <Btn icon="refresh" title="viewer.reconnect" cap="viewer.reconnect" hint="hint-reconnect" disabled />
          <Btn icon="cast" title="host.starting" cap="host.starting" busy disabled hint="hint-share-start" />
        </div>
        <div className="cp-tools">
          <Btn icon="switchSource" title="host.switchSource" hint="hint-switch-source" onClick={notify} />
          <Btn icon="link" title="host.invite.copy" hint="hint-copy-invite" onClick={notify} />
          <Btn icon="linkOff" title="host.invite.revoke" hint="hint-revoke-invite" onClick={notify} />
          <Btn icon="network" title="host.topology" hint="hint-topology" onClick={notify} />
          <Btn icon="sliders" title="host.advanced" hint="hint-advanced" onClick={notify} />
        </div>
        <div className="lr-host-share-controls lr-media-controls" role="group" aria-label={t("host.shareControls")}>
          <HostMicrophone enabled={microphone} paused={paused} volume={microphoneVolume}
            onToggle={() => setMicrophone(value => !value)} />
          <Btn icon={paused ? "play" : "pause"} title={paused ? "host.resume" : "host.pause"} cap={paused ? "host.resume" : "host.pause"}
            hint={paused ? "hint-resume" : "hint-pause"} onClick={() => setPaused(!paused)} />
          <Btn icon="switchSource" title="host.switchSource" cap="host.switchSource" hint="hint-switch-source" onClick={notify} />
          <Btn icon="sliders" cap="host.settings.button" title={sharingSettings ? "host.advanced.hide" : "host.advanced"}
            hint={sharingSettings ? "hint-collapse" : "hint-advanced"} tone={sharingSettings ? "on" : undefined}
            expanded={sharingSettings} controls="preview-sharing-settings" onClick={() => setSharingSettings(value => !value)} />
          <Btn id="host-stop-share" icon="stop" tone="danger" title="host.stop" cap="host.stop" hint="hint-share-stop" onClick={notify} />
        </div>
        <SharingSettings id="preview-sharing-settings" open={sharingSettings}
          presets={<QualityPresets selected={preset} onSelect={setPreset} />}
          audio={<HostMicrophoneSettings deviceId={microphoneDevice} onDevice={setMicrophoneDevice} loadDevices={previewMicrophones}
            native enabled={microphone} disabled={paused} volume={microphoneVolume} onVolume={setMicrophoneVolume} />}
        />
      </section>
      <section id="option-preview" className="cp-card">
        <header><span className="cp-number">02</span><h2>{en ? "Pick, toggle, adjust" : "选一个，再拨一下。"}</h2></header>
        <div className="cp-tools">
          <SwitchItem checked={sound} onChange={setSound} label={t("host.sourcePicker.audioOn")} hint="hint-share-audio" />
          <SwitchItem checked disabled locked onChange={() => undefined} label={t("host.advanced.route.peerOnly")}
            note={t("host.advanced.route.peerOnlyRequired")} hint="hint-route-p2p-required" />
        </div>
        <div className="cp-tools">
          <span className="lr-toggle" role="group" aria-label={t("host.policy")} data-selected={policy}>
            {(["open", "private"] as const).map(value => <Tooltip key={value} kind={value === "open" ? "hint-admission-code" : "hint-policy-private"}
              text={vis ? undefined : `${t(`host.policy.${value}`)} · ${t(value === "private" && roomPassword ? "host.policy.privatePasswordHint" : `host.policy.${value}Hint`)}`}>
              <button type="button" className={policy === value ? "is-selected" : undefined} aria-pressed={policy === value}
                aria-label={t(`host.policy.${value}`)} onClick={() => setPolicy(value)}>
                <Glyph name={value === "open" ? "globe" : "lock"} size={19} />{vis ? null : <span className="lr-cap">{t(`host.policy.${value}`)}</span>}
              </button></Tooltip>)}
          </span>
          <SwitchItem checked={roomPassword} onChange={setRoomPassword} label={t("host.password.set")} />
        </div>
        <div className="cp-tools">
          <RoomAdmissionBadge policy="open" passwordEnabled={false} />
          <RoomAdmissionBadge policy="private" passwordEnabled />
          <RoomAdmissionBadge policy="private" passwordEnabled={false} />
        </div>
        <div className="lr-invite-field">
          <Tooltip kind="hint-invite-link" text={roomLink} className="lr-invite-hint">
            <input className="lr-invite-url" readOnly dir="ltr" value={roomLink}
              aria-label={t(includeCredential ? "host.invite" : "host.invite.address")} />
          </Tooltip>
          <span className="lr-row-group"><Glyph name="key" size={17} />
            <SwitchItem checked={includeCredential} onChange={setIncludeCredential}
              label={t("host.invite.includeCredential")} note={t("host.invite.credentialHint")} hint="hint-invite-link" />
          </span>
        </div>
        {!includeCredential && policy === "private" && !roomPassword ? <Pill icon="lock" tone="warn"
          comic="hint-policy-private" label={t("host.invite.credentialRequired")} /> : null}
      </section>
      <section id="input-preview" className="cp-card">
        <header><span className="cp-number">03</span><h2>{en ? "Names, codes and small details" : "名字、房间号，还有小细节。"}</h2></header>
        <div className="cp-tools"><NameTag name={name || "Piik friend"} identity="preview-name" />
          <label className="lr-input"><Glyph name="pencil" size={17} /><input value={name} aria-label={t("host.name")}
            autoComplete="off" onChange={event => setName(event.target.value)} /></label>
        </div>
        <div className="cp-tools">
          <label className="lr-input is-password"><Glyph name="key" size={17} /><input type={passwordVisible ? "text" : "password"}
            placeholder={t("join.password")} aria-label={t("join.password")} aria-invalid={invalid} aria-describedby={invalid ? "preview-input-error" : undefined} autoComplete="off" />
          </label>
          <Btn icon={passwordVisible ? "eyeOff" : "eye"} title={passwordVisible ? "host.password.hide" : "host.password.show"}
            pressed={passwordVisible} hint={passwordVisible ? "hint-password-hide" : "hint-password-show"} onClick={() => setPasswordVisible(!passwordVisible)} />
          <SwitchItem checked={invalid} onChange={setInvalid} label={en ? "Show error" : "看看错误态"} />
        </div>
        {invalid ? <p id="preview-input-error" className="cp-input-error" role="alert">{en ? "That password did not match. Try again." : "密码没对上，再试一次。"}</p> : null}
        <div className="cp-tools"><RoomChip roomId={roomCode} onReplace={() => setRoomCode(code => code === "6020" ? "2048" : "6020")} /></div>
        <RoomCodeInput value={dial} onChange={setDial} />
      </section>
      <section id="feedback-preview" className="cp-card">
        <header><span className="cp-number">04</span><h2>{en ? "Clear feedback" : "每种反馈，都说清楚。"}</h2></header>
        <div className="cp-tools">
          <LedStrip state="live" label={t("state.signal.connected")} comic="signal-connected" />
          <LedStrip state="busy" label={t("state.signal.connecting")} comic="signal-connecting" />
          <LedStrip state="off" label={t("state.signal.offline")} comic="signal-offline" />
        </div>
        <div className="cp-tools"><Pill icon="check" tone="live" label={t("common.copied")} comic="hint-copy-code" />
          <Pill icon="lock" label={t("host.advanced.route.peerOnlyRequired")} comic="hint-route-p2p-required" />
          <Pill icon="alert" tone="bad" label={t("common.copyFailed")} comic="warning" /></div>
        <div className="cp-tools"><StatusIndicator status={deriveParticipantStatus({ upstream: { kind: "peer", peerId: "preview" }, mediaReady: true }, true)} />
          <StatusIndicator status={deriveParticipantStatus({ upstream: { kind: "none" } }, true)} />
        </div>
        <p className="cp-feedback" aria-live="polite">{feedback || (en ? "Button feedback appears here." : "点一下上面的按钮，回应会出现在这里。")}</p>
      </section>
    </div>
    <PeoplePreview />
    <section id="source-preview" className="cp-section">
      <header className="cp-section-head"><span className="cp-number">06</span><div><h2>{en ? "Choose a picture" : "挑一块画面。"}</h2>
        <p>{en ? "The actual source selector, with sample windows and cameras. Selection only updates this preview." : "正式的画面选择器，放入了示例窗口和摄像头；选择只影响这张预览。"}</p></div></header>
      <div className="cp-tools">{(["ready", "loading", "unavailable", "incompatible", "unsupported", "failed", "empty"] as const).map((value, index) => <Chip key={value}
        title={value} selected={sourceState === value} onClick={() => { setSourceState(value); setSourceOpen(true); }}>
        {en ? ["Available", "Loading", "App unavailable", "Update needed", "Capture unavailable", "Read failed", "Empty list"][index] : ["正常", "读取中", "App 未连接", "需要更新", "无法采集", "读取失败", "空列表"][index]}</Chip>)}
        <SwitchItem checked={captureBorderAvailable} onChange={setCaptureBorderAvailable}
          label={en ? "Windows border control" : "Windows 边框控制"} />
      </div>
      <div className="cp-stage"><StageTv hasEntry label={t("host.sourcePicker.title")}>
        <img className="cp-poster" src={POSTER} alt="" />
        {sourceOpen ? <CaptureSourcePicker nativeSources={sourceState === "empty" ? { ...SOURCES, sources: [], captureBorderControl: captureBorderAvailable }
          : sourceState === "ready" ? { ...SOURCES, captureBorderControl: captureBorderAvailable } : { kind: sourceState }}
          initialShowCaptureBorder={showCaptureBorder}
          onBrowser={() => { setSourceOpen(false); notify(); }}
          onCamera={() => { setSourceOpen(false); notify(); }}
          loadCameras={previewCameras}
          onNative={(_target, _audio, showBorder) => { setShowCaptureBorder(showBorder); setSourceOpen(false); notify(); }}
          onPreview={previewSource} onRefresh={() => setSourceState("ready")} onCancel={() => setSourceOpen(false)} />
          : <div className="cp-stage-action"><Btn icon="cast" tone="primary" title="host.start" cap="host.start" hint="hint-share-start" onClick={() => setSourceOpen(true)} /></div>}
      </StageTv></div>
    </section>
    <section id="playback-preview" className="cp-section">
      <header className="cp-section-head"><span className="cp-number">07</span><div><h2>{en ? "The playback bar" : "播放时，顺手就能找到。"}</h2>
        <p>{en ? "This bar shows its waiting state. The playback test page includes a moving picture, volume and picture in picture." : "这里展示等待画面时的播放栏；动态画面、音量和小窗可进入完整播放预览试用。"}</p></div></header>
      <div className="cp-stage"><StageTv label={t("playback.controls")}><video ref={video} poster={POSTER} playsInline />
        <PlaybackControls videoRef={video} stream={null} canPlay={false} theaterMode={theater} onPlay={notify}
          onToggleTheater={() => setTheater(!theater)} onReconnect={notify} reconnectAvailable />
      </StageTv></div>
      <p><a href="/__playback-preview">{en ? "Open the full playback preview" : "进入完整播放预览"} →</a></p>
    </section>
    <section id="launcher-preview" className="cp-section">
      <header className="cp-section-head"><span className="cp-number">08</span><h2>{t("client.launch.title")}</h2></header>
      <div className="lr-client-launch">
        <LauncherForm mode={launchMode} onModeChange={setLaunchMode}
          site={launchSite} onSiteChange={setLaunchSite}
          localAccessPassword={launchPassword} onLocalAccessPasswordChange={setLaunchPassword}
          onSubmit={event => event.preventDefault()} />
      </div>
    </section>
  </>;
}
