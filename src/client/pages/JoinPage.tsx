import { useState, type FormEvent } from "react";
import { AppHeader } from "../components/living/Header";
import { Tooltip } from "../components/living/Tooltip";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { roomRouteForExplicitEntry } from "../lib/session";

export function JoinPage() {
  const { t, vis } = useCopy();
  const [roomId, setRoomId] = useState("");
  // Counts rejected submits so a repeated one still restarts the shake and
  // re-announces the alert; a plain boolean would already be true.
  const [rejectedAttempt, setRejectedAttempt] = useState(0);
  const error = rejectedAttempt > 0;

  function join(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const route = roomRouteForExplicitEntry(roomId);
    if (!route) {
      setRejectedAttempt((attempt) => attempt + 1);
      return;
    }
    window.location.assign(route);
  }

  const goButton = (
    <button
      className="lr-join-go"
      type="submit"
      aria-label={t("join.submit")}
      disabled={roomId.length !== 4}
    >
      <Glyph name="arrowRight" size={26} />
    </button>
  );

  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-join">
        <form className="lr-join-panel" onSubmit={join} noValidate>
          <span
            key={rejectedAttempt}
            className={`lr-join-door${error ? " is-shake" : ""}`}
            role="img"
            aria-label={t("join.title")}
          >
            <Glyph name="door" size={96} draw="join-door" />
          </span>
          {vis ? null : (
            <div className="lr-access-text">
              <h1>{t("join.title")}</h1>
              <p>{t("join.hint")}</p>
            </div>
          )}
          <div className="lr-dials-wrap">
            <div className="lr-dials" aria-hidden="true">
              {[0, 1, 2, 3].map((index) => (
                <span
                  key={index}
                  className={`lr-dial${roomId[index] ? " is-filled" : index === roomId.length ? " is-active" : ""}`}
                >
                  {roomId[index] ?? ""}
                </span>
              ))}
            </div>
            <input
              value={roomId}
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              autoFocus
              aria-label={t("join.field")}
              aria-invalid={error}
              onChange={(event) => {
                setRoomId(event.target.value.replace(/\D/g, "").slice(0, 4));
                setRejectedAttempt(0);
              }}
            />
          </div>
          {error ? (
            <>
              <span
                key={rejectedAttempt}
                className="lr-join-error"
                role="alert"
                aria-label={t("join.invalid")}
              >
                <Glyph name="x" size={24} />
              </span>
              {vis ? (
                <span className="visually-hidden">{t("join.invalid")}</span>
              ) : (
                <span className="lr-cap" style={{ color: "var(--danger)" }}>
                  {t("join.invalid")}
                </span>
              )}
            </>
          ) : null}
          <Tooltip kind="hint-join-go" text={vis ? undefined : t("join.submit")}>
            {goButton}
          </Tooltip>
          {vis ? null : <span className="lr-cap">{t("join.submit")}</span>}
        </form>
      </main>
    </div>
  );
}
