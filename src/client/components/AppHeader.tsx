import { MonitorUp } from "lucide-react";
import type { ReactNode } from "react";

export function AppHeader({ status }: { status: ReactNode }) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Screener 首页">
        <span className="brand-mark" aria-hidden="true">
          <MonitorUp size={19} />
        </span>
        <span>Screener</span>
      </a>
      {status && <div className="header-status">{status}</div>}
    </header>
  );
}
