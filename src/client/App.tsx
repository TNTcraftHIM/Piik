import {
  Suspense,
  lazy,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import {
  ApiError,
  authenticateSiteAccess,
  getRuntimeCapabilities,
  getSiteAccess,
  type SiteAccessStatus,
} from "./lib/api";
import type { RuntimeCapabilities } from "../shared/protocol";
import {
  parseAppRoute,
  readViewerRoute,
  takeClientLaunchBootstrap,
} from "./lib/session";
import { AppHeader } from "./components/living/Header";
import { BrandLoader } from "./components/living/BrandMark";
import { Btn, Pill } from "./components/living/primitives";
import { ComicTooltip } from "./components/living/ComicTooltip";
import { Glyph, type GlyphName } from "./ui/icons";
import { useCopy } from "./ui/copy";

const appRoute = parseAppRoute(window.location.pathname);
const clientLaunchBootstrap =
  appRoute.kind === "host" || appRoute.kind === "viewer"
    ? takeClientLaunchBootstrap()
    : null;
const clientAccessBootstrap = clientLaunchBootstrap?.accessToken ?? null;
const viewerRoute = appRoute.kind === "viewer" ? readViewerRoute() : null;
const hostPageModule =
  appRoute.kind === "host" ? import("./pages/HostPage") : null;
const joinPageModule =
  appRoute.kind === "join" ? import("./pages/JoinPage") : null;
const viewerPageModule =
  appRoute.kind === "viewer" ? import("./pages/ViewerPage") : null;
const clientLauncherPageModule =
  appRoute.kind === "client" ? import("./pages/ClientLauncherPage") : null;
const HostPage = lazy(async () => ({
  default: (await (hostPageModule ?? import("./pages/HostPage"))).HostPage,
}));
const JoinPage = lazy(async () => ({
  default: (await (joinPageModule ?? import("./pages/JoinPage"))).JoinPage,
}));
const ViewerPage = lazy(async () => ({
  default: (await (viewerPageModule ?? import("./pages/ViewerPage")))
    .ViewerPage,
}));
const ClientLauncherPage = lazy(async () => ({
  default: (await (
    clientLauncherPageModule ?? import("./pages/ClientLauncherPage")
  )).ClientLauncherPage,
}));
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
  const { lang, vis } = useCopy();
  useEffect(() => {
    if (appRoute.kind !== "client" && !clientLaunchBootstrap?.launchedByClient) return;
    const controller = new AbortController();
    void import("./native/client")
      .then(({ notifyNativePresentation }) =>
        notifyNativePresentation(vis ? "vis" : lang, controller.signal))
      .catch(() => undefined);
    return () => controller.abort();
  }, [lang, vis]);

  return (
    <Suspense fallback={<RouteLoader />}>
      <AppRoute />
    </Suspense>
  );
}

function AppRoute() {
  if (appRoute.kind === "client") {
    return <ClientLauncherPage />;
  }
  if (appRoute.kind === "viewer" && viewerRoute) {
    return viewerRoute.viewerGrant ? (
      <ViewerPage
        {...viewerRoute}
        launchedByClient={clientLaunchBootstrap?.launchedByClient}
      />
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

function RouteLoader() {
  const { t, vis } = useCopy();
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-join">
        <div
          className="lr-loading"
          role="status"
          aria-label={t("gate.checking")}
        >
          <BrandLoader />
          {vis ? null : (
            <span
              className="lr-tv-msg"
              style={{ color: "var(--ink)", textShadow: "none" }}
            >
              {t("gate.checking")}
            </span>
          )}
        </div>
      </main>
    </div>
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
  const [capabilities, setCapabilities] =
    useState<RuntimeCapabilities | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      clientAccessBootstrap
        ? authenticateSiteAccess(clientAccessBootstrap)
        : getSiteAccess(),
      surface === "host"
        ? getRuntimeCapabilities()
        : Promise.resolve<RuntimeCapabilities>({ natPrediction: false }),
    ]).then(
      ([status, nextCapabilities]) => {
        if (!active) return;
        setCapabilities(nextCapabilities);
        setAccess(stateFromStatus(status));
      },
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
      const [status, nextCapabilities] = await Promise.all([
        getSiteAccess(),
        surface === "host"
          ? getRuntimeCapabilities()
          : Promise.resolve<RuntimeCapabilities>({ natPrediction: false }),
      ]);
      setCapabilities(nextCapabilities);
      setAccess(stateFromStatus(status));
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
      return (
        <ViewerPage
          {...viewerRoute}
          launchedByClient={clientLaunchBootstrap?.launchedByClient}
        />
      );
    }
    if (surface === "join") {
      return <JoinPage />;
    }
    return (
      <HostPage
        launchedByClient={clientLaunchBootstrap?.launchedByClient}
        natPredictionAvailable={capabilities?.natPrediction === true}
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
