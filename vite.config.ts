import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Go server owns /api, /healthz and /signal; everything else (including
// /r/<roomId> invitation paths) is the SPA that Vite already serves. Keeping the
// Browser origin on 8787 leaves PUBLIC_BASE_URL, ALLOWED_ORIGINS, the README and
// the LAN-phone instructions unchanged; the Go dev server moves to 8788.
const server = "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "internal/server/webassets/dist",
    emptyOutDir: false,
  },
  server: {
    // host: true keeps the documented LAN-phone workflow reachable.
    host: true,
    port: 8787,
    strictPort: true,
    // Packaging and the embedded Go bundle are outputs, not live UI sources.
    watch: { ignored: ["**/build/**", "**/internal/server/webassets/dist/**"] },
    proxy: {
      "/api": { target: server },
      "/healthz": { target: server },
      "/signal": { target: server, ws: true },
    },
  },
});
