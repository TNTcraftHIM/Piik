import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildFilmControls } from "./scripts/build-film-controls.mjs";

// Keep the repository root available for the shared UI previews, website and film.
// The Rust domain owns signaling and health; Vite serves the frontend.
const server = `http://127.0.0.1:${process.env.PIIK_CHANNEL_PORT ?? 8791}`;

export default defineConfig({
  plugins: [react(), {
    name: "film-controls",
    apply: "serve",
    configureServer(vite) {
      vite.middlewares.use((request, _response, next) => {
        if (request.url?.startsWith("/site/films/external/") && /\.css(?:\?|$)/.test(request.url)) {
          const url = new URL(request.url, "http://localhost");
          if (url.pathname === "/site/films/external/engine/brand-mark.css") {
            url.pathname = "/src/client/components/living/brand-mark.css";
          }
          // The film fetches stylesheet text for its shadow root.
          url.searchParams.set("direct", "");
          request.url = url.pathname + url.search;
        }
        next();
      });
    },
    resolveId(source, importer) {
      if (source === "./playback-controls.js" &&
          importer?.replaceAll("\\", "/").endsWith("/site/films/external/engine/player.js")) {
        return "\0piik-film-controls";
      }
    },
    async load(id) {
      if (id === "\0piik-film-controls") return (await buildFilmControls()).toString("utf8");
    },
  }],
  // Local build output includes Browser profiles, not application entries.
  optimizeDeps: { entries: ["index.html", "site/**/*.html"] },
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
