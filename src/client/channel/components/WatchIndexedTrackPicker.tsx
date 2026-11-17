import { useEffect, useId, useRef, useState } from "react";
import { useCopy } from "../../ui/copy";
import { Btn } from "../../components/living/primitives";
import { Glyph } from "../../ui/icons";
import { CaptureSourceCard } from "../../components/living/CaptureSourceCard";
import type { WatchIndexedChoice, WatchMpdChoice } from "../types";
import { formatMediaTime } from "../../media/media-time";

import type { NativePageMpdSelection } from "../../native/wire";

interface TrackChoice { id: string; name: string; kind?: "video" | "audio"; label: string; metadata: string }

/** Only a unique usable track is a default; metadata never guesses a pairing. */
export function WatchIndexedTrackPicker({ choices, disabled, busy, mainPlayback, onConfirm }: {
  choices: readonly WatchIndexedChoice[]; disabled?: boolean; busy?: boolean; mainPlayback?: boolean;
  onConfirm(videoId: string, audioId?: string): void;
}) {
  const { t } = useCopy();
  return <WatchTrackPicker choices={choices.map(choice => {
    const value = choice.inspection?.metadata;
    const name = choice.candidate.name || t("watch.video");
    return { id: choice.candidate.id, name, kind: value?.kind,
      label: [name, value?.language !== "und" ? value?.language : undefined, choice.candidate.hostname].filter(Boolean).join(" — "),
      metadata: [choice.candidate.hostname, value?.width && value.height ? `${value.width} × ${value.height}` : undefined,
        value?.language && value.language !== "und" ? value.language : undefined,
        value?.channels ? t("watch.forward.channels", { count: String(value.channels) }) : undefined,
        value?.codec, value ? formatMediaTime(value.duration) : undefined].filter(Boolean).join(" · ") };
  })} disabled={disabled} busy={busy} mainPlayback={mainPlayback} onConfirm={onConfirm} />;
}

export function WatchMpdSourcePicker({ choices, onInspect, onConfirm, ...props }: {
  choices: readonly WatchMpdChoice[]; disabled?: boolean; busy?: boolean; mainPlayback?: boolean;
  onInspect(choiceId: string, signal: AbortSignal): Promise<unknown>;
  onConfirm(selection: NativePageMpdSelection): void;
}) {
  const { t } = useCopy();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const selected = choices.find(choice => choice.catalog);
  return <div className="c3-external-input"><div className="lr-source-picker-list" data-text-list>
    {choices.map(choice => <CaptureSourceCard key={choice.candidate.id} title={choice.candidate.name || choice.candidate.hostname}
      description={choice.candidate.hostname} action={t("watch.selectVideoNamed", { name: choice.candidate.name || choice.candidate.hostname })}
      icon="play" hint="hint-source-picker" selected={choice === selected} disabled={props.disabled || props.busy}
      onSelect={() => { request.current?.abort(); const controller = request.current = new AbortController(); void onInspect(choice.candidate.id, controller.signal); }} />)}
    </div>{selected && <WatchMpdTrackPicker key={selected.catalog!.sourceId} choice={selected} {...props} onConfirm={onConfirm} />}
  </div>;
}

function WatchMpdTrackPicker({ choice, onConfirm, ...props }: {
  choice: WatchMpdChoice; disabled?: boolean; busy?: boolean; mainPlayback?: boolean; onConfirm(selection: NativePageMpdSelection): void;
}) {
  const { lang, t } = useCopy();
  const languages = new Intl.DisplayNames([lang], { type: "language" });
  const tracks = choice.catalog?.tracks.map(track => {
    let language = track.language && track.language !== "und" ? track.language : "";
    try { if (language) language = languages.of(language) ?? language; } catch { /* Keep an unrecognized source label literal. */ }
    return { id: track.id, kind: track.kind,
    name: track.label || choice.candidate.name || t("watch.video"),
    label: [track.width && track.height ? `${track.width} × ${track.height}` : undefined, language,
      track.codec.split(".")[0]].filter(Boolean).join(" — "),
    metadata: [choice.candidate.hostname, track.width && track.height ? `${track.width} × ${track.height}` : undefined,
      track.language && track.language !== "und" ? track.language : undefined, track.role, track.codec,
      track.bandwidth ? `${Math.round(track.bandwidth / 1000)} kbps` : undefined].filter(Boolean).join(" · ") };
  }) ?? [];
  const options = tracks.map(track => ({ ...track, label: tracks.some(other => other !== track && other.kind === track.kind && other.label === track.label)
    ? `${track.label} — ${track.name}` : track.label }));
  return <section className="c3-external-input" aria-label={choice.candidate.name || choice.candidate.hostname}>
    <p className="lr-source-option-copy"><strong>{choice.candidate.name || choice.candidate.hostname}</strong><small>{choice.candidate.hostname}</small></p>
    {choice.catalog ? <WatchTrackPicker {...props} choices={options}
      onConfirm={(videoId, audioId) => { if (choice.catalog) onConfirm({ sourceId: choice.catalog.sourceId, videoId, ...(audioId ? { audioId } : {}) }); }} />
      : <p role="status">{t("watch.forward.trackUnavailable")}</p>}
  </section>;
}

