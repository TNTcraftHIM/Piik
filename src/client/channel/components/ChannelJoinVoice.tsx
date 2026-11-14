import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelAction";

export function ChannelJoinVoice({ joined, disabled, busy, onJoin }: {
  joined: boolean; disabled: boolean; busy: boolean; onJoin: (listenOnly: boolean) => void;
}) {
  const { t } = useCopy();
  if (joined) return <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
    <span>{t("channel.joinVoice.voiceJoined")}</span></span>;
  return <ChannelAction icon="headphones" label={t("voice.join")} hint="hint-voice-join"
    disabled={disabled} busy={busy} onClick={() => onJoin(false)} />;
}
