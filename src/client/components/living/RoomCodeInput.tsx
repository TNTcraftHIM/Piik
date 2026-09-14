import { useCopy } from "../../ui/copy";
import { Comic } from "./Comic";

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

export function RoomCodeError({ attempt, theme = "paper" }: { attempt: number; theme?: "paper" | "stage" }) {
  const { t, vis } = useCopy();
  if (!attempt) return null;
  // The message is inside the live region; another rejection re-announces it.
  return <span key={attempt} role="alert" style={{ display: "grid", justifyItems: "center", gap: 8 }}>
    <Comic kind="room-code-invalid" theme={theme} size={240} />
    <span className={vis ? "visually-hidden" : "lr-cap"} style={{ color: "var(--danger)" }}>{t("join.invalid")}</span>
  </span>;
}
