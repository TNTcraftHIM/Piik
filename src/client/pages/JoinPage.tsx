import { useState, type FormEvent } from "react";
import { AppHeader } from "../components/living/Header";
import { ComicTooltip } from "../components/living/ComicTooltip";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { roomRouteForExplicitEntry } from "../lib/session";

export function JoinPage() {
  const { t, vis } = useCopy();
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState(false);

  function join(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const route = roomRouteForExplicitEntry(roomId);
    if (!route) {
      setError(true);
      return;
    }
    window.location.assign(route);
  }

  const goButton = (
    <button
      className="lr-join-go"
      type="submit"
      title={vis ? undefined : t("join.submit")}
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
            className={`lr-join-door${error ? " is-shake" : ""}`}
            title={vis ? undefined : t("join.title")}
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
                setError(false);
              }}
            />
          </div>
          {error ? (
            <>
              <span className="lr-join-error" role="alert" aria-label={t("join.invalid")}>
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
          {vis ? (
            <ComicTooltip kind="hint-join-go">{goButton}</ComicTooltip>
          ) : (
            goButton
          )}
          {vis ? null : <span className="lr-cap">{t("join.submit")}</span>}
        </form>
      </main>
    </div>
  );
}
