// Living-room control primitives. Every glyph control keeps its copy in
// tooltip/aria; text modes add a visible caption from the same catalog.
import { useId, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";
import { participantColor } from "./participant-color";
import type { ComicKind } from "./Comic";
import type { HintKind } from "./hints";
import type { ComicTone, ComicMotion } from "./comic-presentation";
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
// so the panel persists for genuine keyboard use. Run the action first:
// leaving an enclosing field group may otherwise commit a superseded draft.
function blurAfterPointerClick(event: MouseEvent<HTMLButtonElement>): void {
  if (event.detail !== 0) event.currentTarget.blur();
}

export function Cap({ k }: { k: CopyKey }) {
  const { vis, t } = useCopy();
  return vis ? null : <span className="lr-cap">{t(k)}</span>;
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return <Btn icon="arrowLeft" title="common.back" cap="common.back" size="dense" quiet hint="hint-collapse" onClick={onClick} />;
}

export function Btn({
  id,
  icon,
  cap,
  tone,
  size,
  quiet = false,
  title,
  disabled,
  busy,
  pressed,
  expanded,
  controls,
  popoverTarget,
  onClick,
  type = "button",
  hint,
  hintText,
  hintTone,
  hintMotion,
  draw,
  iconOverlay,
}: {
  id?: string;
  icon: GlyphName;
  cap?: CopyKey;
  tone?: "primary" | "danger" | "on";
  size?: "compact" | "dense";
  quiet?: boolean;
  title: CopyKey;
  disabled?: boolean;
  busy?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  popoverTarget?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Shared hint comic; text modes add the localized caption. */
  hint?: ComicKind | HintKind;
  /** Optional explanation beyond the control's accessible name. */
  hintText?: CopyKey;
  hintTone?: ComicTone;
  hintMotion?: ComicMotion;
  /** Draw-in spot id for state-beat toggle icons (see Glyph). */
  draw?: string;
  /** Noninteractive artwork that moves with the icon, such as its input meter. */
  iconOverlay?: ReactNode;
}) {
  const { t, vis } = useCopy();
  const label = t(title);
  const wrapped = Boolean(hint);
  const softDisabled = Boolean(wrapped && disabled);
  const activeTone = tone ?? (pressed ? "on" : undefined);
  const button = (
    <button
      id={id}
      type={type}
      className={`lr-btn${size ? ` is-${size}` : ""}${quiet ? " is-quiet" : ""}${activeTone ? ` is-${activeTone}` : ""}`}
      aria-label={label}
      disabled={disabled && !softDisabled}
      aria-disabled={softDisabled || undefined}
      aria-busy={busy || undefined}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      popoverTarget={popoverTarget}
      style={softDisabled ? SOFT_DISABLED_STYLE : undefined}
      onClick={
        softDisabled
          ? blockSoftDisabledClick
          : wrapped
            ? (event) => {
                onClick?.();
                blurAfterPointerClick(event);
              }
            : onClick
      }
    >
      <Glyph
        key={draw ? (busy ? "loader" : icon) : undefined}
        name={busy ? "loader" : icon}
        size={19}
        draw={draw}
        className={busy ? "lr-spin" : undefined}
      />
      {iconOverlay}
      {cap ? <Cap k={cap} /> : null}
    </button>
  );
  return hint ? (
    <Tooltip kind={hint} disabled={expanded} tone={hintTone} motion={hintMotion} text={vis ? undefined : hintText ? t(hintText) : label}>{button}</Tooltip>
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
  hintText,
  name,
  value,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title: string;
  /** Shared hint comic; text modes add the localized caption. */
  hint?: HintKind;
  hintText?: string;
  name?: string;
  value?: string;
  children: ReactNode;
}) {
  const { vis } = useCopy();
  const wrapped = Boolean(hint);
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
      aria-label={disabled && hintText ? `${title} · ${hintText}` : title}
      onClick={
        softDisabled
          ? blockSoftDisabledClick
          : wrapped
            ? (event) => {
                onClick?.();
                blurAfterPointerClick(event);
              }
            : onClick
      }
    >
      {children}
    </button>
  );
  return hint ? (
    <Tooltip kind={hint} text={vis ? undefined : hintText ?? title}>{chip}</Tooltip>
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
  motion = "still",
}: {
  icon: GlyphName;
  tone?: ComicTone;
  label: string;
  alert?: boolean;
  comic: ComicKind | HintKind;
  motion?: ComicMotion;
}) {
  const { vis } = useCopy();
  const resolvedTone = tone ?? "warn";
  const body = (
    <button
      type="button"
      className={`lr-pill is-${resolvedTone === "live" ? "good" : resolvedTone}`}
    >
      <Glyph name={icon} size={16} />
      {vis ? <span className="visually-hidden">{label}</span> : <span>{label}</span>}
    </button>
  );
  return (
    <span role={alert ? "alert" : "status"}>
      <Tooltip toggleOnClick kind={comic} tone={resolvedTone} motion={motion}
        text={vis ? undefined : label}>{body}</Tooltip>
    </span>
  );
}

export function SwitchItem({
  checked,
  disabled,
  locked,
  onChange,
  label,
  note,
  hint,
  icon,
}: {
  checked: boolean;
  disabled?: boolean;
  /** Configuration fixes this switch's value; keep the control and explain why. */
  locked?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Text modes: extra sentence in the tooltip. */
  note?: string;
  /** Shared hint comic; native title stays off. */
  hint?: HintKind;
  /** Preserve the control's meaning when its text label is hidden. */
  icon?: GlyphName;
}) {
  const { vis, t } = useCopy();
  const id = useId();
  const wrapped = Boolean(hint);
  const softDisabled = Boolean(wrapped && disabled);
  const description = note ? `${label}\n${note}` : label;
  const tooltipText = disabled || locked ? description
    : `${t(checked ? "common.disable" : "common.enable", { name: label })}${note ? `\n${note}` : ""}`;
  const control = (
      <button id={id}
        type="button"
        className="lr-switch"
        role="switch"
        aria-checked={checked}
        aria-label={description}
        disabled={disabled && !softDisabled}
        aria-disabled={softDisabled || undefined}
        style={softDisabled ? SOFT_DISABLED_STYLE : undefined}
        onClick={
          softDisabled
            ? blockSoftDisabledClick
            : (event) => {
                onChange(!checked);
                if (wrapped) blurAfterPointerClick(event);
              }
        }
      />
  );
  return <span className="lr-switch-item">
    {vis && icon ? <Glyph name={icon} size={18} /> : null}
    {hint ? <Tooltip kind={hint} text={vis ? undefined : tooltipText}>{control}</Tooltip> : control}
    {locked ? <Glyph name="lock" size={12} /> : null}
    {vis ? null : <label className="lr-cap" htmlFor={id}>{label}</label>}
  </span>;
}

export function NameTag({ name, identity }: { name: string; identity: string }) {
  return (
    <Tooltip overflow={{ text: name, selector: ".lr-name-tag > span" }} className="lr-name-hint">
      <span className="lr-name-tag">
        <i
          aria-hidden="true"
          style={{ backgroundColor: participantColor(identity) }}
        />
        <span>{name}</span>
      </span>
    </Tooltip>
  );
}

export function FieldCap({ k }: { k: CopyKey }) {
  const { vis, t } = useCopy();
  return vis ? null : <span className="lr-field-cap">{t(k)}</span>;
}
