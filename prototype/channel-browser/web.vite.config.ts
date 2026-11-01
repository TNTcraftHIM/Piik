import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.config.ts";

export default mergeConfig(base, defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  publicDir: resolve(import.meta.dirname, "../../public"),
  build: {
    outDir: resolve(import.meta.dirname, "../../build/channel-web"),
    emptyOutDir: true,
  },
}));
