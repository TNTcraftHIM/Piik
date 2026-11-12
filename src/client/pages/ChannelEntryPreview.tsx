import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { ChannelSiteEntry } from "../channel/components/ChannelSiteEntry";
import { channelErrorPresentation } from "../channel/error-presentation";
import { useCopy } from "../ui/copy";

const cases = [
  { value: "connecting", zh: "连接中", en: "Connecting", error: null },
  { value: "offline", zh: "连接断开", en: "Disconnected", error: "disconnected" },
  { value: "capacity", zh: "连接已满", en: "Connection limit", error: "channel_full" },
  { value: "runtime", zh: "组件加载失败", en: "Components unavailable", error: "room_runtime_unavailable" },
  { value: "version", zh: "版本不兼容", en: "Incompatible version", error: "incompatible_protocol" },
  { value: "identity", zh: "身份未被接受", en: "Identity rejected", error: "invalid_credential" },
  { value: "browser", zh: "浏览器不支持", en: "Browser unsupported", error: "webassembly_unavailable" },
] as const;

/** Sample failures use the actual entry surface without opening a room session. */
export function ChannelEntryPreview() {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [selected, setSelected] = useState("offline");
  const [action, setAction] = useState<"retry" | "new-identity" | null>(null);
  const sample = cases.find(value => value.value === selected)!;
  const channel = {
    error: sample.error,
    connection: sample.value === "connecting" ? "connecting" as const : "closed" as const,
    reconnect: () => setAction("retry"),
    joinAsNewIdentity: () => setAction("new-identity"),
  };
  return <div className="lr-app sp-page">
    <AppHeader homeHref="/__status-preview" />
    <div className="sp-main">
      <h1>{zh ? "站点连接" : "Site connection"}</h1>
      <label className="sp-failure-choice">{zh ? "状态示例" : "Sample state"}
        <select className="lr-input" value={selected} onChange={event => { setSelected(event.target.value); setAction(null); }}>
          {cases.map(value => <option key={value.value} value={value.value}>{zh ? value.zh : value.en}</option>)}
        </select>
      </label>
      <p role="status">{action === "retry" ? (zh ? "预览已收到重连操作。" : "Reconnect action received in this preview.")
        : action === "new-identity" ? (zh ? "预览已收到新身份操作。" : "New identity action received in this preview.")
        : (zh ? "正式组件与示例状态，不会连接站点。" : "Production components with sample states; no site connection.")}</p>
    </div>
    <ChannelSiteEntry key={sample.value} channel={channel}
      failure={channelErrorPresentation(sample.error, (cn, en) => zh ? cn : en)} />
  </div>;
}
