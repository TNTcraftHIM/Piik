import { Component, StrictMode, Suspense, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { StartupFailure } from "./components/living/StartupFailure";
import { LoadingStatus } from "./components/living/WaitingStatus";
import "./styles.css";

class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <StartupFailure /> : this.props.children; }
}

export async function mountApp(loadPage: () => Promise<ComponentType>): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("Application root was not found");
  const root = createRoot(container);
  const loading = <div className="lr-app"><main className="lr-join"><LoadingStatus label="common.loading" /></main></div>;
  const render = (content: ReactNode) => root.render(<StrictMode><StartupBoundary>
    <Suspense fallback={loading}>{content}</Suspense>
  </StartupBoundary></StrictMode>);

  render(loading);
  try {
    if (!("popover" in HTMLElement.prototype)) await import("./ui/popover-polyfill");
    const Page = await loadPage();
    render(<Page />);
  } catch (error) {
    console.error("Could not initialize page", error);
    render(<StartupFailure />);
  }
}
