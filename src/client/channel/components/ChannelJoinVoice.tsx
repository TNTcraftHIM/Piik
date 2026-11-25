import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsError } from "./ChannelSettingsDialog";

/** The join result is owned by the page, so moving this control between slots keeps a shown failure. */
export function ChannelJoinVoice({ joined, disabled, busy, error, onJoin }: {
  joined: boolean; disabled: boolean; busy: boolean; error: string | null; onJoin: (listenOnly: boolean) => void;
}) {
  const { t } = useCopy();
  if (joined) return <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
    <span>{t("channel.joinVoice.voiceJoined")}</span></span>;
  return <>
    <ChannelAction icon="headphones" label={t("voice.join")} hint="hint-voice-join"
      disabled={disabled} busy={busy} onClick={() => onJoin(false)} />
    <ChannelSettingsError error={error} />
  </>;
}
