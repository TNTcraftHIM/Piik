import type { ComponentProps } from "react";
import { MicrophoneSettings } from "./MicrophoneSettings";
import { SwitchItem } from "./primitives";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export type ShareMicrophoneSettingsProps = Omit<ComponentProps<typeof MicrophoneSettings>, "host"> & {
  available: boolean;
  busy?: boolean;
  roomMicrophone?: boolean;
  onEnabled: (enabled: boolean) => void;
};

// Capture and permission lifetimes stay with the sharing owner.
export function ShareMicrophoneSettings({ available, enabled, disabled, busy, roomMicrophone, onEnabled, ...settings }: ShareMicrophoneSettingsProps) {
  const { t, vis } = useCopy();
  return <div className="lr-door-group lr-audio-settings">
    <SwitchItem checked={enabled} label={t("host.commentary.include")} icon="microphone"
      hint={enabled ? "hint-microphone-off" : "hint-microphone-on"}
      note={t(!available ? "host.commentary.unavailable" : enabled && roomMicrophone ? "host.commentary.duplicate" : "host.commentary.description")}
      disabled={!available || disabled || busy} onChange={onEnabled} />
    {enabled && roomMicrophone ? <small role="status">
      {vis ? <><Glyph name="microphone" size={14} /> ×2<span className="visually-hidden">{t("host.commentary.duplicate")}</span></> : t("host.commentary.duplicate")}
    </small> : null}
    {enabled ? <MicrophoneSettings {...settings} host enabled={enabled} disabled={!available || disabled} /> : null}
  </div>;
}
