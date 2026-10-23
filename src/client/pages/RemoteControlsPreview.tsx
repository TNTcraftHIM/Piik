import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HostRemoteControl } from "../components/living/HostRemoteControl";
import { RemoteControl } from "../components/living/RemoteControl";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { StageTv } from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { RemoteKeyboard } from "../components/living/RemoteKeyboard";
import { Couch } from "../components/living/Couch";
import { STATUS_CATALOG } from "../ui/media-status";
import { Btn } from "../components/living/primitives";
import type { RemoteControlRequest } from "../native/wire";
import type { RemoteInputEvent } from "../remote-control/input-session";
import type { RemoteControlMode, RemoteInputPlatform } from "../remote-control/protocol";
import { useCopy } from "../ui/copy";
import { testMedia } from "./PlaybackPreviewPage";
import { PreviewInput } from "./preview-input";

const participants = [
  { peerId: "preview-player-one", name: "Player 1" },
  { peerId: "preview-player-two", name: "Player 2" },
  { peerId: "preview-gamepad", name: "Player 3" },
];

export function RemoteControlsPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [platform, setPlatform] = useState<RemoteInputPlatform>("windows");
  const [mode, setMode] = useState<RemoteControlMode>("off");
  const [simultaneous, setSimultaneous] = useState(false);
  const [requests, setRequests] = useState<(RemoteControlRequest & { name: string })[]>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [lastInput, setLastInput] = useState("");
  const [releaseKey, setReleaseKey] = useState(10);
  const [stopKey, setStopKey] = useState(10);
  const shortcut = useCallback(async (key?: number) => {
    if (key !== undefined) setStopKey(key);
    return { key: key ?? stopKey, available: true };
  }, [stopKey]);
  const input = useCallback((event: RemoteInputEvent) => setLastInput(JSON.stringify(event)), []);
  const closeKeyboard = () => {
    setKeyboardOpen(false);
    document.getElementById("preview-remote-keyboard-toggle")?.focus();
  };

  return <><PermissionRequestPreview /><section id="remote-control-preview" className="cp-section">
    <header className="cp-section-head"><div>
      <h2>{t("remote.title")}</h2>
      <p>{en ? "Actual permission panel and keyboard, with local sample state. Key presses only appear below; they are not sent to an App or operating system."
        : "正式的授权浮窗与虚拟键盘，使用本地示例状态。按键只在下方显示，不发送到 App 或操作系统。"}</p>
    </div></header>
    <div className="cp-tools">
      <label className="lr-input"><span>{en ? "Host platform" : "房主平台"}</span>
        <select value={platform} onChange={event => setPlatform(event.target.value as RemoteInputPlatform)}>
          <option value="windows">Windows</option><option value="darwin">macOS</option><option value="linux">Linux</option>
        </select>
      </label>
      <HostRemoteControl mode={mode} platform={platform} requests={requests}
        gamepad={platform !== "darwin"}
        simultaneous={simultaneous}
        onSimultaneous={async enabled => { setSimultaneous(enabled); setRequests([]); }}
        onShortcut={platform === "linux" ? undefined : shortcut}
        onPolicy={async value => { setMode(value); setRequests([]); }}
        onDecide={async (id, allow) => setRequests(current => allow
          ? current.map(request => request.id === id ? { ...request, state: "active" } : request)
          : current.filter(request => request.id !== id))} />
      <button type="button" className="lr-btn" onClick={() => {
        setMode("ask");
        setRequests([{ id: "preview-request", ...participants[0]!, state: "pending" }]);
      }}>{en ? "Receive a sample request" : "模拟收到控制请求"}</button>
      <button type="button" className="lr-btn" onClick={() => {
        setMode("ask");
        setSimultaneous(true);
        setRequests([
          { id: "preview-player-one", peerId: "preview-player-one", state: "active", name: "Player 1" },
          { id: "preview-player-two", peerId: "preview-player-two", state: "active", name: "Player 2" },
          { id: "preview-gamepad", peerId: "preview-gamepad", state: "pending", name: "Player 3" },
        ]);
      }}>{en ? "Simulate multiple controllers" : "模拟多人控制"}</button>
      <Btn id="preview-remote-keyboard-toggle" icon="keyboard" title="remote.keyboard" cap="remote.keyboard" hint="hint-remote-keyboard"
        expanded={keyboardOpen} controls="preview-remote-keyboard" onClick={() => setKeyboardOpen(value => !value)} />
    </div>
    <Couch view="host" host={{ key: "preview-host", name: "Piik", you: true }}
      entries={participants.map(person => {
        const grant = requests.find(request => request.peerId === person.peerId && request.state !== "pending");
        return { key: person.peerId, name: person.name, status: STATUS_CATALOG.connected, selectable: false,
          collaboration: Boolean(grant) };
      })} />
    <div id="preview-remote-keyboard" className="cp-keyboard" hidden={!keyboardOpen}>
      {keyboardOpen && <RemoteKeyboard key={platform} platform={platform} touch={false} input={input} close={closeKeyboard}
        allowText={requests.filter(request => request.state !== "pending").length < 2}
        releaseKey={releaseKey} onReleaseKeyChange={setReleaseKey} />}
    </div>
    <p className="cp-input-output"><span>{en ? "Latest input" : "最近一次输入"}</span>
      <output>{lastInput || (en ? "Open the keyboard to try it." : "打开键盘即可试用。")}</output>
    </p>
  </section></>;
}

function PermissionRequestPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [channel] = useState(() => new PreviewInput());
  const state = useSyncExternalStore(channel.subscribe, channel.getSnapshot);
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [theater, setTheater] = useTheaterMode();
  useEffect(() => {
    const sample = testMedia(false, false);
    const element = video.current!;
    element.srcObject = sample.stream;
    setStream(sample.stream);
    void element.play().catch(() => {});
    return () => { element.srcObject = null; sample.stop(); };
  }, []);
  const hasRequest = state.state === "pending" || state.state === "active" || state.state === "suspended";
  return <section id="remote-permission-preview" className="cp-section">
    <header className="cp-section-head"><div>
      <h2>{en ? "Request remote control" : "权限申请"}</h2>
      <p>{en ? "Use the mouse button in the playback bar, then handle the request in the Host's remote-control window. The local sample picture does not control your computer."
        : "点击播控上的鼠标按钮，再到房主的远控浮窗处理请求。这里是本地示例画面，不会操作电脑。"}</p>
    </div></header>
    <div className="cp-permission-flow">
      <div className={theater ? "lr-room is-theater" : "cp-permission-viewer"}>
        <div className="lr-scene">
          <StageTv live={Boolean(stream)} label={en ? "Viewer picture" : "观众画面"}
            indicator={<StatusIndicator status={stream ? STATUS_CATALOG.connected : STATUS_CATALOG.joining} />}>
            <video ref={video} muted playsInline aria-label={en ? "Local sample picture" : "本地示例画面"} />
            <PlaybackControls videoRef={video} stream={stream} canPlay={Boolean(stream)} theaterMode={theater}
              onPlay={() => { void video.current?.play().catch(() => {}); }} onToggleTheater={() => setTheater(value => !value)}
              onReconnect={() => channel.reset()} reconnectAvailable={false}
              remoteActions={<RemoteControl channel={channel} videoRef={video} available />} />
          </StageTv>
        </div>
      </div>
      <aside className="cp-permission-host" aria-label={en ? "Host" : "房主侧"}>
        <h3>{en ? "Host" : "房主侧"}</h3>
        <HostRemoteControl mode={state.mode} platform="windows"
          requests={hasRequest ? [{ id: "preview-request", name: "Player 1", peerId: "preview-player-one", state: state.state as "pending" | "active" | "suspended" }] : []}
          onPolicy={async (mode, password) => channel.policy(mode, password)} onDecide={async (_id, allow) => channel.decide(allow)} />
        <p>{hasRequest ? t(state.state === "pending" ? "remote.waiting" : "remote.controlling") : en ? "Waiting for a request." : "等待权限申请。"}</p>
      </aside>
    </div>
    <div className="cp-tools"><button type="button" className="lr-btn is-compact" onClick={() => channel.policy("ask")}>
      {en ? "Reset example" : "重置示例"}</button>
      <span className="cp-permission-caption">{en ? "Hover the picture to reveal its normal playback controls." : "鼠标移入画面，即可呼出正式播控。"}</span>
    </div>
  </section>;
}
