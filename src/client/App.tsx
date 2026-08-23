import { KeyRound, LoaderCircle } from "lucide-react";
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

const appRoute = parseAppRoute(window.location.pathname);
const viewerRoute = appRoute.kind === "viewer" ? readViewerRoute() : null;

type AccessState =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "required"; error: string | null }
  | { kind: "unavailable"; message: string };

function stateFromStatus(status: SiteAccessStatus): AccessState {
  return !status.required || status.authenticated
    ? { kind: "ready" }
    : { kind: "required", error: null };
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "无法连接站点访问服务，请重试";
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
    <MalformedRoomRoute />
  ) : (
    <UnavailableRoute />
  );
}

function SiteAccessGate({
  surface,
}: {
  surface: "host" | "join" | "viewer";
}) {
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void getSiteAccess().then(
      (status) => active && setAccess(stateFromStatus(status)),
      (error: unknown) =>
        active &&
        setAccess({ kind: "unavailable", message: readableError(error) }),
    );
    return () => {
      active = false;
    };
  }, []);

  async function retry(): Promise<void> {
    setAccess({ kind: "checking" });
    try {
      setAccess(stateFromStatus(await getSiteAccess()));
    } catch (error) {
      setAccess({ kind: "unavailable", message: readableError(error) });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    if (!submittedPassword.trim()) {
      setAccess({ kind: "required", error: "请输入站点口令" });
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
            ? "站点口令不正确，请重试"
            : readableError(error),
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
          setAccess({ kind: "required", error: "站点访问已失效，请重新验证" })
        }
      />
    );
  }

  return (
    <div className="app-shell">
      <main className="access-workspace access-workspace-full">
        {access.kind === "checking" ? (
          <div className="access-loading" role="status">
            <LoaderCircle size={20} className="spin" aria-hidden="true" />
            正在验证站点访问
          </div>
        ) : access.kind === "unavailable" ? (
          <section className="access-panel" aria-labelledby="access-heading">
            <h1 id="access-heading">暂时无法验证站点访问</h1>
            <p className="access-error" role="alert">
              {access.message}
            </p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void retry()}
            >
              重试
            </button>
          </section>
        ) : (
          <form className="access-panel" onSubmit={(event) => void submit(event)}>
            <div>
              <h1>站点访问</h1>
              <p className="section-meta">请输入站点口令</p>
            </div>
            <label className="token-field">
              <span>站点口令</span>
              <span className="input-with-icon">
                <KeyRound size={16} aria-hidden="true" />
                <input
                  type="password"
                  value={password}
                  disabled={submitting}
                  autoComplete="current-password"
                  autoFocus
                  onChange={(event) => setPassword(event.target.value)}
                />
              </span>
            </label>
            {access.error && (
              <p className="access-error" role="alert">
                {access.error}
              </p>
            )}
            <button
              className="button button-primary"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "正在验证" : "进入站点"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

function UnavailableRoute() {
  return (
    <div className="app-shell">
      <main className="access-workspace access-workspace-full">
        <section className="access-panel">
          <h1>无法访问</h1>
        </section>
      </main>
    </div>
  );
}

function MalformedRoomRoute() {
  return (
    <div className="app-shell">
      <main className="access-workspace access-workspace-full">
        <section className="access-panel">
          <h1>房间号格式不正确</h1>
          <p className="section-meta">房间号必须是 1000..9999 的四位数字</p>
        </section>
      </main>
    </div>
  );
}
