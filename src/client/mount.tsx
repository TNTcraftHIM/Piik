import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

export async function mountApp(app: ReactNode): Promise<void> {
  // Room controls share the Popover API; install it before any component mounts.
  if (!("popover" in HTMLElement.prototype)) {
    await import("./ui/popover-polyfill");
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("Application root was not found");
  createRoot(root).render(<StrictMode>{app}</StrictMode>);
}
