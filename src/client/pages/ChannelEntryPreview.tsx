import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { ChannelDomainEntry } from "../channel/components/ChannelDomainEntry";
import { channelErrorPresentation } from "../channel/error-presentation";
import { useCopy } from "../ui/copy";

const cases = [
  { value: "connecting", zh: "连接中", en: "Connecting", error: null },
  { value: "invitation", zh: "需要邀请", en: "Invitation required", error: "domain_invitation_required" },
  { value: "expired-invitation", zh: "邀请已失效", en: "Expired invitation", error: "invitation_required" },
  { value: "passphrase", zh: "输入口令", en: "Passphrase", error: "domain_password_required" },
  { value: "incorrect", zh: "口令不正确", en: "Incorrect passphrase", error: "domain_password_incorrect" },
  { value: "offline", zh: "连接断开", en: "Disconnected", error: "disconnected" },
  { value: "capacity", zh: "连接已满", en: "Connection limit", error: "channel_full" },
  { value: "users", zh: "用户数已满", en: "User limit", error: "user_limit" },
  { value: "runtime", zh: "组件加载失败", en: "Components unavailable", error: "room_runtime_unavailable" },
  { value: "version", zh: "版本不兼容", en: "Incompatible version", error: "incompatible_protocol" },
  { value: "browser", zh: "浏览器不支持", en: "Browser unsupported", error: "webassembly_unavailable" },
] as const;

/** Sample failures use the actual entry surface without opening a room session. */
export function ChannelEntryPreview() {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [selected, setSelected] = useState("offline");
  const [action, setAction] = useState<"entry" | "retry" | null>(null);
  const sample = cases.find(value => value.value === selected)!;
  const channel = {
    error: sample.error,
    connection: sample.value === "connecting" ? "connecting" as const : "closed" as const,
    enterDomain: () => setAction("entry"),
    reconnect: () => setAction("retry"),
  };
  return <div className="lr-app sp-page">
    <AppHeader homeHref="/__status-preview" />
    <div className="sp-main">
      <h1>{zh ? "域入口" : "Domain entry"}</h1>
      <label className="sp-failure-choice">{zh ? "状态示例" : "Sample state"}
        <select className="lr-input" value={selected} onChange={event => { setSelected(event.target.value); setAction(null); }}>
          {cases.map(value => <option key={value.value} value={value.value}>{zh ? value.zh : value.en}</option>)}
        </select>
      </label>
      <p role="status">{action === "entry" ? (zh ? "预览已收到进入操作。" : "Entry action received in this preview.")
        : action === "retry" ? (zh ? "预览已收到重连操作。" : "Reconnect action received in this preview.")
          : (zh ? "正式组件与示例状态，不会连接房间或验证口令。" : "Production components with sample states; no room connection or passphrase verification.")}</p>
    </div>
    <ChannelDomainEntry key={sample.value} channel={channel}
      failure={channelErrorPresentation(sample.error, (cn, en) => zh ? cn : en)} />
  </div>;
}
