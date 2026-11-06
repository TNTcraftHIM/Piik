import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { FieldCap, RowGroup, SwitchItem } from "./primitives";
import { NumberControl } from "./NumberControl";
import { Tooltip } from "./Tooltip";
import "./playback-controls.css";
import "./relay-volunteer-settings.css";

export interface RelayCapacitySettings {
  enabled: boolean;
  pending: boolean;
  disabled: boolean;
  capacity: number;
  minimum: number;
  maximum: number;
  available: boolean;
  customizable?: boolean;
  onChange: (enabled: boolean) => void;
  onCapacityChange: (capacity: number) => void;
}

// Controls only; room defaults and endpoint overrides keep their session owners.
export function RelayVolunteerSettings({ settings, role = "viewer" }: {
  settings: RelayCapacitySettings;
  role?: "viewer" | "host";
}) {
  const { t, vis } = useCopy();
  const host = role === "host";
  const customizable = host || settings.customizable === true;
  const limit = host ? "host.sendingCapacityLimit" : "playback.relayLimit";
  const hint = settings.available
    ? host ? "host.sendingCapacityHint" : !customizable ? "playback.relayVolunteerLegacyHint"
      : settings.enabled ? "playback.relayVolunteerHint" : "playback.relayRoomDefault"
    : host ? "host.sendingCapacityUnavailable" : "playback.relayUnavailable";
  const explanation = host ? `${t(hint)}\n${t("host.sendingCapacityAccounting")}` : t(hint);
  return <div className="lr-viewer-relay-setting" aria-busy={settings.pending}>
    <div className="lr-door-group">
      {!host && <RowGroup>
        {vis && <Glyph name="branch" size={18} />}
        <SwitchItem checked={settings.enabled} disabled={settings.disabled}
          onChange={settings.onChange} label={t(customizable ? "playback.relayVolunteer" : "playback.relayVolunteerLegacy")}
          note={t(hint)} hint="hint-relay-volunteer" />
      </RowGroup>}
      {(customizable || settings.enabled) && <NumberControl value={settings.capacity} min={settings.minimum} max={settings.maximum}
        step={1} unit={t(host ? "host.sendingCapacityStreams" : "playback.relayPeople")} showUnit={!vis}
        name={host ? "sending-capacity" : "relay-capacity"} label={t(limit)}
        disabled={settings.disabled || !settings.available || !host && !settings.enabled} onChange={settings.onCapacityChange}
        className="lr-door-group">{input => <div className="lr-quality-heading">
          {vis ? <Glyph name="branch" size={16} /> : <FieldCap k={limit} />}
          <Tooltip kind="hint-relay-volunteer" text={`${t(limit)}\n${explanation}`}>{input}</Tooltip>
        </div>}</NumberControl>}
    </div>
    {!vis && <p>{t(hint)}</p>}
  </div>;
}
