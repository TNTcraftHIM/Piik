import { KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  authenticate,
  getSession,
  type SessionStatus,
} from "./lib/api";
import { readViewerRoute } from "./lib/session";
import { HostPage } from "./pages/HostPage";
import { JoinPage } from "./pages/JoinPage";
import { ViewerPage } from "./pages/ViewerPage";

const viewerRoute = readViewerRoute();
const isJoinRoute = /^\/join\/?$/.test(window.location.pathname);
const isHostRoute = /^\/?$/.test(window.location.pathname);

type AccessState =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "required"; error: string | null }
  | { kind: "unavailable"; message: string };

function stateFromStatus(status: SessionStatus): AccessState {
  return !status.required || status.authenticated
    ? { kind: "ready" }
    : { kind: "required", error: null };
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "无法连接验证服务，请重试";
}

export function App() {
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void getSession().then(
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
      setAccess(stateFromStatus(await getSession()));
    } catch (error) {
      setAccess({ kind: "unavailable", message: readableError(error) });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    if (!submittedPassword.trim()) {
      setAccess({ kind: "required", error: "请输入访问密码" });
      return;
    }

    setSubmitting(true);
    try {
      setAccess(stateFromStatus(await authenticate(submittedPassword)));
    } catch (error) {
      setAccess({
        kind: "required",
        error:
          error instanceof ApiError && error.status === 401
            ? "访问密码不正确，请重试"
            : readableError(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (access.kind === "ready") {
    if (viewerRoute) {
      return (
        <ViewerPage
          {...viewerRoute}
          onAuthorizationRequired={() =>
            setAccess({ kind: "required", error: "验证已失效，请重新登录" })
          }
        />
      );
    }
    if (isJoinRoute || !isHostRoute) {
      return <JoinPage />;
    }
    return (
      <HostPage
        onAuthorizationRequired={() =>
          setAccess({ kind: "required", error: "验证已失效，请重新登录" })
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
            正在验证
          </div>
        ) : access.kind === "unavailable" ? (
          <section className="access-panel" aria-labelledby="access-heading">
            <h1 id="access-heading">暂时无法验证</h1>
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
              <h1>访问验证</h1>
              <p className="section-meta">请输入此站点的访问密码</p>
            </div>
            <label className="token-field">
              <span>访问密码</span>
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
              {submitting ? "正在验证" : "进入"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
