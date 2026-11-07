import { useState } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import "./channel-room-controls.css";

/** Domain admission precedes Welcome; no room or user snapshot is available yet. */
export function ChannelDomainEntry({ channel, failure }: { channel: ChannelController; failure: string | null }) {
  const { lang, vis } = useCopy(), zh = lang === "zh";
  const [password, setPassword] = useState("");
  const needsPassword = channel.error === "domain_password_required" || channel.error === "domain_password_incorrect";
  const needsInvitation = channel.error === "domain_invitation_required";
  const connecting = channel.connection === "connecting" || channel.connection === "reconnecting";
  const title = needsPassword ? (zh ? "输入域口令" : "Enter the domain passphrase")
    : needsInvitation ? (zh ? "需要域邀请" : "Domain invitation required")
    : connecting ? (zh ? "正在连接" : "Connecting") : (zh ? "未能进入域" : "Could not enter this domain");
  return <main className="c3-locked-room c3-domain-entry" aria-labelledby="c3-domain-entry-title">
    <Glyph name={needsPassword ? "key" : needsInvitation ? "lock" : "signal"} size={46} />
    <h1 id="c3-domain-entry-title" className={vis ? "visually-hidden" : undefined}>{title}</h1>
    <p className="c3-domain-entry-site">{location.host}</p>
    {needsPassword ? <>
      {!vis && <p>{zh ? "也可以使用有效的域邀请链接进入。" : "You can also enter with a valid domain invitation."}</p>}
      {channel.error === "domain_password_incorrect" && <p role="alert">{zh ? "域口令不正确，请重试。" : "The domain passphrase is incorrect. Try again."}</p>}
      <form onSubmit={event => {
        event.preventDefault();
        if (password && !connecting) { channel.enterDomain(password); setPassword(""); }
      }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <input className="c3-input" type="password" maxLength={128} autoComplete="current-password" autoFocus
          aria-label={zh ? "域口令" : "Domain passphrase"} value={password} disabled={connecting} onChange={event => setPassword(event.target.value)} />
        <ChannelAction icon="door" primary type="submit" label={zh ? "进入域" : "Enter domain"} disabled={!password || connecting} />
      </form>
    </> : needsInvitation ? <p>{zh ? "请向域主索取新的完整邀请链接。" : "Ask the domain owner for a new, complete invitation link."}</p>
      : connecting ? <span role="status" className="visually-hidden">{title}</span>
        : <>{failure && <p role="alert">{failure}</p>}<ChannelAction icon="refresh" label={zh ? "重新连接" : "Reconnect"} onClick={channel.reconnect} /></>}
  </main>;
}
