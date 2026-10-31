import { ChannelIdentityMark, ChannelIdentityPicker } from "../components/ChannelIdentity";
import "./design-identity.css";

export type DesignIdentity = { icon: string };

export function DesignIdentityMark({ value, size = 32 }: { value: DesignIdentity; size?: number }) {
  return <ChannelIdentityMark icon={value.icon} size={size} />;
}

export function DesignIdentityPicker({ value, onChange, busy, onBusyChange }: {
  value: DesignIdentity; onChange(value: DesignIdentity): void;
  busy: boolean; onBusyChange(busy: boolean): void;
}) {
  return <ChannelIdentityPicker value={value.icon} onChange={icon => onChange({ icon })}
    busy={busy} onBusyChange={onBusyChange} />;
}
