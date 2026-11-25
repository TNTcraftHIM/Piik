import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsError, useSettingsAction } from "./ChannelSettingsDialog";

/** Mount one per room: a join failure belongs to the room it was attempted in. */
export function ChannelJoinVoice({ joined, disabled, busy, onJoin }: {
  joined: boolean; disabled: boolean; busy: boolean; onJoin: (listenOnly: boolean) => Promise<void>;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  if (joined) return <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
    <span>{t("channel.joinVoice.voiceJoined")}</span></span>;
  return <>
    <ChannelAction icon="headphones" label={t("voice.join")} hint="hint-voice-join"
      disabled={disabled} busy={busy} onClick={() => { void run(() => onJoin(false)); }} />
    <ChannelSettingsError error={error} />
  </>;
}
