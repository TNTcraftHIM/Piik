import { useCopy } from "../../ui/copy";

export function RoomCodeInput({ value, onChange, rejectedAttempt = 0, autoFocus = false }: {
  value: string;
  onChange: (value: string) => void;
  rejectedAttempt?: number;
  autoFocus?: boolean;
}) {
  const { t } = useCopy();
  return <div key={rejectedAttempt} className={`lr-dials-wrap${rejectedAttempt ? " is-shake" : ""}`}>
    <div className="lr-dials" aria-hidden="true">
      {[0, 1, 2, 3].map(index => <span key={index}
        className={`lr-dial${value[index] ? " is-filled" : index === value.length ? " is-active" : ""}`}>
        {value[index] ?? ""}
      </span>)}
    </div>
    <input value={value} inputMode="numeric" autoComplete="off" maxLength={4}
      autoFocus={autoFocus} aria-label={t("join.field")} aria-invalid={rejectedAttempt > 0}
      onChange={event => onChange(event.target.value.replace(/\D/g, "").slice(0, 4))} />
  </div>;
}
