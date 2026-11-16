import { useEffect, useId, useState } from "react";
import { useCopy } from "../../ui/copy";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import type { WatchIndexedChoice } from "../types";
import { formatMediaTime } from "../../media/media-time";

/** Only a unique usable track is a default; metadata never guesses a pairing. */
export function WatchIndexedTrackPicker({ choices, disabled, busy, mainPlayback, onConfirm }: {
  choices: readonly WatchIndexedChoice[]; disabled?: boolean; busy?: boolean; mainPlayback?: boolean;
  onConfirm(videoId: string, audioId?: string): void;
}) {
  const { t } = useCopy();
  const id = useId();
  const [videoId, setVideoId] = useState("");
  const [audioId, setAudioId] = useState<string | null>(null);
  const videos = choices.filter(choice => choice.inspection?.metadata.kind === "video");
  const audios = choices.filter(choice => choice.inspection?.metadata.kind === "audio");
  const unavailable = choices.filter(choice => !choice.inspection);
  const name = (choice: WatchIndexedChoice) => choice.candidate.name || t("watch.video");
  const metadata = (choice: WatchIndexedChoice) => {
    const value = choice.inspection!.metadata;
    return [choice.candidate.hostname, value.width && value.height ? `${value.width} × ${value.height}` : undefined,
      value.language && value.language !== "und" ? value.language : undefined,
      value.channels ? t("watch.forward.channels", { count: String(value.channels) }) : undefined,
      value.codec, formatMediaTime(value.duration)].filter(Boolean).join(" · ");
  };
  const selectedVideo = videos.find(choice => choice.candidate.id === videoId);
  const selectedAudio = audios.find(choice => choice.candidate.id === audioId);
  useEffect(() => {
    if (!selectedVideo) setVideoId(videos.length === 1 ? videos[0].candidate.id : "");
    if (audioId !== "" && !selectedAudio) setAudioId(audios.length === 1 ? audios[0].candidate.id : null);
  }, [videoId, audioId, selectedVideo, selectedAudio, choices]);
  const trackLabel = (choice: WatchIndexedChoice) => [name(choice),
    choice.inspection?.metadata.language !== "und" ? choice.inspection?.metadata.language : undefined,
    choice.candidate.hostname].filter(Boolean).join(" — ");
  const videoChoice = <select className="lr-select" aria-labelledby={`${id}-video`} value={videoId} disabled={disabled || busy}
    onChange={event => setVideoId(event.target.value)}>
    <option value="" disabled>{t("watch.chooseVideoTrack")}</option>
    {videos.map(choice => <option key={choice.candidate.id} value={choice.candidate.id}>{trackLabel(choice)}</option>)}
  </select>;
  const audioChoice = <select className="lr-select" aria-labelledby={`${id}-audio`} value={audioId === "" || !audios.length ? "video-only" : audioId ?? ""} disabled={disabled || busy}
    onChange={event => setAudioId(event.target.value === "video-only" ? "" : event.target.value)}>
    <option value="" disabled>{t("watch.chooseAudioTrack")}</option>
    <option value="video-only">{t("watch.forward.videoOnly")}</option>
    {audios.map(choice => <option key={choice.candidate.id} value={choice.candidate.id}>{trackLabel(choice)}</option>)}
  </select>;
  return <div className="c3-external-input">
    <p>{t(mainPlayback ? "watch.forward.mainHelp" : "watch.forward.tracksHelp")}</p>
    <section className="c3-external-input" aria-labelledby={`${id}-video`}>
      <h3 id={`${id}-video`}><Glyph name="tv" size={18} /> {t("host.settings.picture")}</h3>
      {videos.length ? videos.length > 1 ? videoChoice : <p className="lr-source-option-copy">{name(videos[0])}</p>
        : <p role="status">{t("watch.forward.noVideoTrack")}</p>}
    </section>
    <section className="c3-external-input" aria-labelledby={`${id}-audio`}>
      <h3 id={`${id}-audio`}><Glyph name="speaker" size={18} /> {t("host.settings.sound")}</h3>
      {audioChoice}
    </section>
    {unavailable.length > 0 && <p role="status">{t("watch.forward.trackUnavailable")}</p>}
    <details className="c3-settings-details"><summary>{t("watch.forward.trackOptions")}</summary>
      {choices.map(choice => <p className="lr-source-option-copy" key={choice.candidate.id}><span>{name(choice)}</span>
        <small>{choice.inspection ? metadata(choice) : choice.candidate.hostname}</small></p>)}
    </details>
    <Btn icon="share" tone="primary" title="watch.forward.confirmTracks" cap="watch.forward.confirmTracks" busy={busy}
      disabled={disabled || busy || !selectedVideo || audios.length > 1 && audioId === null || !!audioId && !selectedAudio}
      onClick={() => { if (selectedVideo) onConfirm(videoId, selectedAudio?.candidate.id); }} />
  </div>;
}
