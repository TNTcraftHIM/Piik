import { useId, useRef } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelMedia";

export function ChannelJoinVoice({ joined, disabled, busy, onJoin }: {
  joined: boolean; disabled: boolean; busy: boolean; onJoin: (listenOnly: boolean) => void;
}) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, panel, { side: "below", enabled: !joined });
  if (joined) return <span className="c3-voice-joined"><Glyph name="headphones" size={18} />
    {!vis && <span>{zh ? "语音已加入" : "Voice joined"}</span>}</span>;
  return <div className="c3-join-voice">
    <ChannelAction icon="headphones" label={zh ? "加入语音" : "Join voice"} hint="hint-voice-join"
      disabled={disabled} busy={busy} onClick={() => onJoin(false)} />
    <Tooltip kind="hint-voice-join" text={vis ? undefined : zh ? "语音加入方式" : "Voice join options"}>
      <button type="button" ref={trigger} className="lr-btn is-compact is-quiet" disabled={disabled || busy}
        aria-label={zh ? "语音加入方式" : "Voice join options"} popoverTarget={id} aria-haspopup="dialog">
        <Glyph name="chevron" size={16} />
      </button>
    </Tooltip>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={zh ? "语音加入方式" : "Voice join options"}
      className="lr-anchored-card c3-join-options">
      <ChannelAction icon="headphones" label={zh ? "只收听，不开麦" : "Listen without a microphone"} quiet
        disabled={disabled} busy={busy} onClick={() => { panel.current?.hidePopover(); onJoin(true); }} />
    </div>
  </div>;
}
