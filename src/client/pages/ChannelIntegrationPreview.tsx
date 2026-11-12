import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { PawnSvg } from "../components/living/Pawn";
import { StageTv } from "../components/living/Stage";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useClipboardResult } from "../ui/use-clipboard-result";
import { ChannelAction } from "../channel/components/ChannelAction";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import "./channel-integration-preview.css";

const botKey = "EXAMPLE_ONLY.room_bot.test_key";
const obsKey = "EXAMPLE_ONLY.whip.input_permit";
const obsEndpoint = "https://inert.example/whip/owned-input";

function ExampleValue({ label, value }: { label: string; value: string }) {
  const { lang } = useCopy(), zh = lang === "zh", clipboard = useClipboardResult(value);
  return <div className="c3-integration-value"><label><span>{label}</span><input className="c3-input" readOnly value={value}
    onFocus={event => event.currentTarget.select()} /></label>
    <ChannelAction icon={clipboard.status === "copied" ? "check" : "copy"} quiet
      label={clipboard.status === "copied" ? (zh ? "已复制" : "Copied") : (zh ? `复制 ${label}` : `Copy ${label}`)} onClick={clipboard.copy} />
    {clipboard.status === "failed" && <small role="status">{zh ? "请选中示例值后手动复制。" : "Select the example value and copy it manually."}</small>}
  </div>;
}

