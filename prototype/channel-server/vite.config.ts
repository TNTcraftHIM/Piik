import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.ts";

export default mergeConfig(base, defineConfig({
  server: {
    host: "127.0.0.1", port: Number(process.env.PIIK_CHANNEL_UI_PORT ?? 8790), strictPort: true,
    proxy: { "/prototype/channel": { target: `http://127.0.0.1:${process.env.PIIK_CHANNEL_PORT ?? 8791}`, ws: true } },
  },
}));
