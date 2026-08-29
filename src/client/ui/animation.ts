/** Restart the CSS animations owned by one marked interactive graphic. */
export function replaySvgAnimations(root: Element): void {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    for (const animation of element.getAnimations()) {
      try {
        animation.cancel();
        animation.play();
      } catch {
        // The graphic can leave the document during a pointer transition.
      }
    }
  }
}

/** Replay a marked graphic whenever its owning interactive surface is entered. */
export function bindSvgReplayOnPointerEnter(
  graphic: SVGSVGElement,
): () => void {
  const owner =
    graphic.closest<HTMLElement>("button, a, [role='button']") ?? graphic;
  const handlePointerEnter = (event: Event) => {
    if ((event as PointerEvent).pointerType !== "touch") {
      replaySvgAnimations(graphic);
    }
  };
  owner.addEventListener("pointerenter", handlePointerEnter);
  return () => owner.removeEventListener("pointerenter", handlePointerEnter);
}
