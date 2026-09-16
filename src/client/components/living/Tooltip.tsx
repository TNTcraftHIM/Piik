// Shared tooltip: the same comic in every mode, with a localized caption in
// text modes. Truncated literal text needs only its full value. Hover and keyboard
// focus show guidance; help-only controls also toggle it on click/tap. Hover
// waits for intent; clicking the panel dismisses it without activating below it.
// Action controls keep their click and use a 500ms touch hold for guidance,
// hiding 1.5s after release and suppressing the trailing synthetic click.
// Alignment: the align prop is a desktop-tuned preference; whenever a show
// channel opens, the trigger's live viewport position is measured and
// start/center/end is re-picked so the panel never clips off-screen (rows
// wrap at narrow widths, so a static choice cannot hold). Player controls may
// use a complete left/right placement when the whole bar has empty space;
// otherwise prefer below the television, then above the playback bar.
// The native top layer
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
import { replaySvgAnimations } from "../../ui/animation";
import { comicStyle, getComicPresentation, type ComicTone, type ComicMotion } from "./comic-presentation";

const LONG_PRESS_MS = 500;
const TOUCH_HIDE_MS = 1500;
const PANEL_EXIT_MS = 160;
const HOVER_ENTER_MS = 500;
// Minimum clearance the re-picked alignment keeps to each viewport edge.
const EDGE_MARGIN = 8;
const HOVER_EXIT_GRACE_MS = 160;
// Paper panel before its mounted content is measured.
const FALLBACK_PANEL_HEIGHT = 96;

type Align = "center" | "start" | "end";
type Placement = "above" | "below" | "left" | "right";
// The selector identifies only the visible text, excluding icons and captions.
type OverflowText = { text: string; selector: string };
type TooltipContent =
  | { kind: ComicKind | HintKind; text?: string; overflow?: OverflowText }
  | { kind?: never; text?: never; overflow: OverflowText };

