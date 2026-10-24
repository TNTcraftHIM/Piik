import { installUserMediaPort } from "./media/user-media";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

installUserMediaPort();

async function main() {
  // Room controls share the Popover API; install it before any component mounts.
  if (!("popover" in HTMLElement.prototype)) {
    await import("./ui/popover-polyfill");
  }

  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Application root was not found");
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
