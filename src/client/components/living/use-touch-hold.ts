import { useLayoutEffect, useRef } from "react";

const LONG_PRESS_MS = 500;
type PointerPosition = Pick<PointerEvent, "clientX" | "clientY">;

export function useTouchHold(view: Window | null | undefined, tolerance: number) {
  const pending = useRef<(PointerPosition & { timer: number }) | null>(null);
  const cancel = () => {
    if (pending.current) view?.clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useLayoutEffect(() => cancel, [view]);

  return {
    cancel,
    start: ({ clientX, clientY }: PointerPosition, onHold: () => void) => {
      cancel();
      if (!view) return;
      const timer = view.setTimeout(() => {
        pending.current = null;
        onHold();
      }, LONG_PRESS_MS);
      pending.current = { clientX, clientY, timer };
    },
    move: ({ clientX, clientY }: PointerPosition) => {
      const origin = pending.current;
      // Small settling moves are part of the hold. Only movement beyond the
      // caller's tolerance cancels recognition.
      if (origin && Math.hypot(clientX - origin.clientX, clientY - origin.clientY) > tolerance) cancel();
    },
  };
}
