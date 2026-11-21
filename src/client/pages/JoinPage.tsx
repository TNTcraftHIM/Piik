import { useState, type FormEvent } from "react";
import { AppHeader } from "../components/living/Header";
import { JoinCodeForm } from "../components/living/JoinRoomForms";
import { HintComic } from "../components/living/hints";
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

  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-join">
        <JoinCodeForm
          value={roomId}
          rejectedAttempt={rejectedAttempt}
          onChange={(value) => { setRoomId(value); setRejectedAttempt(0); }}
          onSubmit={join}
        >
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
        </JoinCodeForm>
      </main>
    </div>
  );
}
