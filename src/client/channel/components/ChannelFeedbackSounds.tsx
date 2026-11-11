import { useId, useRef, useState, type CSSProperties } from "react";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { FeedbackCue } from "../feedback-audio";
import { FEEDBACK_CLIP_MAX_BYTES, FEEDBACK_CLIP_MAX_DURATION } from "../feedback-clip";
import "./channel-feedback-sounds.css";

/** Personal playback preferences; event selection and audio lifetime belong to Session. */
export function ChannelFeedbackSounds({ channel }: { channel: Pick<ChannelController, "feedbackSound" | "setFeedbackSound" | "setFeedbackClip" | "previewFeedbackSound"> }) {
  const { t } = useCopy();
  const id = useId(), { enabled, volume } = channel.feedbackSound;
  const label = t("interaction.feedbackSounds");
  const volumeLabel = t("interaction.feedbackVolume");
  const percent = Math.round(volume * 100);
  const clipLimits = { size: String(FEEDBACK_CLIP_MAX_BYTES / 1024), seconds: String(FEEDBACK_CLIP_MAX_DURATION) };
  const chooser = useRef<HTMLInputElement>(null), selection = useRef<FeedbackCue>("message");
  const [busy, setBusy] = useState<FeedbackCue | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function replace(cue: FeedbackCue, file: File | null) {
    if (busy) return;
    setBusy(cue); setError(null);
    try { await channel.setFeedbackClip(cue, file); }
    catch (error) { setError(error instanceof Error ? error.message : ""); }
    finally { setBusy(null); }
  }
  return <section className="c3-feedback-sounds" aria-label={label}>
    <SwitchItem checked={enabled} label={label} icon="speaker" onChange={enabled => channel.setFeedbackSound({ enabled })} />
    {enabled && <>
      <p>{t("interaction.feedbackSoundsHint")}</p>
      <label htmlFor={id}><span>{volumeLabel}</span><output htmlFor={id}>{percent}%</output></label>
      <input id={id} type="range" min={0} max={100} step={1} value={percent}
        style={{ "--range-fill": `${percent}%` } as CSSProperties} aria-label={volumeLabel} aria-valuetext={`${percent}%`}
        onChange={event => channel.setFeedbackSound({ volume: Number(event.target.value) / 100 })} />
      {(["message", "throw"] as const).map(cue => {
        const title = t(cue === "message" ? "interaction.feedbackMessageCue" : "interaction.feedbackThrowCue");
        const clip = channel.feedbackSound.clips?.[cue];
        const name = clip?.name ?? t("interaction.feedbackBuiltIn");
        return <div key={cue} className="c3-feedback-clip">
          <div className="c3-feedback-clip-name"><strong>{title}</strong>
            <Tooltip overflow={{ text: name, selector: "span" }}><span>{name}</span></Tooltip></div>
          <div className="c3-feedback-clip-actions">
            <Btn icon="arrowUp" quiet size="compact" cap={{ text: t("interaction.feedbackChooseClip") }}
              title={{ text: t("interaction.feedbackChooseClipHint", { cue: title }) }} busy={busy === cue} disabled={busy !== null}
              onClick={() => { selection.current = cue; chooser.current?.click(); }} />
            <Btn icon="play" quiet size="compact" textTooltip title={{ text: t(volume === 0 ? "interaction.feedbackMutedHint" : "interaction.feedbackTryCue", { cue: title }) }}
              disabled={volume === 0 || busy === cue} onClick={() => channel.previewFeedbackSound(cue)} />
            {clip && <Btn icon="refresh" quiet size="compact" textTooltip title={{ text: t("interaction.feedbackResetCue", { cue: title }) }}
              disabled={busy !== null} onClick={() => { void replace(cue, null); }} />}
          </div>
        </div>;
      })}
      <input ref={chooser} hidden type="file" accept="audio/*" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void replace(selection.current, file);
      }} />
      <p>{t("interaction.feedbackLocalClips", clipLimits)}</p>
      {error !== null && <p className="c3-feedback-error" role="status">{t(error === "feedback_clip_too_large" ? "interaction.feedbackClipTooLarge"
        : error === "feedback_clip_too_long" ? "interaction.feedbackClipTooLong" : error === "feedback_clip_invalid" ? "interaction.feedbackClipInvalid" : "interaction.feedbackClipSaveFailed", clipLimits)}</p>}
    </>}
  </section>;
}
