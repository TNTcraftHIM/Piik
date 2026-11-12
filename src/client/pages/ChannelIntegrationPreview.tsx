import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { PawnSvg } from "../components/living/Pawn";
import { StageTv } from "../components/living/Stage";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { useClipboardResult } from "../ui/use-clipboard-result";
import { ChannelAction } from "../channel/components/ChannelAction";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { ChannelExternalInput } from "../channel/components/ChannelExternalInput";
import "./channel-integration-preview.css";

const textCommand = 'node --import tsx prototype/channel-browser/examples/text-participant.ts --url wss://YOUR_SITE/prototype/channel --origin https://YOUR_SITE --room YOUR_ROOM_ID --name "Build notices"';
const textExample = "https://github.com/TNTcraftHIM/Piik/blob/feat/channel-prototype/prototype/channel-browser/examples/README.md";
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

/** Shared integration controls with inert values; no Session or device access. */
export function ChannelIntegrationPreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [panel, setPanel] = useState<"bot" | "obs" | null>(null);
  const [input, setInput] = useState<"idle" | "waiting" | "live" | "stopped" | "revoked">("idle");
  const close = () => setPanel(null);
  const permitted = input === "waiting" || input === "live" || input === "stopped";
  const inputLabel = input === "live" ? copy("正在接收示例画面", "Receiving sample picture")
    : input === "waiting" ? copy("等待 OBS 推流", "Waiting for OBS")
      : input === "stopped" ? copy("OBS 已停止，等待重新推流", "OBS stopped; waiting for another stream")
        : input === "revoked" ? copy("输入许可已撤销", "Input permit revoked") : copy("尚未开启 OBS 输入", "OBS input is off");
  return <div className="lr-app c3-integration-preview">
    <AppHeader appControl={null} diagnosticControl={null} />
    <main className="lr-room c3-integration-main">
      <header><p className="c3-integration-design-note" role="note">{copy("工具接入预览；连接值仅作示例", "Integration preview; connection values are examples")}</p>
        <h1>{copy("把你的工具接进来", "Bring your tools along")}</h1>
        <p>{copy("让独立客户端参与聊天，或使用本机 OBS 分享画面。", "Connect an independent text client, or share pictures from local OBS.")}</p>
      </header>
      <div className="c3-integration-cards">
        <section className="c3-integration-card">
          <div className="c3-integration-scope"><Glyph name="chat" size={20} /><span>{copy("独立客户端", "Independent client")}</span></div>
          <h2>{copy("文字自动化", "Text automation")}</h2>
          <div className="c3-integration-person"><PawnSvg color="var(--pawn-2)" /><div><strong>{copy("给房间添个小帮手", "A little help for your room")}</strong>
            <small>{copy("使用自己的普通用户身份", "Uses its own ordinary user identity")}</small></div></div>
          <p>{copy("在你自己的进程中读取已获准房间的消息与历史，发送通知和回复。", "Read messages and history in rooms your client can access, and send notifications and replies from your own process.")}</p>
          <ChannelAction icon="chat" label={copy("查看接入示例", "View client example")} onClick={() => setPanel("bot")} />
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
          {permitted && <ChannelAction icon={input === "live" ? "pause" : "play"} quiet
            label={input === "live" ? copy("模拟 OBS 停止推流", "Simulate OBS stopping") : copy("模拟收到画面", "Simulate incoming picture")}
            onClick={() => setInput(input === "live" ? "stopped" : "live")} />}
        </section>
      </div>
    </main>
    {panel === "bot" && <ChannelSettingsDialog title={copy("接入文字客户端", "Connect a text client")} caption={copy("使用普通用户身份参与房间", "Join rooms as an ordinary user")} compact onClose={close}>
      <div className="c3-settings-panels c3-integration-panel">
        <p>{copy("在自己的 Node 进程中运行仓库示例。它建立独立用户身份，通过现有聊天接口读取历史、发送消息，并响应新的 !ping 消息。", "Run the repository example in your own Node process. It creates an independent user identity, reads history and sends messages through the existing chat API, and replies to new !ping messages.")}</p>
        <ExampleValue label={copy("示例命令（先替换站点和房间）", "Example command (replace site and room first)")} value={textCommand} />
        <p>{copy("私密房间仍需现有邀请或密码。凭据由外部进程本地管理；此页面不创建身份或密钥。", "Private rooms still require an existing invitation or password. Credentials stay with the external process; this page creates no identity or key.")}</p>
        <p>{copy("示例默认只在内存保留身份。需要恢复同一用户时，按接入说明选择本地身份文件；发送失败会明确返回错误。", "The example keeps its identity in memory by default. To restore the same user, follow the instructions for an optional local identity file. Failed sends return an error.")}</p>
        <a href={textExample} target="_blank" rel="noopener noreferrer">{copy("查看示例与完整接入说明", "Read the example and setup instructions")}</a>
      </div>
    </ChannelSettingsDialog>}
    {panel === "obs" && permitted && <ChannelExternalInput input={{ endpoint: obsEndpoint, token: obsKey, state: input === "live" ? "live" : "waiting" }} busy={false}
      onClose={close} onStop={() => { setInput("revoked"); close(); }} />}
  </div>;
}
