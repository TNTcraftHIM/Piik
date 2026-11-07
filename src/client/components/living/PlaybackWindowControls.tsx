import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import type { usePictureInPicture } from "./use-picture-in-picture";

export function PlaybackWindowControls({ picture, canPlay, theaterMode, onToggleTheater,
  fullscreen, fullscreenFailed, toggleFullscreen, quiet = false,
}: {
  picture: Pick<ReturnType<typeof usePictureInPicture>, "active" | "supported" | "failed" | "toggle">;
  canPlay: boolean; theaterMode: boolean; onToggleTheater(): void;
  fullscreen: { supported: boolean; ready: boolean; active: boolean };
  fullscreenFailed?: boolean; toggleFullscreen(): void; quiet?: boolean;
}) {
  const { t } = useCopy();
  const pipTitle = picture.failed ? "playback.pipFailed" : !picture.supported ? "playback.pipUnavailable"
    : picture.active ? "playback.exitPip" : !canPlay ? "playback.pipWaiting" : "playback.pip";
  return <span className="lr-playback-window" role="group" aria-label={t("playback.windowControls")}>
    <Btn icon={picture.active ? "pipExit" : "pip"} draw="playback-pip" title={pipTitle} quiet={quiet}
      hintTone={picture.failed ? "bad" : undefined}
      hint={!picture.supported || picture.failed || (!picture.active && !canPlay) ? "hint-pip-unavailable" : picture.active ? "hint-pip-exit" : "hint-pip"}
      pressed={picture.active} disabled={!picture.supported || (!picture.active && !canPlay)}
      onClick={() => { void picture.toggle(); }} />
    {!fullscreen.active && <Btn icon={theaterMode ? "theaterExit" : "theater"} draw="playback-theater" quiet={quiet}
      title={theaterMode ? "viewer.theater.exit" : "viewer.theater"}
      hint={theaterMode ? "hint-theater-exit" : "hint-theater"}
      pressed={theaterMode} onClick={onToggleTheater} />}
    {fullscreen.supported && <Btn icon={fullscreen.active ? "contract" : "expand"} draw="playback-fullscreen" quiet={quiet}
      title={fullscreenFailed ? "playback.fullscreenFailed" : fullscreen.active ? "playback.exitFullscreen"
        : !fullscreen.ready ? "playback.fullscreenWaiting" : "playback.fullscreen"}
      hint={fullscreenFailed || (!fullscreen.active && !fullscreen.ready) ? "hint-fullscreen-unavailable"
        : fullscreen.active ? "hint-fullscreen-exit" : "hint-fullscreen"}
      hintTone={fullscreenFailed ? "bad" : !fullscreen.ready ? "warn" : undefined}
      disabled={!fullscreen.active && !fullscreen.ready} pressed={fullscreen.active} onClick={toggleFullscreen} />}
  </span>;
}
