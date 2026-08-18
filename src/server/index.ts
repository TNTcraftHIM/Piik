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
const server = await createScreenerServer({ config });
const port = await server.listen();

console.log(`Screener is listening on ${config.publicBaseUrl.origin} (port ${port})`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await server.close();
}

process.once("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
