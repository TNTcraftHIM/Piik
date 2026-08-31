// Living-room control primitives. Every glyph control keeps its copy in
// title/aria; text modes add a visible caption from the same catalog.
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { ComicTooltip } from "./ComicTooltip";
import { participantColor } from "./participant-color";
import type { ComicKind } from "./Comic";
import type { HintKind } from "./hints";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";

// Matches the global `button:disabled` look (styles.css) without the disabled
// attribute, which would swallow the pointer events and focus the comic
// tooltip needs. pointer-events: none routes hover/touch to the wrap so all
// three show channels keep working; keyboard focus is unaffected.
const SOFT_DISABLED_STYLE: CSSProperties = { opacity: 0.4, pointerEvents: "none" };

// Activation guard for soft-disabled (aria-disabled) hint triggers: the
// control stays focusable so its comic is reachable, but it never fires.
function blockSoftDisabledClick(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

// Pointer activations blur the trigger so the comic is not pinned open by
// focus after the action completes; keyboard clicks (detail 0) keep focus,
// so the panel persists for genuine keyboard use.
function blurAfterPointerClick(event: MouseEvent<HTMLButtonElement>): void {
  if (event.detail !== 0) event.currentTarget.blur();
}

// Renders the functional icon in every mode; vis mode never swaps icons for
// script — controls stay identical to the text version, hints come from the
// comic tooltip.
export function VisGlyph({
  name,
  size = 18,
  draw,
}: {
  name: GlyphName;
  size?: number;
  /** Draw-in spot id (state-beat icons only — see Glyph). */
  draw?: string;
}) {
  return <Glyph name={name} size={size} draw={draw} />;
}

export function Cap({ k }: { k: CopyKey }) {
  const { vis, t } = useCopy();
  return vis ? null : <span className="lr-cap">{t(k)}</span>;
}

export function Btn({
  icon,
  cap,
  tone,
  title,
  disabled,
  pressed,
  expanded,
  controls,
  onClick,
  type = "button",
  hint,
  draw,
}: {
  icon: GlyphName;
  cap?: CopyKey;
  tone?: "primary" | "danger" | "on";
  title: CopyKey;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Vis mode: 2-panel hint comic on hover/focus; native title stays off. */
  hint?: HintKind;
  /** Draw-in spot id for state-beat toggle icons (see Glyph). */
  draw?: string;
}) {
  const { t, vis } = useCopy();
  const label = t(title);
  const wrapped = vis && hint;
  const softDisabled = Boolean(wrapped && disabled);
  const button = (
    <button
      type={type}
      className={`lr-btn${tone ? ` is-${tone}` : ""}`}
      title={vis ? undefined : label}
      aria-label={label}
      disabled={disabled && !softDisabled}
      aria-disabled={softDisabled || undefined}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      style={softDisabled ? SOFT_DISABLED_STYLE : undefined}
      onClick={
        softDisabled
          ? blockSoftDisabledClick
          : wrapped
            ? (event) => {
                blurAfterPointerClick(event);
                onClick?.();
              }
            : onClick
      }
    >
      <Glyph name={icon} size={19} draw={draw} />
      {cap ? <Cap k={cap} /> : null}
    </button>
  );
  return wrapped ? (
    <ComicTooltip kind={wrapped}>{button}</ComicTooltip>
  ) : (
    button
  );
}

export function Chip({
  selected,
  disabled,
  onClick,
  title,
  hint,
  name,
  value,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title: string;
  /** Vis mode: 2-panel hint comic on hover/focus; native title stays off. */
  hint?: HintKind;
  name?: string;
  value?: string;
  children: ReactNode;
}) {
  const { vis } = useCopy();
  const wrapped = vis && hint;
  const softDisabled = Boolean(wrapped && disabled);
  const chip = (
    <button
      type="button"
      className={`lr-chip${selected ? " is-selected" : ""}`}
      name={name}
      value={value}
      aria-pressed={selected}
      disabled={disabled && !softDisabled}
      aria-disabled={softDisabled || undefined}
      style={softDisabled ? SOFT_DISABLED_STYLE : undefined}
      title={vis ? undefined : title}
      aria-label={title}
      onClick={
        softDisabled
          ? blockSoftDisabledClick
          : wrapped
            ? (event) => {
                blurAfterPointerClick(event);
                onClick?.();
              }
            : onClick
      }
    >
      {children}
    </button>
  );
  return wrapped ? (
    <ComicTooltip kind={wrapped}>{chip}</ComicTooltip>
  ) : (
    chip
  );
}

export function Row({
  sub,
  label,
  children,
}: {
  sub?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className={`lr-row${sub ? " is-sub" : ""}`} role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export function RowGroup({
  actions,
  children,
}: {
  actions?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={actions ? "lr-row-group lr-group-actions" : "lr-row-group"}>
      {children}
    </div>
  );
}

export function Pill({
  icon,
  tone,
  label,
  alert,
  comic,
}: {
  icon: GlyphName;
  tone?: "bad" | "good";
  label: string;
  alert?: boolean;
  comic?: ComicKind | HintKind;
}) {
  const { vis } = useCopy();
  const wrapped = vis && comic;
  const body = (
    <span
      className={`lr-pill${tone ? ` is-${tone}` : ""}`}
      role={alert ? "alert" : "status"}
      title={vis ? undefined : label}
      // Hint-wrapped bodies must take keyboard focus, or the comic is
      // unreachable for keyboard users (spans never match :focus-visible).
      tabIndex={wrapped ? 0 : undefined}
    >
      <Glyph name={icon} size={16} />
      {vis ? <span className="visually-hidden">{label}</span> : <span>{label}</span>}
    </span>
  );
  return wrapped ? (
    <ComicTooltip kind={wrapped}>{body}</ComicTooltip>
  ) : (
    body
  );
}

export function SwitchItem({
  checked,
  disabled,
  onChange,
  label,
  note,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Text modes: extra sentence appended to the title tooltip. */
  note?: string;
  /** Vis mode: 2-panel hint comic on hover/focus; native title stays off. */
  hint?: HintKind;
}) {
  const { vis } = useCopy();
  const wrapped = vis && hint;
  const softDisabled = Boolean(wrapped && disabled);
  const item = (
    <span className="lr-switch-item">
      <button
        type="button"
        className="lr-switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        title={vis ? undefined : note ? `${label} · ${note}` : label}
        disabled={disabled && !softDisabled}
        aria-disabled={softDisabled || undefined}
        style={softDisabled ? SOFT_DISABLED_STYLE : undefined}
        onClick={
          softDisabled
            ? blockSoftDisabledClick
            : (event) => {
                if (wrapped) blurAfterPointerClick(event);
                onChange(!checked);
              }
        }
      />
      {vis ? null : <span className="lr-cap">{label}</span>}
    </span>
  );
  return wrapped ? (
    <ComicTooltip kind={wrapped}>{item}</ComicTooltip>
  ) : (
    item
  );
}

export function NameTag({ name, identity }: { name: string; identity: string }) {
  const { t, vis } = useCopy();
  return (
    <span className="lr-name-tag" title={vis ? undefined : t("host.name")}>
      <i
        aria-hidden="true"
        style={{ backgroundColor: participantColor(identity) }}
      />
      <span>{name}</span>
    </span>
  );
}

export function FieldCap({ k }: { k: CopyKey }) {
  const { vis, t } = useCopy();
  return vis ? null : <span className="lr-field-cap">{t(k)}</span>;
}

export function StatusText({ children }: { children: ReactNode }) {
  const { vis } = useCopy();
  return vis ? null : (
    <span className="lr-status-text" role="status" aria-live="polite">
      {children}
    </span>
  );
}
