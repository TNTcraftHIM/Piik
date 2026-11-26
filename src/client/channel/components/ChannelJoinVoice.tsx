import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { Btn } from "../../components/living/primitives";
import { ChannelSettingsError } from "./ChannelSettingsDialog";

/** The join result is owned by the page, so moving this control between slots keeps a shown failure. */
export function ChannelJoinVoice({ joined, disabled, busy, error, onJoin, tonal = false }: {
  joined: boolean; tonal?: boolean; disabled: boolean; busy: boolean; error: string | null; onJoin: (listenOnly: boolean) => void;
}) {
  const { t } = useCopy();
  return <>
    {joined ? <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
      <span>{t("channel.joinVoice.voiceJoined")}</span></span>
      : <Btn icon="headphones" title="voice.join" cap="voice.join" size="compact" hint="hint-voice-join"
        quiet={!tonal} className={tonal ? "is-tonal" : undefined} disabled={disabled || busy} busy={busy} onClick={() => onJoin(false)} />}
    <ChannelSettingsError error={error} />
  </>;
}