export function Tooltip({
  kind,
  text,
  tone,
  motion,
  className,
  place = "above",
  align = "center",
  toggleOnClick = false,
  overflow,
  children,
}: TooltipContent & {
  tone?: ComicTone;
  motion?: ComicMotion;
  className?: string;
  /** Preferred side; use below when the working content is above the control. */
  place?: "above" | "below";
  /** Preferred alignment; re-picked at open time if it would clip off-screen. */
  align?: Align;
  /** For help-only buttons; action controls keep click and touch long-press. */
  toggleOnClick?: boolean;
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
  const hoverTimer = useRef<number | null>(null);
  const panelUnmountTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pressPoint = useRef<{ x: number; y: number } | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pressOpen, setPressOpen] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, caret: 0, placement: place as Placement });
  // True while the current gesture is a touch, so contextmenu can tell a
  // long-press from a mouse right-click without reading vendor event fields.
  const touchGesture = useRef(false);
  const enabled = kind !== undefined || overflowing;
  const caption = [overflowing ? overflow?.text : undefined, text].filter(Boolean).join(" · ") || undefined;
  const interactionOpen = enabled && (hoverOpen || focusOpen || pressOpen);
  const trigger = isValidElement<{
      disabled?: boolean;
      "aria-label"?: string;
      "aria-describedby"?: string;
      "aria-expanded"?: boolean;
      "aria-controls"?: string;
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
  const focusableWrap = disabledTrigger || (overflowing && !kind && trigger?.type !== "button");

  useLayoutEffect(() => {
    const element = overflow ? wrapRef.current?.querySelector<HTMLElement>(overflow.selector) : null;
    if (!element || !overflow) {
      setOverflowing(false);
      return;
    }
    let disposed = false;
    const measure = () => {
      // SVG topology labels are shortened before rendering; HTML names use CSS.
      if (!disposed) setOverflowing(element.textContent !== overflow.text || element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Font loading can change scrollWidth without changing the clipped box.
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [overflow?.selector, overflow?.text, trigger?.type, trigger?.key]);

  useEffect(() => {
    if (enabled) return;
    dismissPanel();
    pressPoint.current = null;
  }, [enabled]);

  const mountPanel = (replay = false) => {
    if (panelUnmountTimer.current !== null) {
      window.clearTimeout(panelUnmountTimer.current);
      panelUnmountTimer.current = null;
    }
    // A fresh gesture may reuse a panel still exiting or held by another input
    // channel. Its finished animations need the same replay as a fresh mount.
    const comic = replay && panelMounted ? tipRef.current?.querySelector("svg") : null;
    if (comic) replaySvgAnimations(comic);
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
    // A wrapped control row remains one working area, including on narrow screens.
    const controlBar = wrap.closest<HTMLElement>(".lr-playback, .lr-source-picker-options");
    const playback = controlBar?.classList.contains("lr-playback");
    const avoid = controlBar?.getBoundingClientRect() ?? rect;
    const player = wrap.closest<HTMLElement>(".lr-tv-screen")?.getBoundingClientRect();
    const below = playback
      ? wrap.closest<HTMLElement>(".lr-tv")?.getBoundingClientRect().bottom ?? avoid.bottom
      : avoid.bottom;
    const measured = panelMounted ? (tipRef.current?.offsetWidth ?? 0) : 0;
    const width = Math.max(0, Math.min(measured || 320, vw - EDGE_MARGIN * 2));
    // Same idea vertically: a control scrolled near the top has no room above,
    // and the panel would be cut off by the viewport edge.
    const vh = window.innerHeight;
    const panelHeight =
      (panelMounted ? tipRef.current?.offsetHeight : 0) || FALLBACK_PANEL_HEIGHT;
    const fitsAbove = avoid.top - panelHeight - EDGE_MARGIN >= EDGE_MARGIN;
    const fitsBelow = !vh || below + panelHeight + EDGE_MARGIN <= vh - EDGE_MARGIN;
    const preferredPlace = wrap.closest(".lr-tv-chin") ? "below" : place;
    let livePlace: Placement =
      preferredPlace === "above"
        ? fitsAbove || !fitsBelow
          ? "above"
          : "below"
        : fitsBelow || !fitsAbove
          ? "below"
          : "above";
    const centerY = rect.top + rect.height / 2;
    const sideTop = Math.max(EDGE_MARGIN, Math.min(centerY - panelHeight / 2, vh - panelHeight - EDGE_MARGIN));
    const fitsSideVertically = sideTop >= EDGE_MARGIN && sideTop + panelHeight <= (vh || Infinity) - EDGE_MARGIN;
    // Use empty side space only when the whole panel fits close to its control.
    // Otherwise clear the entire playback bar, including its narrow second row.
    if (playback) {
      // The screen edge is the side boundary when available, so a side panel
      // never hangs over the picture while clearing the bar.
      const sideAvoid = player ?? avoid;
      const nearLeft = rect.left - sideAvoid.left <= rect.width;
      const nearRight = sideAvoid.right - rect.right <= rect.width;
      const fitsLeft = nearLeft && sideAvoid.left - width - EDGE_MARGIN >= EDGE_MARGIN;
      const fitsRight = nearRight && sideAvoid.right + width + EDGE_MARGIN <= vw - EDGE_MARGIN;
      // Prefer space below the television (including its status strip) to
      // covering the picture. Fullscreen falls back above the entire bar.
      livePlace = fitsSideVertically && (fitsLeft || fitsRight) ? fitsLeft ? "left" : "right"
        : fitsBelow ? "below" : "above";
    }
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
    let left = Math.max(EDGE_MARGIN, Math.min(boxes[selected].left, vw - width - EDGE_MARGIN));
    let top = livePlace === "below" ? below + EDGE_MARGIN : avoid.top - panelHeight - EDGE_MARGIN;
    let caret = Math.max(14, Math.min(center - left, width - 14));
    if (livePlace === "left") {
      left = (player ?? avoid).left - width - EDGE_MARGIN;
      top = sideTop;
      caret = Math.max(14, Math.min(centerY - top, panelHeight - 14));
    } else if (livePlace === "right") {
      left = (player ?? avoid).right + EDGE_MARGIN;
      top = sideTop;
      caret = Math.max(14, Math.min(centerY - top, panelHeight - 14));
    }
    const border = tipRef.current ? parseFloat(getComputedStyle(tipRef.current).borderLeftWidth) || 0 : 0;
    setPosition({
      left,
      top,
      // The caret's absolute position starts inside the panel's border.
      caret: caret - border,
      placement: livePlace,
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
  }, [panelMounted, caption, kind]);
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
  }, [panelMounted, interactionOpen, caption, kind]);

  useEffect(() => {
    if (!interactionOpen) return;
    // Hover does not move keyboard focus into the trigger.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close every hint channel, including a hover panel suppressed by a
      // focused neighbour. Only visible guidance consumes the outer action.
      const style = tipRef.current && getComputedStyle(tipRef.current);
      if (style?.visibility === "visible" && style.pointerEvents !== "none") event.preventDefault();
      dismissPanel();
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
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (panelUnmountTimer.current !== null) {
        window.clearTimeout(panelUnmountTimer.current);
      }
    },
    [],
  );

  // Clicking elsewhere dismisses guidance regardless of how it was opened.
  useEffect(() => {
    if (!interactionOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        dismissPanel();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [interactionOpen]);

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const cancelHover = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const dismissPanel = () => {
    cancelHover();
    cancelPress();
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHoverOpen(false);
    setPressOpen(false);
    setFocusOpen(false);
  };
  const placeClass = position.placement === "above" ? "" : ` is-${position.placement}`;
  return (
    <span
      ref={wrapRef}
      className={`lr-comic-tip-wrap${className ? ` ${className}` : ""}${toggleOnClick ? " is-help-only" : ""}${disabledTrigger ? " is-disabled-trigger" : ""}${hoverOpen ? " is-hover-open" : ""}${focusOpen ? " is-focus-open" : ""}${pressOpen ? " is-tip-open" : ""}`}
      tabIndex={focusableWrap ? 0 : undefined}
      aria-label={disabledTriggerLabel ?? (focusableWrap ? trigger?.props["aria-label"] ?? overflow?.text : undefined)}
      aria-describedby={disabledTrigger && caption && interactionOpen ? tooltipId : undefined}
      onPointerEnter={(event) => {
        if (!enabled || event.pointerType === "touch" || event.buttons !== 0) return;
        cancelHover();
        if (interactionOpen) {
          setHoverOpen(true);
          return;
        }
        // No mounted panel or invisible hit area while passing over a control.
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = null;
          pickAlignRef.current();
          mountPanel(true);
          setHoverOpen(true);
        }, HOVER_ENTER_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        cancelHover();
        if (!hoverOpen) return;
        // A two-row playback bar lies between some triggers and their hint.
        // A short grace lets the pointer cross it without an invisible hit
        // target covering neighbouring buttons.
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = null;
          setHoverOpen(false);
        }, HOVER_EXIT_GRACE_MS);
      }}
      onFocus={(event) => {
        if (!enabled) return;
        pickAlign();
        if ((event.target as HTMLElement).matches(":focus-visible")) {
          cancelHover();
          mountPanel(true);
          setFocusOpen(true);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusOpen(false);
          if (toggleOnClick) setPressOpen(false);
        }
      }}
      onPointerDown={(event) => {
        cancelHover();
        if (event.pointerType !== "touch" && !toggleOnClick && !tipRef.current?.contains(event.target as Node)) {
          dismissPanel();
        }
        // A suppression token belongs only to the click synthesized for the
        // completed long-press. A later touch starts a new, actionable gesture.
        longPressed.current = false;
        cancelPress();
        touchGesture.current = event.pointerType === "touch";
        if (!enabled || event.pointerType !== "touch") return;
        pressPoint.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          longPressed.current = true;
          mountPanel(true);
          pickAlign();
          setPressOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={() => {
        cancelPress();
        pressPoint.current = null;
        if (longPressed.current && enabled) {
          if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
          hideTimer.current = window.setTimeout(() => {
            hideTimer.current = null;
            longPressed.current = false;
            setPressOpen(false);
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
        setPressOpen(false);
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
        if (!enabled || !touchGesture.current) return;
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
        } else if (tipRef.current?.contains(event.target as Node)) {
          // This click only clears guidance; never pass it to a covered action.
          event.stopPropagation();
          // Dragging to select a caption or full nickname is still reading.
          const selection = window.getSelection();
          if (!selection?.isCollapsed && tipRef.current.contains(selection?.anchorNode ?? null)) return;
          dismissPanel();
        } else if (!toggleOnClick && event.detail !== 0) {
          dismissPanel();
        }
      }}
      onClick={enabled && toggleOnClick && !disabledTrigger ? (event) => {
        if (tipRef.current?.contains(event.target as Node)) return;
        if (pressOpen) {
          dismissPanel();
        } else {
          mountPanel(true);
          pickAlign();
          setPressOpen(true);
        }
      } : undefined}
      onKeyDown={(event) => {
        if (!enabled) return;
        if (event.key !== "Escape" && (event.target as HTMLElement).matches(":focus-visible")) {
          mountPanel(!interactionOpen);
          setFocusOpen(true);
        }
      }}
    >
      {trigger && (caption || toggleOnClick) ? cloneElement(trigger, {
        "aria-describedby": [trigger.props["aria-describedby"], kind && interactionOpen ? tooltipId : undefined].filter(Boolean).join(" ") || undefined,
        "aria-expanded": toggleOnClick ? interactionOpen : trigger.props["aria-expanded"],
        "aria-controls": toggleOnClick ? tooltipId : trigger.props["aria-controls"],
      }) : children}
      <span ref={tipRef} id={tooltipId} popover="manual"
        data-tone={resolvedTone}
        style={{ ...comicStyle(resolvedTone, resolvedMotion), "--comic-repeat": "infinite", left: position.left, top: position.top, "--tooltip-caret": `${position.caret}px` } as CSSProperties}
        className={`lr-comic-tip${kind ? " has-comic" : ""}${caption !== undefined ? " is-text" : ""}${placeClass}`} role="tooltip" aria-hidden={!interactionOpen}>
        {panelMounted ? <>
          {kind ? isHintKind(kind)
              ? <HintComic kind={kind} size={200} tone={resolvedTone} motion={resolvedMotion} />
              : <Comic kind={kind} theme="paper" size={200} tone={resolvedTone} motion={resolvedMotion} /> : null}
          {caption !== undefined ? <span className="lr-comic-tip-caption">{caption}</span> : null}
        </> : null}
      </span>
    </span>
  );
}
