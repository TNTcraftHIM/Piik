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

import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Comic, type ComicKind } from "./Comic";
import { HintComic, isHintKind, type HintKind } from "./hints";
import { isCopyKey, say } from "../../ui/copy";

const LONG_PRESS_MS = 500;
const TOUCH_HIDE_MS = 1500;
const COMIC_EXIT_MS = 160;
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
  const comicUnmountTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [comicMounted, setComicMounted] = useState(false);
  const [liveAlign, setLiveAlign] = useState<Align | null>(null);
  const interactionOpen = hoverOpen || focusOpen || touchOpen;
  const disabledTrigger =
    isValidElement<{
      disabled?: boolean;
      "aria-label"?: string;
      label?: string;
      title?: string;
    }>(children) &&
    children.props.disabled === true;
  const rawDisabledTriggerLabel = disabledTrigger
    ? children.props["aria-label"] ??
      children.props.label ??
      children.props.title
    : undefined;
  const disabledTriggerLabel =
    rawDisabledTriggerLabel && isCopyKey(rawDisabledTriggerLabel)
      ? say(rawDisabledTriggerLabel)
      : rawDisabledTriggerLabel;

  const mountComic = () => {
    if (comicUnmountTimer.current !== null) {
      window.clearTimeout(comicUnmountTimer.current);
      comicUnmountTimer.current = null;
    }
    setComicMounted(true);
  };

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
    const measured = comicMounted ? (tipRef.current?.offsetWidth ?? 0) : 0;
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
    if (!interactionOpen || !comicMounted) return;
    let frame = 0;
    const schedulePick = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => pickAlignRef.current());
    };
    schedulePick();
    window.addEventListener("resize", schedulePick);
    window.addEventListener("scroll", schedulePick, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePick);
      window.removeEventListener("scroll", schedulePick, true);
    };
  }, [comicMounted, interactionOpen]);

  useEffect(() => {
    if (interactionOpen || !comicMounted) return;
    comicUnmountTimer.current = window.setTimeout(() => {
      comicUnmountTimer.current = null;
      setComicMounted(false);
    }, COMIC_EXIT_MS);
    return () => {
      if (comicUnmountTimer.current !== null) {
        window.clearTimeout(comicUnmountTimer.current);
        comicUnmountTimer.current = null;
      }
    };
  }, [comicMounted, interactionOpen]);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (comicUnmountTimer.current !== null) {
        window.clearTimeout(comicUnmountTimer.current);
      }
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
      className={`lr-comic-tip-wrap${disabledTrigger ? " is-disabled-trigger" : ""}${hoverOpen ? " is-hover-open" : ""}${focusOpen ? " is-focus-open" : ""}${touchOpen ? " is-tip-open" : ""}`}
      tabIndex={disabledTrigger ? 0 : undefined}
      aria-label={disabledTriggerLabel}
      onPointerEnter={(event) => {
        pickAlign();
        if (event.pointerType !== "touch") {
          mountComic();
          setHoverOpen(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setHoverOpen(false);
      }}
      onFocus={(event) => {
        pickAlign();
        if ((event.target as HTMLElement).matches(":focus-visible")) {
          mountComic();
          setFocusOpen(true);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusOpen(false);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        // A suppression token belongs only to the click synthesized for the
        // completed long-press. A later touch starts a new, actionable gesture.
        longPressed.current = false;
        cancelPress();
        pressPoint.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          longPressed.current = true;
          mountComic();
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
            hideTimer.current = null;
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
          longPressed.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setHoverOpen(false);
          setTouchOpen(false);
          setFocusOpen(false);
        } else if ((event.target as HTMLElement).matches(":focus-visible")) {
          mountComic();
          setFocusOpen(true);
        }
      }}
    >
      {children}
      <span ref={tipRef} className={`lr-comic-tip${placeClass}${alignClass}`} role="note">
        {comicMounted
          ? isHintKind(kind)
            ? <HintComic kind={kind} size={240} />
            : <Comic kind={kind} theme="paper" size={240} />
          : null}
      </span>
    </span>
  );
}
