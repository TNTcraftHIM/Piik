import { loadEnvFile } from "node:process";

import { createScreenerServer } from "./app.js";
import { loadConfig } from "./config.js";

try {
  loadEnvFile();
} catch (error) {
  if (!isMissingFileError(error)) {
    throw error;
  }
}

const config = loadConfig();
const server = await createScreenerServer({
  config,
  frontend:
    config.nodeEnv === "development"
      ? { mode: "development" }
      : config.nodeEnv === "production"
        ? { mode: "static" }
        : { mode: "none" },
});
const port = await server.listen();

console.log(
  `Screener is listening on ${config.listenHost}:${port}; public URL ${config.publicBaseUrl.origin}`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await server.close();
}

function requestStop(): void {
  void shutdown()
    .catch((error: unknown) => {
      console.error("Screener shutdown failed", error);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
