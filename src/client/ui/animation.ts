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
    graphic.closest<HTMLElement>(
      "button, a, [role='button'], [role='img'], .lr-tv-big",
    ) ?? graphic;
  const handlePointerOver = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") return;
    if (pointer.relatedTarget instanceof Node && owner.contains(pointer.relatedTarget)) {
      return;
    }
    replaySvgAnimations(graphic);
  };
  owner.addEventListener("pointerover", handlePointerOver);
  return () => owner.removeEventListener("pointerover", handlePointerOver);
}
