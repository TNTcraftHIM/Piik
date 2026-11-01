import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Keep the repository root available for the shared UI previews, website and film.
// The Rust domain owns signaling and health; Vite serves the frontend.
const server = `http://127.0.0.1:${process.env.PIIK_CHANNEL_PORT ?? 8791}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "build/channel-web",
    emptyOutDir: true,
  },
  server: {
    // host: true keeps the documented LAN-phone workflow reachable.
    host: true,
    port: 8787,
    strictPort: true,
    watch: { ignored: ["**/build/**", "**/target/**"] },
    proxy: {
      "^/prototype/channel(?:/|$)": { target: server, ws: true },
      "/healthz": { target: server },
    },
  },
});
