import { createScreenerServer } from "./app.js";
import { loadLocalServerConfig } from "./local-config.js";

const config = loadLocalServerConfig();
const server = await createScreenerServer({
  config,
  frontend: { mode: "static" },
});

let shutdown: Promise<void> | undefined;
function stop(): Promise<void> {
  shutdown ??= server.end();
  return shutdown;
}

function requestStop(): void {
  process.stdin.pause();
  void stop().catch(() => {
    process.exitCode = 1;
  });
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
process.stdin.resume();
process.stdin.once("end", requestStop);

try {
  await server.listen();
  console.log(`Screener Client is available at http://localhost:${config.port}`);
} catch {
  await stop().catch(() => undefined);
  throw new Error("Screener Client local server could not start");
}
