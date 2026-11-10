import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelAction";

export function ChannelJoinVoice({ joined, disabled, busy, onJoin }: {
  joined: boolean; disabled: boolean; busy: boolean; onJoin: (listenOnly: boolean) => void;
}) {
  const { lang, vis, t } = useCopy();
  const zh = lang === "zh";
  if (joined) return <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
    {!vis && <span>{zh ? "语音已加入" : "Voice joined"}</span>}</span>;
  return <ChannelAction icon="headphones" label={t("voice.join")} hint="hint-voice-join"
    disabled={disabled} busy={busy} onClick={() => onJoin(false)} />;
}
