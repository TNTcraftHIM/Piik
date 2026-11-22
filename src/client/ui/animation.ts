/** Shared CSS tokens use milliseconds; callers pass an element in the rendered surface. */
export function motionDuration(element: Element, role: "press" | "feedback" | "control" | "surface" | "emphasis"): number {
  return parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(`--motion-${role}`));
}

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

/** Replay on entering the control unless its beforeReplay hook returns false. */
export function bindSvgReplayOnPointerEnter(
  graphic: SVGSVGElement,
  beforeReplay?: () => boolean | void,
): () => void {
  const owner =
    graphic.closest<HTMLElement>(
      "button, a, [role='button'], [role='img']",
    ) ?? graphic;
  const replay = () => {
    if (beforeReplay?.() !== false) replaySvgAnimations(graphic);
  };
  const handlePointerOver = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") return;
    if (pointer.relatedTarget instanceof Node && owner.contains(pointer.relatedTarget)) {
      return;
    }
    replay();
  };
  owner.addEventListener("pointerover", handlePointerOver);
  const handleFocus = () => {
    if (owner.matches(":focus-visible")) replay();
  };
  owner.addEventListener("focusin", handleFocus);
  return () => {
    owner.removeEventListener("pointerover", handlePointerOver);
    owner.removeEventListener("focusin", handleFocus);
  };
}