function WatchTrackPicker({ choices, disabled, busy, mainPlayback, onConfirm }: {
  choices: readonly TrackChoice[]; disabled?: boolean; busy?: boolean; mainPlayback?: boolean;
  onConfirm(videoId: string, audioId?: string): void;
}) {
  const { t } = useCopy();
  const id = useId();
  const [videoId, setVideoId] = useState("");
  const [audioId, setAudioId] = useState<string | null>(null);
  const videos = choices.filter(choice => choice.kind === "video"), audios = choices.filter(choice => choice.kind === "audio");
  const unavailable = choices.filter(choice => !choice.kind);
  const selectedVideo = videos.find(choice => choice.id === videoId);
  const selectedAudio = audios.find(choice => choice.id === audioId);
  useEffect(() => {
    if (!selectedVideo) setVideoId(videos.length === 1 ? videos[0].id : "");
    if (audioId !== "" && !selectedAudio) setAudioId(audios.length === 1 ? audios[0].id : null);
  }, [videoId, audioId, selectedVideo, selectedAudio, choices]);
  const videoChoice = <select className="lr-select" aria-labelledby={`${id}-video`} value={videoId} disabled={disabled || busy}
    onChange={event => setVideoId(event.target.value)}>
    <option value="" disabled>{t("watch.chooseVideoTrack")}</option>
    {videos.map(choice => <option key={choice.id} value={choice.id}>{choice.label || choice.name}</option>)}
  </select>;
  const audioChoice = <select className="lr-select" aria-labelledby={`${id}-audio`} value={audioId === "" || !audios.length ? "video-only" : audioId ?? ""} disabled={disabled || busy}
    onChange={event => setAudioId(event.target.value === "video-only" ? "" : event.target.value)}>
    <option value="" disabled>{t("watch.chooseAudioTrack")}</option>
    <option value="video-only">{t("watch.forward.videoOnly")}</option>
    {audios.map(choice => <option key={choice.id} value={choice.id}>{choice.label || choice.name}</option>)}
  </select>;
  return <div className="c3-external-input">
    <p>{t(mainPlayback ? "watch.forward.mainHelp" : "watch.forward.tracksHelp")}</p>
    <section className="c3-external-input" aria-labelledby={`${id}-video`}>
      <h3 id={`${id}-video`}><Glyph name="tv" size={18} /> {t("host.settings.picture")}</h3>
      {videos.length ? videos.length > 1 ? videoChoice : <p className="lr-source-option-copy">{videos[0].name}</p>
        : <p role="status">{t("watch.forward.noVideoTrack")}</p>}
    </section>
    <section className="c3-external-input" aria-labelledby={`${id}-audio`}>
      <h3 id={`${id}-audio`}><Glyph name="speaker" size={18} /> {t("host.settings.sound")}</h3>
      {audioChoice}
    </section>
    {unavailable.length > 0 && <p role="status">{t("watch.forward.trackUnavailable")}</p>}
    <Btn icon="share" tone="primary" title="watch.forward.confirmTracks" cap="watch.forward.confirmTracks" busy={busy}
      disabled={disabled || busy || !selectedVideo || audios.length > 1 && audioId === null || !!audioId && !selectedAudio}
      onClick={() => { if (selectedVideo) onConfirm(videoId, selectedAudio?.id); }} />
    <details className="c3-settings-details"><summary>{t("watch.forward.trackOptions")}</summary>
      {choices.map(choice => <p className="lr-source-option-copy" key={choice.id}><span>{choice.name}</span>
        <small>{choice.metadata}</small></p>)}
    </details>
  </div>;
}
