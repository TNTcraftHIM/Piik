// Shared tooltip: a floating paper panel showing text or a comic above (or below)
// its trigger. Visibility is three-channel, matching platform conventions:
// hover on fine pointers, keyboard focus via :has(:focus-visible), and the
// Material long-press on touch (500ms hold → open, ~1.5s after release →
// auto-hide, context menu and the trailing synthetic click suppressed).
// Alignment: the align prop is a desktop-tuned preference; whenever a show
// channel opens, the trigger's live viewport position is measured and
// start/center/end is re-picked so the panel never clips off-screen (rows
// wrap at narrow widths, so a static choice cannot hold). The native top layer
// avoids clipping by scrolling lists; the caret points back to the trigger.
// Styling in styles.css under "comic tooltip" / "glyph draw-in". SSR-safe:
// handlers only run in the browser.

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Comic, type ComicKind } from "./Comic";
import { HintComic, isHintKind, type HintKind } from "./hints";
import { isCopyKey, say } from "../../ui/copy";
import { comicStyle, getComicPresentation, type ComicTone, type ComicMotion } from "./comic-presentation";

const LONG_PRESS_MS = 500;
const TOUCH_HIDE_MS = 1500;
const PANEL_EXIT_MS = 160;
// Minimum clearance the re-picked alignment keeps to each viewport edge.
const EDGE_MARGIN = 8;
// Paper panel before it is measured: 240-wide comic strip plus its padding.
const FALLBACK_PANEL_HEIGHT = 96;

type Align = "center" | "start" | "end";

