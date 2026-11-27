import { productVersionDefine } from "./scripts/release-version.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: productVersionDefine(process.env.PIIK_BUILD_VERSION),
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
