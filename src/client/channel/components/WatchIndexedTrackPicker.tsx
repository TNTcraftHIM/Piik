import { useEffect, useId, useState } from "react";
import { useCopy } from "../../ui/copy";
import { CaptureSourceCard } from "../../components/living/CaptureSourceCard";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import type { WatchIndexedChoice } from "../types";

/** Metadata describes independent tracks; only the user selects their combination. */
export function WatchIndexedTrackPicker({ choices, disabled, busy, mainPlayback, onConfirm }: {
  choices: readonly WatchIndexedChoice[]; disabled?: boolean; busy?: boolean; mainPlayback?: boolean;
  onConfirm(videoId: string, audioId?: string): void;
}) {
  const { t } = useCopy();
  const id = useId();
  const [videoId, setVideoId] = useState("");
  const [audioId, setAudioId] = useState("");
  const videos = choices.filter(choice => choice.inspection?.metadata.kind === "video");
  const audios = choices.filter(choice => choice.inspection?.metadata.kind === "audio");
  const unavailable = choices.filter(choice => !choice.inspection);
  const name = (choice: WatchIndexedChoice) => choice.candidate.name || t("watch.video");
  const metadata = (choice: WatchIndexedChoice) => {
    const value = choice.inspection!.metadata;
    const minutes = Math.floor(value.duration / 60), seconds = Math.floor(value.duration % 60);
    return [choice.candidate.hostname, value.width && value.height ? `${value.width} × ${value.height}` : undefined,
      value.language && value.language !== "und" ? value.language : undefined,
      value.channels ? t("watch.forward.channels", { count: String(value.channels) }) : undefined,
      value.codec, `${minutes}:${String(seconds).padStart(2, "0")}`].filter(Boolean).join(" · ");
  };
  const selectedVideo = videos.find(choice => choice.candidate.id === videoId);
  const selectedAudio = audios.find(choice => choice.candidate.id === audioId);
  useEffect(() => {
    if (videoId && !selectedVideo) setVideoId("");
    if (audioId && !selectedAudio) setAudioId("");
  }, [videoId, audioId, selectedVideo, selectedAudio]);
  return <div className="c3-external-input">
    <p>{t(mainPlayback ? "watch.forward.mainHelp" : "watch.forward.tracksHelp")}</p>
    <section className="c3-external-input" aria-labelledby={`${id}-video`}>
      <h3 id={`${id}-video`}><Glyph name="tv" size={18} /> {t("host.settings.picture")}</h3>
      {videos.length ? <div className="lr-source-picker-list" data-text-list>{videos.map(choice => <CaptureSourceCard
        key={choice.candidate.id} title={name(choice)} description={metadata(choice)}
        action={t("watch.selectVideoNamed", { name: name(choice) })} icon="play" hint="hint-source-picker"
        selected={videoId === choice.candidate.id} disabled={disabled || busy} onSelect={() => setVideoId(choice.candidate.id)} />)}</div>
        : <p role="status">{t("watch.forward.noVideoTrack")}</p>}
    </section>
    <section className="c3-external-input" aria-labelledby={`${id}-audio`}>
      <h3 id={`${id}-audio`}><Glyph name="speaker" size={18} /> {t("host.settings.sound")}</h3>
      <select className="lr-select" aria-labelledby={`${id}-audio`} value={audioId} disabled={disabled || busy}
        onChange={event => setAudioId(event.target.value)}>
        <option value="">{t("watch.forward.videoOnly")}</option>
        {audios.map(choice => <option key={choice.candidate.id} value={choice.candidate.id}>{name(choice)} — {metadata(choice)}</option>)}
      </select>
    </section>
    {unavailable.length > 0 && <div role="status"><p>{t("watch.forward.trackUnavailable")}</p>
      {unavailable.map(choice => <p key={choice.candidate.id}>{name(choice)} — {choice.candidate.hostname}</p>)}
    </div>}
    {selectedVideo && <p>{t("watch.forward.selected", { video: name(selectedVideo), audio: selectedAudio ? name(selectedAudio) : t("watch.forward.videoOnly") })}</p>}
    <Btn icon="share" tone="primary" title="watch.forward.confirmTracks" cap="watch.forward.confirmTracks" busy={busy}
      disabled={disabled || busy || !selectedVideo || !!audioId && !selectedAudio}
      onClick={() => { if (selectedVideo) onConfirm(videoId, selectedAudio?.candidate.id); }} />
  </div>;
}
