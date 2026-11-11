import { useId, type CSSProperties } from "react";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import "./channel-feedback-sounds.css";

/** Personal playback preferences; event selection and audio lifetime belong to Session. */
export function ChannelFeedbackSounds({ channel }: { channel: Pick<ChannelController, "feedbackSound" | "setFeedbackSound" | "previewFeedbackSound"> }) {
  const { t } = useCopy();
  const id = useId(), { enabled, volume } = channel.feedbackSound;
  const label = t("interaction.feedbackSounds");
  const volumeLabel = t("interaction.feedbackVolume");
  const percent = Math.round(volume * 100);
  return <section className="c3-feedback-sounds" aria-label={label}>
    <SwitchItem checked={enabled} label={label} icon="speaker" onChange={enabled => channel.setFeedbackSound({ enabled })} />
    {enabled && <>
      <p>{t("interaction.feedbackSoundsHint")}</p>
      <label htmlFor={id}><span>{volumeLabel}</span><output htmlFor={id}>{percent}%</output></label>
      <input id={id} type="range" min={0} max={100} step={1} value={percent}
        style={{ "--range-fill": `${percent}%` } as CSSProperties} aria-label={volumeLabel} aria-valuetext={`${percent}%`}
        onChange={event => channel.setFeedbackSound({ volume: Number(event.target.value) / 100 })} />
      <Btn icon="play" quiet size="compact" cap={{ text: t("interaction.feedbackPreview") }}
        title={{ text: t("interaction.feedbackPreviewHint") }} disabled={volume === 0} onClick={channel.previewFeedbackSound} />
    </>}
  </section>;
}
