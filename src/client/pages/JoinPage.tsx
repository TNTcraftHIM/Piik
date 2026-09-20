import { useState, type FormEvent } from "react";
import { AppHeader } from "../components/living/Header";
import { Tooltip } from "../components/living/Tooltip";
import { RoomCodeInput, RoomCodeError } from "../components/living/RoomCodeInput";
import { HintComic } from "../components/living/hints";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { roomRouteForExplicitEntry } from "../lib/session";

export function JoinPage() {
  const { t, vis } = useCopy();
  const [roomId, setRoomId] = useState("");
  // Counts rejected submits so a repeated one still restarts the shake and
  // re-announces the alert; a plain boolean would already be true.
  const [rejectedAttempt, setRejectedAttempt] = useState(0);

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
            className="lr-join-door"
            role="img"
            aria-label={t("join.title")}
          >
            <HintComic kind="hint-join-go" size={280} />
          </span>
          {vis ? null : (
            <div className="lr-access-text">
              <h1>{t("join.title")}</h1>
              <p className="lr-join-site">{t("join.hint", { site: window.location.host })}</p>
            </div>
          )}
          <RoomCodeInput value={roomId} rejectedAttempt={rejectedAttempt} autoFocus
            onChange={value => { setRoomId(value); setRejectedAttempt(0); }} />
          <RoomCodeError attempt={rejectedAttempt} />
          <Tooltip kind="hint-join-go" text={vis ? undefined : t("join.submit")}>
            {goButton}
          </Tooltip>
          {vis ? null : <span className="lr-cap">{t("join.submit")}</span>}
        </form>
      </main>
    </div>
  );
}
