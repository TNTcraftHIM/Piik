import { Component, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { StartupFailure } from "./components/living/StartupFailure";
import { LoadingStatus } from "./components/living/WaitingStatus";
import "./styles.css";

class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <StartupFailure /> : this.props.children; }
}

export async function mountApp(app: ReactNode): Promise<void> {
  // Room controls share the Popover API; install it before any component mounts.
  if (!("popover" in HTMLElement.prototype)) {
    try {
      await import("./ui/popover-polyfill");
    } catch (error) {
      console.error("Could not initialize page controls", error);
      app = <StartupFailure />;
    }
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("Application root was not found");
  createRoot(root).render(<StrictMode><StartupBoundary>
    <Suspense fallback={<div className="lr-app"><main className="lr-join"><LoadingStatus label="common.loading" /></main></div>}>
      {app}
    </Suspense>
  </StartupBoundary></StrictMode>);
}