export function Tooltip({
  kind,
  text,
  tone,
  motion,
  className,
  place = "above",
  align = "center",
  children,
}: {
  kind?: ComicKind | HintKind;
  text?: string;
  tone?: ComicTone;
  motion?: ComicMotion;
  className?: string;
  /** below = for controls pinned to the viewport top (header). */
  place?: "above" | "below";
  /** Preferred alignment; re-picked at open time if it would clip off-screen. */
  align?: Align;
  children: ReactNode;
}) {
  const defaults = getComicPresentation(kind);
  const resolvedTone = tone ?? defaults.tone;
  const resolvedMotion = motion ?? defaults.motion;
  const tooltipId = useId();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const pressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const panelUnmountTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, caret: 0, below: place === "below" });
  // True while the current gesture is a touch, so contextmenu can tell a
  // long-press from a mouse right-click without reading vendor event fields.
  const touchGesture = useRef(false);
  const interactionOpen = hoverOpen || focusOpen || touchOpen;
  const trigger = isValidElement<{
      disabled?: boolean;
      "aria-label"?: string;
      "aria-describedby"?: string;
      label?: string;
      title?: string;
    }>(children) ? children : null;
  const disabledTrigger = trigger?.props.disabled === true;
  const rawDisabledTriggerLabel = disabledTrigger && trigger
    ? trigger.props["aria-label"] ??
      trigger.props.label ??
      trigger.props.title
    : undefined;
  const disabledTriggerLabel =
    rawDisabledTriggerLabel && isCopyKey(rawDisabledTriggerLabel)
      ? say(rawDisabledTriggerLabel)
      : rawDisabledTriggerLabel;

  const mountPanel = () => {
    if (panelUnmountTimer.current !== null) {
      window.clearTimeout(panelUnmountTimer.current);
      panelUnmountTimer.current = null;
    }
    setPanelMounted(true);
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
    const measured = panelMounted ? (tipRef.current?.offsetWidth ?? 0) : 0;
    const width = Math.max(0, Math.min(measured || 320, vw - EDGE_MARGIN * 2));
    // Same idea vertically: a control scrolled near the top has no room above,
    // and the panel would be cut off by the viewport edge.
    const vh = window.innerHeight;
    const panelHeight =
      (panelMounted ? tipRef.current?.offsetHeight : 0) || FALLBACK_PANEL_HEIGHT;
    const fitsAbove = rect.top - panelHeight - EDGE_MARGIN >= 0;
    const fitsBelow = !vh || rect.bottom + panelHeight + EDGE_MARGIN <= vh;
    const livePlace =
      place === "above"
        ? fitsAbove || !fitsBelow
          ? "above"
          : "below"
        : fitsBelow || !fitsAbove
          ? "below"
          : "above";
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
    const selected = fits ?? order.reduce((a, b) => (clipped(boxes[a]) <= clipped(boxes[b]) ? a : b));
    const left = Math.max(EDGE_MARGIN, Math.min(boxes[selected].left, vw - width - EDGE_MARGIN));
    setPosition({
      left,
      top: livePlace === "below" ? rect.bottom + EDGE_MARGIN : rect.top - panelHeight - EDGE_MARGIN,
      caret: Math.max(14, Math.min(center - left, width - 14)),
      below: livePlace === "below",
    });
  };

  // Single owner of panel placement: while the tooltip may be open (hover,
  // focus, or long-press), viewport resize/scroll re-picks the alignment so
  // the panel stays inside the viewport mid-open — no page-level clamps.
  const pickAlignRef = useRef(pickAlign);
  pickAlignRef.current = pickAlign;
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (panelMounted) {
      // Native top layer escapes couch, table and source-list overflow without
      // a portal or a second set of trigger/interaction owners.
      tip?.showPopover?.();
      pickAlignRef.current();
    } else {
      tip?.hidePopover?.();
    }
  }, [panelMounted, text, kind]);
  useEffect(() => {
    if (!interactionOpen || !panelMounted) return;
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
  }, [panelMounted, interactionOpen, text, kind]);

  useEffect(() => {
    if (!interactionOpen) return;
    // Hover does not move keyboard focus into the trigger.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHoverOpen(false);
      setTouchOpen(false);
      setFocusOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [interactionOpen]);

  useEffect(() => {
    if (interactionOpen || !panelMounted) return;
    panelUnmountTimer.current = window.setTimeout(() => {
      panelUnmountTimer.current = null;
      setPanelMounted(false);
    }, PANEL_EXIT_MS);
    return () => {
      if (panelUnmountTimer.current !== null) {
        window.clearTimeout(panelUnmountTimer.current);
        panelUnmountTimer.current = null;
      }
    };
  }, [panelMounted, interactionOpen]);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (panelUnmountTimer.current !== null) {
        window.clearTimeout(panelUnmountTimer.current);
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

  const placeClass = position.below ? " is-below" : "";
  return (
    <span
      ref={wrapRef}
      className={`lr-comic-tip-wrap${className ? ` ${className}` : ""}${disabledTrigger ? " is-disabled-trigger" : ""}${hoverOpen ? " is-hover-open" : ""}${focusOpen ? " is-focus-open" : ""}${touchOpen ? " is-tip-open" : ""}`}
      tabIndex={disabledTrigger ? 0 : undefined}
      aria-label={disabledTriggerLabel}
      aria-describedby={disabledTrigger && text && interactionOpen ? tooltipId : undefined}
      onPointerEnter={(event) => {
        pickAlign();
        if (event.pointerType !== "touch") {
          mountPanel();
          setHoverOpen(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setHoverOpen(false);
      }}
      onFocus={(event) => {
        pickAlign();
        if ((event.target as HTMLElement).matches(":focus-visible")) {
          mountPanel();
          setFocusOpen(true);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusOpen(false);
        }
      }}
      onPointerDown={(event) => {
        touchGesture.current = event.pointerType === "touch";
        if (event.pointerType !== "touch") return;
        // A suppression token belongs only to the click synthesized for the
        // completed long-press. A later touch starts a new, actionable gesture.
        longPressed.current = false;
        cancelPress();
        pressPoint.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          longPressed.current = true;
          mountPanel();
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
        // native context menu. Only that gesture is suppressed: a mouse
        // right-click (no touch pointerdown) and any menu raised over a text
        // field (its paste/select entries are the only way in) stay native.
        if (!touchGesture.current) return;
        if (
          (event.target as HTMLElement).closest(
            "input, textarea, [contenteditable=\"true\"]",
          )
        ) {
          return;
        }
        event.preventDefault();
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
        if (event.key !== "Escape" && (event.target as HTMLElement).matches(":focus-visible")) {
          mountPanel();
          setFocusOpen(true);
        }
      }}
    >
      {trigger && text ? cloneElement(trigger, {
        "aria-describedby": [trigger.props["aria-describedby"], interactionOpen ? tooltipId : undefined].filter(Boolean).join(" ") || undefined,
      }) : children}
      <span ref={tipRef} id={tooltipId} popover="manual"
        data-tone={resolvedTone}
        style={{ ...comicStyle(resolvedTone, resolvedMotion), left: position.left, top: position.top, "--tooltip-caret": `${position.caret}px` } as CSSProperties}
        className={`lr-comic-tip${text !== undefined ? " is-text" : ""}${placeClass}`} role="tooltip" aria-hidden={!interactionOpen}>
        {panelMounted
          ? text ?? (kind
            ? isHintKind(kind)
              ? <HintComic kind={kind} size={240} tone={resolvedTone} motion={resolvedMotion} />
              : <Comic kind={kind} theme="paper" size={240} tone={resolvedTone} motion={resolvedMotion} />
            : null)
          : null}
      </span>
    </span>
  );
}
