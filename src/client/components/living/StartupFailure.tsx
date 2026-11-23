import { useCopy } from "../../ui/copy";
import { Comic } from "./Comic";
import { Btn, Cap } from "./primitives";

export function StartupFailure() {
  return <FailurePanel missing={false} />;
}

export function PageNotFound() {
  return <FailurePanel missing />;
}

function FailurePanel({ missing }: { missing: boolean }) {
  const { t } = useCopy();
  return <div className="lr-app">
    <main className="lr-join">
      <div className="lr-join-panel">
        <Comic kind="warning" theme="paper" tone="bad" />
        <div className="lr-access-text" role="alert">
          <h1>{t(missing ? "navigation.linkUnavailable" : "startup.failed")}</h1>
          <p>{t(missing ? "navigation.askInvitation" : "startup.retry")}</p>
        </div>
        {missing ? <a className="lr-btn" href="/"><Cap k="client.connect.openSite" /></a>
          : <Btn icon="refresh" title="common.refresh" cap="common.refresh"
          onClick={() => window.location.reload()} />}
      </div>
    </main>
  </div>;
}
