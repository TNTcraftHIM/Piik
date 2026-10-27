import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.ts";

export default mergeConfig(base, defineConfig({
  server: {
    host: "127.0.0.1", port: 8790,
    proxy: { "/prototype/channel": { target: "http://127.0.0.1:8791", ws: true } },
  },
}));
