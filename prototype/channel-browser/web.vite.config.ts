import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  publicDir: resolve(import.meta.dirname, "../../public"),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../../build/channel-web"),
    emptyOutDir: true,
  },
});
