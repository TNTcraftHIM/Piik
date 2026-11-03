import { useCopy } from "../../ui/copy";
import { Comic } from "./Comic";
import { Btn } from "./primitives";

export function StartupFailure() {
  const { t, vis } = useCopy();
  return <div className="lr-app">
    <main className="lr-join">
      <div className="lr-join-panel">
        <Comic kind="warning" theme="paper" tone="bad" />
        <div className={vis ? "visually-hidden" : "lr-access-text"} role="alert">
          <h1>{t("startup.failed")}</h1>
          <p>{t("startup.retry")}</p>
        </div>
        <Btn icon="refresh" title="common.refresh" cap="common.refresh"
          onClick={() => window.location.reload()} />
      </div>
    </main>
  </div>;
}
