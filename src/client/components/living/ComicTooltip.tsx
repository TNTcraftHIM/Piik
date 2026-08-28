// Comic tooltip: a floating paper panel showing a panel comic above (or below)
// its trigger. Visibility is three-channel, matching platform conventions:
// hover on fine pointers, keyboard focus via :has(:focus-visible), and the
// Material long-press on touch (500ms hold → open, ~1.5s after release →
// auto-hide, context menu and the trailing synthetic click suppressed).
// Alignment: the align prop is a desktop-tuned preference; whenever a show
// channel opens, the trigger's live viewport position is measured and
// start/center/end is re-picked so the panel never clips off-screen (rows
// wrap at narrow widths, so a static choice cannot hold). The caret lives on
// the wrapper, so it stays centered on the trigger whatever the panel picks.
// Styling in styles.css under "comic tooltip" / "glyph draw-in". SSR-safe:
// handlers only run in the browser.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Comic, type ComicKind } from "./Comic";
import { HintComic, isHintKind, type HintKind } from "./hints";

const LONG_PRESS_MS = 500;
const TOUCH_HIDE_MS = 1500;
// Minimum clearance the re-picked alignment keeps to each viewport edge.
const EDGE_MARGIN = 8;

type Align = "center" | "start" | "end";

export function ComicTooltip({
  kind,
  place = "above",
  align = "center",
  children,
}: {
  kind: ComicKind | HintKind;
  /** below = for controls pinned to the viewport top (header). */
  place?: "above" | "below";
  /** Preferred alignment; re-picked at open time if it would clip off-screen. */
  align?: Align;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const pressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const [touchOpen, setTouchOpen] = useState(false);
  const [liveAlign, setLiveAlign] = useState<Align | null>(null);

  // Re-pick alignment from the trigger's live geometry. The configured align
  // wins whenever it fits; otherwise the first alignment that keeps the whole
  // panel inside the viewport, then whichever clips least (panel wider than
  // the viewport is impossible — CSS caps it — but stay total).
  const pickAlign = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const vw = window.innerWidth;
    if (!vw) return; // no layout (SSR/test): keep the prop alignment
    const rect = wrap.getBoundingClientRect();
    const measured = tipRef.current?.offsetWidth ?? 0;
    const width = Math.max(0, Math.min(measured || 320, vw - EDGE_MARGIN * 2));
    const center = rect.left + rect.width / 2;
    const boxes: Record<Align, { left: number; right: number }> = {
      center: { left: center - width / 2, right: center + width / 2 },
      start: { left: rect.left, right: rect.left + width },
      end: { left: rect.right - width, right: rect.right },
    };
    const clipped = (box: { left: number; right: number }): number =>
      Math.max(0, EDGE_MARGIN - box.left) +
      Math.max(0, box.right - (vw - EDGE_MARGIN));
    const order: Align[] = [
      align,
      ...(["center", "start", "end"] as Align[]).filter((a) => a !== align),
    ];
    const fits = order.find((a) => clipped(boxes[a]) === 0);
    setLiveAlign(
      fits ??
        order.reduce((a, b) => (clipped(boxes[a]) <= clipped(boxes[b]) ? a : b)),
    );
  };

  // Single owner of panel placement: while the tooltip may be open (hover,
  // focus, or long-press), viewport resize/scroll re-picks the alignment so
  // the panel stays inside the viewport mid-open — no page-level clamps.
  const pickAlignRef = useRef(pickAlign);
  pickAlignRef.current = pickAlign;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let frame = 0;
    let listening = false;
    const schedulePick = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => pickAlignRef.current());
    };
    const open = () => {
      if (listening) return;
      listening = true;
      window.addEventListener("resize", schedulePick);
      window.addEventListener("scroll", schedulePick, true);
    };
    const close = () => {
      if (!listening) return;
      listening = false;
      window.removeEventListener("resize", schedulePick);
      window.removeEventListener("scroll", schedulePick, true);
    };
    wrap.addEventListener("pointerenter", open);
    wrap.addEventListener("pointerleave", close);
    wrap.addEventListener("focusin", open);
    wrap.addEventListener("focusout", close);
    return () => {
      window.cancelAnimationFrame(frame);
      close();
      wrap.removeEventListener("pointerenter", open);
      wrap.removeEventListener("pointerleave", close);
      wrap.removeEventListener("focusin", open);
      wrap.removeEventListener("focusout", close);
    };
  }, []);

  // The long-press channel outlives the touch contact: listen while open.
  useEffect(() => {
    if (!touchOpen) return;
    let frame = 0;
    const schedulePick = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => pickAlignRef.current());
    };
    window.addEventListener("resize", schedulePick);
    window.addEventListener("scroll", schedulePick, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePick);
      window.removeEventListener("scroll", schedulePick, true);
    };
  }, [touchOpen]);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // While long-press-open, any tap elsewhere dismisses (WCAG dismissible).
  useEffect(() => {
    if (!touchOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setTouchOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [touchOpen]);

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const placeClass = place === "below" ? " is-below" : "";
  const shownAlign = liveAlign ?? align;
  const alignClass =
    shownAlign === "start" ? " is-start" : shownAlign === "end" ? " is-end" : "";
  return (
    <span
      ref={wrapRef}
      className={`lr-comic-tip-wrap${touchOpen ? " is-tip-open" : ""}`}
      onPointerEnter={pickAlign}
      onFocus={pickAlign}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        cancelPress();
        pressPoint.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          longPressed.current = true;
          pickAlign();
          setTouchOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={() => {
        cancelPress();
        pressPoint.current = null;
        if (longPressed.current) {
          if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
          hideTimer.current = window.setTimeout(() => {
            longPressed.current = false;
            setTouchOpen(false);
          }, TOUCH_HIDE_MS);
        }
      }}
      onPointerCancel={() => {
        cancelPress();
        pressPoint.current = null;
        longPressed.current = false;
        if (hideTimer.current !== null) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        setTouchOpen(false);
      }}
      onPointerMove={(event) => {
        // Only a real drag (scroll intent) cancels the hold — Chrome emits
        // sub-pixel settling moves right after touchstart that must not count.
        if (pressTimer.current !== null && event.pointerType === "touch" && pressPoint.current) {
          const dx = event.clientX - pressPoint.current.x;
          const dy = event.clientY - pressPoint.current.y;
          if (dx * dx + dy * dy > 100) cancelPress();
        }
      }}
      onContextMenu={(event) => {
        // Long-press on a wrapped control means "show the hint", never the
        // native context menu. Chrome fires contextmenu as a PointerEvent;
        // fall back to treating unknown types as touch.
        if ((event.nativeEvent as PointerEvent).pointerType !== "mouse") {
          event.preventDefault();
        }
      }}
      onClickCapture={(event) => {
        // The synthetic click after a long-press must not fire the control.
        if (longPressed.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setTouchOpen(false);
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
      }}
    >
      {children}
      <span ref={tipRef} className={`lr-comic-tip${placeClass}${alignClass}`} role="note">
        {isHintKind(kind) ? (
          <HintComic kind={kind} size={240} />
        ) : (
          <Comic kind={kind} theme="paper" size={240} />
        )}
      </span>
    </span>
  );
}
