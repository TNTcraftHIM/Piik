import type { FormEventHandler, ReactNode } from "react";
import { MAX_VIEWER_PASSWORD_LENGTH } from "../../../shared/protocol";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { RoomCodeInput, RoomCodeError } from "./RoomCodeInput";
import { Tooltip } from "./Tooltip";
import { Btn, Pill } from "./primitives";

interface JoinRoomFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export function JoinCodeForm({
  value,
  onChange,
  onSubmit,
  rejectedAttempt = 0,
  children,
}: JoinRoomFormProps & { rejectedAttempt?: number; children?: ReactNode }) {
  const { t, vis } = useCopy();
  return (
    <form className="lr-join-panel" onSubmit={onSubmit} noValidate>
      {children}
      <RoomCodeInput value={value} onChange={onChange} rejectedAttempt={rejectedAttempt} autoFocus />
      <RoomCodeError attempt={rejectedAttempt} />
      <Tooltip kind="hint-join-go" text={vis ? undefined : t("join.submit")}>
        <button
          className="lr-join-go"
          type="submit"
          aria-label={t("join.submit")}
          disabled={value.length !== 4}
        >
          <Glyph name="arrowRight" size={26} />
        </button>
      </Tooltip>
      {vis ? null : <span className="lr-cap">{t("join.submit")}</span>}
    </form>
  );
}

export function JoinPasswordForm({
  value,
  onChange,
  onSubmit,
  error,
}: JoinRoomFormProps & { error?: CopyKey | null }) {
  const { t } = useCopy();
  return (
    <form style={{ display: "grid", justifyItems: "center", gap: 14 }} onSubmit={onSubmit}>
      <span className="lr-input is-password">
        <Glyph name="key" size={17} />
        <input
          type="password"
          value={value}
          maxLength={MAX_VIEWER_PASSWORD_LENGTH}
          autoComplete="current-password"
          autoFocus
          aria-label={t("join.password")}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
      {error && (
        <Pill icon="alert" tone="bad" label={t(error, { max: String(MAX_VIEWER_PASSWORD_LENGTH) })} alert comic="access-denied" />
      )}
      <Btn icon="arrowRight" tone="primary" cap="join.submit" title="join.submit" type="submit" hint="hint-password" />
    </form>
  );
}
