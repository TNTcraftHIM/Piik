import { defineConfig } from "vite";
export default defineConfig({
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port: Number(process.env.PIIK_BROWSER_ROOM_PORT ?? 8792), strictPort: true },
});