/** Proposed controls only. No Session, network adapter, device or persistent preference. */
export function ChannelIntegrationPreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [panel, setPanel] = useState<"bot" | "obs" | null>(null);
  const [botName, setBotName] = useState("Piik helper");
  const [bot, setBot] = useState<"none" | "active" | "revoked">("none");
  const [showKey, setShowKey] = useState(false), [confirmRevoke, setConfirmRevoke] = useState(false);
  const [botTest, setBotTest] = useState(false);
  const [input, setInput] = useState<"idle" | "waiting" | "live" | "stopped" | "revoked">("idle");
  const close = () => { setPanel(null); setShowKey(false); setConfirmRevoke(false); };
  const permitted = input === "waiting" || input === "live" || input === "stopped";
  const inputLabel = input === "live" ? copy("正在接收示例画面", "Receiving sample picture")
    : input === "waiting" ? copy("等待 OBS 推流", "Waiting for OBS")
      : input === "stopped" ? copy("OBS 已停止，等待重新推流", "OBS stopped; waiting for another stream")
        : input === "revoked" ? copy("输入许可已撤销", "Input permit revoked") : copy("尚未开启 OBS 输入", "OBS input is off");
  return <div className="lr-app c3-integration-preview">
    <AppHeader appControl={null} diagnosticControl={null} />
    <main className="lr-room c3-integration-main">
      <header><p className="c3-integration-design-note" role="note">{copy("交互设计稿，未连接 API", "Interaction proposal — no API connected")}</p>
        <h1>{copy("把你的工具接进来", "Bring your tools along")}</h1>
        <p>{copy("两个入口，各自保持清楚的范围。以下行为是待讨论方案，可点击体验。", "Two entrances with separate scopes. Explore the proposed interactions below.")}</p>
      </header>
      <div className="c3-integration-cards">
        <section className="c3-integration-card">
          <div className="c3-integration-scope"><Glyph name="couch" size={20} /><span>{copy("周五小聚的房间设置", "Settings for Friday with friends")}</span></div>
          <h2>{copy("文字 Bot", "Text bot")}</h2>
          <div className="c3-integration-person"><PawnSvg color="var(--pawn-2)" /><div><strong>{bot === "none" ? copy("给房间添个小帮手", "A little help for this room") : botName}</strong>
            <small>{bot === "active" ? copy("已创建示例身份", "Example identity created") : bot === "revoked" ? copy("已撤销，保留历史作者", "Revoked; historical author retained") : copy("独立名字与身份", "Its own name and identity")}</small></div></div>
          <p>{copy("读取本房间的文字与历史，发送文字回复。房间离线时等待恢复。", "Read this room's text and history, and send text replies. Wait while its host is offline.")}</p>
          <ChannelAction icon="chat" label={bot === "none" ? copy("添加文字 Bot", "Add text bot") : copy("管理 Bot", "Manage bot")}
            onClick={() => { setBotTest(false); setPanel("bot"); }} />
        </section>
        <section className="c3-integration-card">
          <div className="c3-integration-scope"><Glyph name="cast" size={20} /><span>{copy("开始分享时选择画面", "Choose a source when starting a share")}</span></div>
          <h2>OBS / WHIP</h2>
          <StageTv label={copy("OBS 输入预览", "OBS input preview")}>
            <div className={`c3-integration-picture${input === "live" ? " is-live" : ""}`}>
              <Glyph name={input === "live" ? "window" : "cast"} size={38} />
              <span>{input === "live" ? copy("示例节目画面", "Sample program picture") : "OBS"}</span>
            </div>
          </StageTv>
          <p role="status">{inputLabel}</p>
          <ChannelAction icon="cast" label={permitted ? copy("查看输入连接", "View input connection") : copy("使用 OBS 画面", "Use OBS picture")}
            onClick={() => { if (!permitted) setInput("waiting"); setPanel("obs"); }} />
        </section>
      </div>
      <p className="c3-integration-footnote">{copy("建议先做单房间文字 Bot，再做本机 OBS 输入。认证与活动归属尚待确认。", "Suggested order: a text bot for one room, then local OBS input. Authentication and activity ownership remain proposals.")}</p>
    </main>
    {panel === "bot" && <ChannelSettingsDialog title={copy("房间文字 Bot", "Room text bot")} caption={copy("周五小聚的待定方案", "Proposal for Friday with friends")} compact onClose={close}>
      <div className="c3-settings-panels c3-integration-panel">
        <p>{copy("建议由房主添加和撤销。读取此房间已确认的消息与历史，发送新的文字回复；不提供其他房间、管理、媒体或设备权限。", "Proposed: the room owner adds and revokes bots. Read this room's confirmed messages and history, and send new text replies. No access to other rooms, management, media or devices.")}</p>
        {bot !== "active" ? <form onSubmit={event => { event.preventDefault(); if (!botName.trim()) return; setBotName(botName.trim()); setBot("active"); setShowKey(true); setBotTest(false); }}>
          <label>{copy("Bot 名字", "Bot name")}<input className="c3-input" value={botName} maxLength={40} required onChange={event => setBotName(event.target.value)} /></label>
          <ChannelAction icon="plus" primary type="submit" label={copy("创建示例身份与密钥", "Create example identity and key")} disabled={!botName.trim()} />
        </form> : <>
          <div className="c3-integration-person"><PawnSvg color="var(--pawn-2)" /><strong>{botName}</strong></div>
          {showKey ? <><ExampleValue label={copy("Bot 密钥（示例）", "Bot key (example)")} value={botKey} />
            <p>{copy("建议只在创建时显示一次。关闭此面板后隐藏；遗失时撤销并重新创建。", "Proposed one-time display. Closing this panel hides the key; revoke and create again if lost.")}</p></>
            : <p>{copy("密钥已隐藏。示例身份仍保留在本页，刷新后清空。", "Key hidden. This page retains the example identity until refresh.")}</p>}
          <ChannelAction icon="play" quiet label={copy("模拟 /ping 回复", "Simulate /ping reply")} onClick={() => setBotTest(true)} />
          {botTest && <div className="c3-integration-example" role="status"><strong>{botName}</strong><p>Pong! {copy("这是本页示例回复。", "This reply exists only on this page.")}</p></div>}
          <details open={confirmRevoke} onToggle={event => setConfirmRevoke(event.currentTarget.open)}><summary>{copy("撤销 Bot 密钥", "Revoke bot key")}</summary>
            <p>{copy("建议停止此 Bot 的全部连接并禁止旧密钥重连，保留历史消息与作者名字。", "Proposed: stop its connections and reject the old key, while retaining historical messages and attribution.")}</p>
            <ChannelAction icon="x" danger label={copy("确认撤销示例密钥", "Confirm example-key revocation")} onClick={() => { setBot("revoked"); setShowKey(false); setBotTest(false); setConfirmRevoke(false); }} />
          </details>
        </>}
        {bot === "revoked" && <p role="status">{copy("示例密钥已撤销。旧 Bot 不再接收或发送消息。", "Example key revoked. The old bot would no longer receive or send messages.")}</p>}
      </div>
    </ChannelSettingsDialog>}
    {panel === "obs" && <ChannelSettingsDialog title={copy("OBS 本机输入", "Local OBS input")} caption={copy("当前分享页的待定方案", "Proposal for the current sharing page")} compact onClose={close}>
      <div className="c3-settings-panels c3-integration-panel">
        <p>{copy("建议由 Piik App 接收本机 WHIP 推流，作为本页的一个分享源；不会共享桌面或打开麦克风。", "Proposed: Piik App receives local WHIP input as a source for this sharing page. It does not capture the desktop or open a microphone.")}</p>
        <p>{copy("在 OBS 的 WHIP 设置中填写 Server 和 Bearer Token。以下地址与令牌均为不可用示例。", "Enter Server and Bearer Token in OBS WHIP settings. The values below are inert examples.")}</p>
        {permitted && <><ExampleValue label="Server (WHIP)" value={obsEndpoint} /><ExampleValue label="Bearer Token" value={obsKey} /></>}
        <div className="c3-integration-example" role="status"><strong>{inputLabel}</strong>
          <p>{copy("建议：关闭分享页或在 Piik 中取消，都会撤销本次输入许可。只关闭此设置面板不会停止输入。", "Proposed: closing the sharing page or canceling in Piik revokes this permit. Closing these settings keeps the input active.")}</p></div>
        <div className="c3-integration-actions">
          {input === "waiting" && <ChannelAction icon="play" primary label={copy("模拟收到画面", "Simulate incoming picture")} onClick={() => setInput("live")} />}
          {input === "live" && <ChannelAction icon="pause" quiet label={copy("模拟 OBS 停止推流", "Simulate OBS stopping")} onClick={() => setInput("stopped")} />}
          {input === "stopped" && <ChannelAction icon="refresh" label={copy("模拟 OBS 重新推流", "Simulate OBS resuming")} onClick={() => setInput("live")} />}
          {permitted && <ChannelAction icon="stop" danger label={copy("在 Piik 取消输入", "Cancel input in Piik")} onClick={() => setInput("revoked")} />}
          {input === "revoked" && <ChannelAction icon="cast" label={copy("准备新的示例输入", "Prepare another example input")} onClick={() => setInput("waiting")} />}
        </div>
      </div>
    </ChannelSettingsDialog>}
  </div>;
}
