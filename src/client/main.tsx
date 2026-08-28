import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./ui/theme";
import "./styles.css";

initTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Application root was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
