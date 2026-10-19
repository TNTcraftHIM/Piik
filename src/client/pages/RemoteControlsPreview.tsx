import { useCallback, useState } from "react";
import { HostRemoteControl } from "../components/living/HostRemoteControl";
import { RemoteKeyboard } from "../components/living/RemoteKeyboard";
import { Btn } from "../components/living/primitives";
import type { RemoteControlRequest } from "../native/wire";
import type { RemoteInputEvent } from "../remote-control/input-session";
import type { RemoteControlMode, RemoteInputPlatform } from "../remote-control/protocol";
import { useCopy } from "../ui/copy";

export function RemoteControlsPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [platform, setPlatform] = useState<RemoteInputPlatform>("windows");
  const [mode, setMode] = useState<RemoteControlMode>("off");
  const [requests, setRequests] = useState<(RemoteControlRequest & { name: string })[]>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [lastInput, setLastInput] = useState("");
  const input = useCallback((event: RemoteInputEvent) => setLastInput(JSON.stringify(event)), []);
  const closeKeyboard = () => {
    setKeyboardOpen(false);
    document.getElementById("preview-remote-keyboard-toggle")?.focus();
  };

  return <section id="remote-control-preview" className="cp-section">
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
        onPolicy={async value => { setMode(value); setRequests([]); }}
        onDecide={async (id, allow) => setRequests(current => allow
          ? current.map(request => request.id === id ? { ...request, state: "active" } : request)
          : current.filter(request => request.id !== id))} />
      <button type="button" className="lr-btn" onClick={() => {
        setMode("ask");
        setRequests([{ id: "preview-request", peerId: "preview-friend", state: "pending", name: "Piik friend" }]);
      }}>{en ? "Receive a sample request" : "模拟收到控制请求"}</button>
      <Btn id="preview-remote-keyboard-toggle" icon="keyboard" title="remote.keyboard" cap="remote.keyboard" hint="hint-remote-keyboard"
        expanded={keyboardOpen} controls="preview-remote-keyboard" onClick={() => setKeyboardOpen(value => !value)} />
    </div>
    <div id="preview-remote-keyboard" className="cp-keyboard" hidden={!keyboardOpen}>
      {keyboardOpen && <RemoteKeyboard key={platform} platform={platform} touch={false} input={input} close={closeKeyboard} />}
    </div>
    <p className="cp-input-output"><span>{en ? "Latest input" : "最近一次输入"}</span>
      <output>{lastInput || (en ? "Open the keyboard to try it." : "打开键盘即可试用。")}</output>
    </p>
  </section>;
}
