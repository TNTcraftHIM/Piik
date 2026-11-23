import type { RefObject } from "react";
import { useCopy } from "../../ui/copy";
import "./playback-controls.css";

export function PlaybackControlsReveal({ controls, controlsId, hidden }: {
  controls: RefObject<HTMLDivElement | null>; controlsId: string; hidden: boolean;
}) {
  const { t } = useCopy();
  return <button type="button" className="lr-playback-reveal" aria-label={t("playback.showControls")}
    aria-controls={controlsId} aria-expanded={!hidden}
    onClick={() => controls.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true })} />;
}
