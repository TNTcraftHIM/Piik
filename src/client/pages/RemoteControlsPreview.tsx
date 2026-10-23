import { useCallback, useState } from "react";
import { HostRemoteControl } from "../components/living/HostRemoteControl";
import { RemoteControlRequestCard } from "../components/living/RemoteControlRequestCard";
import { RemoteKeyboard } from "../components/living/RemoteKeyboard";
import { Couch } from "../components/living/Couch";
import { STATUS_CATALOG } from "../ui/media-status";
import { Btn } from "../components/living/primitives";
import type { RemoteControlRequest } from "../native/wire";
import type { RemoteInputEvent } from "../remote-control/input-session";
import type { RemoteControlMode, RemoteInputPlatform } from "../remote-control/protocol";
import { useCopy } from "../ui/copy";

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
  const { lang } = useCopy();
  const en = lang === "en";
  const [state, setState] = useState<"ready" | "pending" | "active">("pending");
  const title = state === "active" ? "remote.stop" : state === "pending" ? "remote.cancel" : "remote.request";
  return <section id="remote-permission-preview" className="cp-section">
    <header className="cp-section-head"><div>
      <h2>{en ? "Request remote control" : "权限申请"}</h2>
      <p>{en ? "One request for remote control. These production controls use sample state here and do not operate your computer."
        : "一次申请远程控制权限。这里用正式控件演示，不会操作你的电脑。"}</p>
    </div></header>
    <div className="cp-permission-flow">
      <section className="cp-card cp-permission-viewer" aria-label={en ? "Viewer" : "观众端"}>
        <header><h3>{en ? "Viewer" : "观众端"}</h3></header>
        <p>{en ? "Request control, then use your keyboard, mouse and supported gamepad once approved."
          : "点击申请，获准后即可使用键鼠和可用的手柄。"}</p>
        <div className="cp-tools lr-media-controls">
          <Btn icon="mouse" cap={title} title={title}
            hint={state === "ready" ? "hint-remote-control" : "hint-remote-stop"}
            pressed={state === "active"} busy={state === "pending"}
            onClick={() => setState(state === "ready" ? "pending" : "ready")} />
        </div>
      </section>
      <section className="cp-card lr-remote-panel cp-permission-host" aria-label={en ? "Host" : "房主端"}>
        <header><h3>{en ? "Host" : "房主端"}</h3></header>
        {state !== "ready" ? <RemoteControlRequestCard name="Player 1" peerId="preview-player-one" state={state}
          onAllow={() => setState("active")}
          onDecline={() => setState("ready")} onStop={() => setState("ready")} />
          : <p>{en ? "Waiting for a request." : "等待权限申请。"}</p>}
      </section>
    </div>
    <div className="cp-tools"><button type="button" className="lr-btn is-compact" onClick={() => setState("pending")}>
      {en ? "Reset example" : "重置示例"}</button>
      <span className="cp-permission-caption">{en ? "Try allowing, declining or ending control." : "可以试试允许、拒绝和结束控制。"}</span>
    </div>
  </section>;
}
