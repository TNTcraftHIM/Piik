export function bindPlaybackGestures(
  video: HTMLVideoElement,
  toggleFullscreen: () => void,
): () => void {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let pointerType = "";
  // Picture taps only reveal controls. Playback belongs to its explicit button;
  // remote input consumes its own double-clicks before they reach the video.
  video.parentElement?.addEventListener("pointerdown", (event) => {
    pointerType = event.pointerType;
  }, options);
  video.addEventListener("dblclick", (event) => {
    if (event.defaultPrevented || event.button !== 0 || pointerType === "touch") return;
    toggleFullscreen();
  }, options);
  return () => listeners.abort();
}
