import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export function NumberControl({ value, min, max, step, unit, showUnit = true, name, label, disabled, onChange, className, children }: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  showUnit?: boolean;
  name: string;
  label: string;
  disabled: boolean;
  onChange: (value: number) => void;
  className: string;
  children: (input: ReactNode, select: (value: number) => void) => ReactNode;
}) {
  const { t } = useCopy();
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current!.value = String(value); }, [value]);
  useEffect(() => setInvalid(false), [value, min, max, step]);
  const reset = () => { input.current!.value = String(value); setInvalid(false); };
  const select = (next: number) => {
    // A preset or slider replaces the draft, including a choice of the current value.
    reset();
    if (next !== value) onChange(next);
  };
  const adjust = (direction: number) => {
    const field = input.current!;
    if (direction > 0) field.stepUp(); else field.stepDown();
    const valid = field.validity.valid && Number.isFinite(field.valueAsNumber);
    if (valid) select(field.valueAsNumber); else setInvalid(true);
  };
  const number = <span className="lr-input lr-quality-number">
    <input ref={input} type="number" inputMode={step < 1 ? "decimal" : "numeric"} name={name}
      defaultValue={value} min={min} max={max} step={step} disabled={disabled} required aria-label={label}
      aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
      onInput={() => setInvalid(false)}
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing ||
            (event.key !== "Enter" && event.key !== "Escape")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") reset();
        event.currentTarget.blur();
      }} />
    {showUnit && <span>{unit}</span>}
    <span className="lr-number-steppers" onPointerDown={event => event.preventDefault()}>
      <button type="button" className="lr-btn is-dense is-quiet" disabled={disabled}
        aria-label={t("common.increase", { name: label })} onClick={() => adjust(1)}><Glyph name="arrowUp" size={14} /></button>
      <button type="button" className="lr-btn is-dense is-quiet" disabled={disabled}
        aria-label={t("common.decrease", { name: label })} onClick={() => adjust(-1)}><Glyph name="arrowDown" size={14} /></button>
    </span>
  </span>;
  return <div className={className} onBlur={event => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    const field = input.current!;
    const valid = field.validity.valid && Number.isFinite(field.valueAsNumber);
    setInvalid(!valid);
    if (valid && field.valueAsNumber !== value) onChange(field.valueAsNumber);
  }}>{children(number, select)}
    {invalid && <small id={errorId} className="lr-quality-validation" role="alert">{t("host.quality.invalidNumber", {
      min: String(min), max: String(max), step: String(step), unit,
    })}</small>}
  </div>;
}
