// A native double-click follows two clicks. Defer only the picture shortcut;
// visible controls and keyboard actions remain immediate.
const SINGLE_CLICK_MS = 500;

export function bindPlaybackGestures(
  video: HTMLVideoElement,
  togglePlayback: () => void,
  toggleFullscreen: () => void,
): () => void {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerType = "";
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // Beginning another action retires an uncommitted picture click, including
  // the second press of a double-click or an action in the control bar.
  video.parentElement?.addEventListener("pointerdown", (event) => {
    pointerType = event.pointerType;
    cancel();
  }, options);
  video.parentElement?.addEventListener("keydown", cancel, options);
  video.parentElement?.addEventListener("pointercancel", cancel, options);
  video.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.detail !== 1 || pointerType === "touch") return;
    cancel();
    const source = video.srcObject;
    timer = setTimeout(() => {
      timer = undefined;
      if (video.srcObject === source) togglePlayback();
    }, SINGLE_CLICK_MS);
  }, options);
  video.addEventListener("dblclick", (event) => {
    if (event.defaultPrevented || event.button !== 0 || pointerType === "touch") return;
    cancel();
    toggleFullscreen();
  }, options);
  for (const event of ["play", "pause", "emptied"]) video.addEventListener(event, cancel, options);

  return () => {
    cancel();
    listeners.abort();
  };
}
