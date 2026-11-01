import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { StartupFailure } from "./components/living/StartupFailure";
import "./styles.css";

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
  createRoot(root).render(<StrictMode>{app}</StrictMode>);
}
