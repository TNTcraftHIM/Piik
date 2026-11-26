import { useEffect, useState } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { MAX_RELAY_CAPACITY } from "../protocol";
import type { NativeRelayCapacity } from "../app-link";
import type { ChannelController } from "../types";
import { useSettingsAction, ChannelSettingsError } from "./ChannelSettingsDialog";
import "./channel-interface-control.css";

function ForwardingLimit({ label, value, disabled, onChange }: {
  label: string; value: number; disabled?: boolean; onChange(value: number): void;
}) {
  const { t } = useCopy();
  return <label className="c3-interface-choice">
    <span>{label}</span>
    <select className="lr-select" value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
      <option value={-1}>{t("channel.forwarding.auto")}</option>
      <option value={0}>{t("channel.forwarding.off")}</option>
      {Array.from({ length: MAX_RELAY_CAPACITY }, (_, index) => index + 1).map(limit => <option key={limit} value={limit}>
        {t("channel.forwarding.people", { count: String(limit) })}
      </option>)}
    </select>
  </label>;
}

export function ChannelForwardingSettings({ channel }: { channel: ChannelController }) {
  const { t } = useCopy();
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState<NativeRelayCapacity | null>(null);
  const [failed, setFailed] = useState(false);
  const { error, run } = useSettingsAction(open);
  const read = channel.appRelayCapacity;
  const connected = channel.connection === "connected";
  useEffect(() => {
    setApp(null);
    setFailed(false);
    if (!open || !connected || !channel.appConnected) return;
    const lifetime = new AbortController();
    void read(lifetime.signal).then(value => { if (!lifetime.signal.aborted) setApp(value); },
      () => { if (!lifetime.signal.aborted) setFailed(true); });
    return () => lifetime.abort();
  }, [open, connected, channel.appConnected, channel.sessionId, read]);
  if (!channel.self) return null;
  return <details className="c3-forwarding-settings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="lr-btn is-compact is-quiet"><Glyph name="chevron" size={16} />{t("channel.forwarding.title")}</summary>
    <p>{t("channel.forwarding.note")}</p>
    <ForwardingLimit label={t("room.relay.webpage")} value={channel.forwardingLimit} onChange={channel.setForwardingLimit} />
    {channel.appConnected && (app ? <ForwardingLimit label={t("room.relay.app")} value={app.relayOverride ?? -1}
      disabled={!connected || channel.pending.has("app-relay")} onChange={value => {
        void run(() => channel.setAppRelayOverride(app, value < 0 ? null : value, false), setApp);
      }} /> : <p role="status">{t(failed || !connected ? "room.relay.appUnavailable" : "common.loading")}</p>)}
    <ChannelSettingsError error={error} />
  </details>;
}
