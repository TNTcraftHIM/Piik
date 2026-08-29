import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  authenticateSiteAccess,
  getSiteAccess,
  type SiteAccessStatus,
} from "./lib/api";
import { parseAppRoute, readViewerRoute } from "./lib/session";
import { HostPage } from "./pages/HostPage";
import { JoinPage } from "./pages/JoinPage";
import { ViewerPage } from "./pages/ViewerPage";
import { AppHeader } from "./components/living/Header";
import { BrandLoader } from "./components/living/BrandMark";
import { Btn, Pill } from "./components/living/primitives";
import { ComicTooltip } from "./components/living/ComicTooltip";
import { Glyph, type GlyphName } from "./ui/icons";
import { useCopy } from "./ui/copy";

const appRoute = parseAppRoute(window.location.pathname);
const viewerRoute = appRoute.kind === "viewer" ? readViewerRoute() : null;
const SITE_ACCESS_RENEWAL_INTERVAL_MS = 60 * 60 * 1_000;

type AccessState =
  | { kind: "checking" }
  | { kind: "ready"; renewalRequired: boolean }
  | { kind: "required"; error: string | null }
  | { kind: "unavailable"; message: string };

function stateFromStatus(status: SiteAccessStatus): AccessState {
  return !status.required || status.authenticated
    ? { kind: "ready", renewalRequired: status.required }
    : { kind: "required", error: null };
}

function readableError(error: unknown, t: (key: "gate.connectFailed") => string): string {
  return error instanceof ApiError ? error.message : t("gate.connectFailed");
}

export function App() {
  if (appRoute.kind === "viewer" && viewerRoute) {
    return viewerRoute.viewerGrant ? (
      <ViewerPage {...viewerRoute} />
    ) : (
      <SiteAccessGate surface="viewer" />
    );
  }
  if (appRoute.kind === "host") {
    return <SiteAccessGate surface="host" />;
  }
  if (appRoute.kind === "join") {
    return <SiteAccessGate surface="join" />;
  }
  return appRoute.kind === "malformed-room" ? (
    <StaticRoute icon="door" titleKey="gate.malformed" hintKey="gate.malformedHint" />
  ) : (
    <StaticRoute icon="alert" titleKey="gate.unavailableRoute" />
  );
}

function StaticRoute({
  icon,
  titleKey,
  hintKey,
}: {
  icon: GlyphName;
  titleKey: "gate.malformed" | "gate.unavailableRoute";
  hintKey?: "gate.malformedHint";
}) {
  const { t, vis } = useCopy();
  const panelIcon = (
    <span className="lr-tv-big" style={{ borderColor: "var(--ink)", color: "var(--ink)", background: "var(--paper)" }}>
      <Glyph name={icon} size={30} />
    </span>
  );
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-join">
        <div className="lr-join-panel">
          {vis ? (
            <ComicTooltip kind="warning">{panelIcon}</ComicTooltip>
          ) : (
            panelIcon
          )}
          {vis ? null : (
            <div className="lr-access-text">
              <h1>{t(titleKey)}</h1>
              {hintKey ? <p>{t(hintKey)}</p> : null}
            </div>
          )}
          <span className="visually-hidden" role="alert">
            {t(titleKey)}
          </span>
        </div>
      </main>
    </div>
  );
}

function SiteAccessGate({
  surface,
}: {
  surface: "host" | "join" | "viewer";
}) {
  const { t, vis } = useCopy();
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void getSiteAccess().then(
      (status) => active && setAccess(stateFromStatus(status)),
      (error: unknown) =>
        active &&
        setAccess({ kind: "unavailable", message: readableError(error, t) }),
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (access.kind !== "ready" || !access.renewalRequired) {
      return;
    }
    let active = true;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void getSiteAccess()
        .then((status) => {
          if (active && (!status.required || !status.authenticated)) {
            setAccess(stateFromStatus(status));
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) {
            checking = false;
          }
        });
    }, SITE_ACCESS_RENEWAL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [access]);

  async function retry(): Promise<void> {
    setAccess({ kind: "checking" });
    try {
      setAccess(stateFromStatus(await getSiteAccess()));
    } catch (error) {
      setAccess({ kind: "unavailable", message: readableError(error, t) });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    if (!submittedPassword.trim()) {
      setAccess({ kind: "required", error: t("gate.hint") });
      return;
    }

    setSubmitting(true);
    try {
      setAccess(
        stateFromStatus(await authenticateSiteAccess(submittedPassword)),
      );
    } catch (error) {
      setAccess({
        kind: "required",
        error:
          error instanceof ApiError && error.status === 401
            ? t("gate.wrong")
            : readableError(error, t),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (access.kind === "ready") {
    if (surface === "viewer" && viewerRoute) {
      return <ViewerPage {...viewerRoute} />;
    }
    if (surface === "join") {
      return <JoinPage />;
    }
    return (
      <HostPage
        onAuthorizationRequired={() =>
          setAccess({ kind: "required", error: t("gate.expired") })
        }
      />
    );
  }

  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-join">
        {access.kind === "checking" ? (
          <div
            className="lr-loading"
            role="status"
            aria-label={t("gate.checking")}
          >
            <BrandLoader />
            {vis ? null : (
              <span className="lr-tv-msg" style={{ color: "var(--ink)", textShadow: "none" }}>
                {t("gate.checking")}
              </span>
            )}
          </div>
        ) : access.kind === "unavailable" ? (
          <div className="lr-join-panel">
            <span className="lr-tv-big" style={{ borderColor: "var(--ink)", color: "var(--ink)", background: "var(--paper)" }}>
              <Glyph name="wifiOff" size={30} />
            </span>
            {vis ? (
              <span className="visually-hidden" role="alert">{access.message}</span>
            ) : (
              <div className="lr-access-text">
                <h1>{t("gate.unavailable")}</h1>
                <p role="alert">{access.message}</p>
              </div>
            )}
            <Btn icon="refresh" title="common.retry" cap="common.retry" onClick={() => void retry()} />
          </div>
        ) : (
          <form className="lr-join-panel" onSubmit={(event) => void submit(event)}>
            <span className="lr-tv-big" style={{ borderColor: "var(--ink)", color: "var(--ink)", background: "var(--paper)" }}>
              <Glyph name="key" size={30} draw="gate-key" />
            </span>
            {vis ? null : (
              <div className="lr-access-text">
                <h1>{t("gate.title")}</h1>
                <p>{t("gate.hint")}</p>
              </div>
            )}
            <span className="lr-input" style={{ minWidth: 240 }}>
              <Glyph name="lock" size={17} />
              <input
                type="password"
                value={password}
                disabled={submitting}
                autoComplete="current-password"
                autoFocus
                aria-label={t("gate.password")}
                placeholder={vis ? "····" : t("gate.password")}
                onChange={(event) => setPassword(event.target.value)}
              />
            </span>
            {access.error ? (
              <Pill icon="alert" tone="bad" label={access.error} alert comic="warning" />
            ) : null}
            <Btn
              icon="arrowRight"
              title="gate.submit"
              cap="gate.submit"
              tone="primary"
              type="submit"
              hint="hint-password"
              disabled={submitting}
            />
          </form>
        )}
      </main>
    </div>
  );
}
