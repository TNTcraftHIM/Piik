import react from "@vitejs/plugin-react";
import { transformSync } from "esbuild";
import { defineConfig, type Plugin } from "vite";

// The Go server owns /api, /healthz and /signal; everything else (including
// /r/<roomId> invitation paths) is the SPA that Vite already serves. Keeping the
// Browser origin on 8787 leaves PUBLIC_BASE_URL, ALLOWED_ORIGINS, the README and
// the LAN-phone instructions unchanged; the Go dev server moves to 8788.
const server = "http://127.0.0.1:8788";

function preloadBootStyles(): Plugin {
  let base: string;
  return {
    name: "piik-boot-styles",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, { path, bundle }) {
        if (path !== "/index.html") return;
        const styles = Object.values(bundle ?? {}).find(output =>
          output.type === "asset" && output.originalFileNames.includes("src/client/styles.css"),
        );
        if (!styles) throw new Error("Piik startup stylesheet was not emitted");
        // Match Vite's dynamic stylesheet request so the browser can reuse the preload.
        const compactHtml = html
          .replace(/<script>([\s\S]*?)<\/script>/g, (_tag, source: string) =>
            `<script>${transformSync(source, { minify: true, charset: "utf8" }).code.trim()}</script>`,
          )
          .replace(/>\s+</g, "><");
        return { html: compactHtml, tags: [{
          tag: "link",
          attrs: { rel: "preload", as: "style", crossorigin: "", href: base + styles.fileName },
          injectTo: "head-prepend",
        }] };
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    preloadBootStyles(),
  ],
  // Local build output includes Browser profiles, not application entries.
  optimizeDeps: { entries: ["index.html", "site/**/*.html"] },
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
