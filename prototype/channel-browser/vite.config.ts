import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: resolve(import.meta.dirname, "../../build/channel-browser-check/vite-cache"),
  server: { host: "127.0.0.1", port: Number(process.env.PIIK_BROWSER_ROOM_PORT ?? 8792), strictPort: true },
});
