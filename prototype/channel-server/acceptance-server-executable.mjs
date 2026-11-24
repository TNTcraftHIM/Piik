import { copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export async function acceptanceServerExecutable(directory, fromBuild = false) {
  const configured = process.env.CHANNEL_EXECUTABLE;
  const windows = process.platform === "win32";
  const executable = resolve(configured ?? `prototype/channel-server/target/debug/piik-channel-prototype${windows ? ".exe" : ""}`);
  // Running the Cargo output directly would prevent relinking it on Windows.
  if (!windows || (configured !== undefined && !fromBuild)) return executable;
  const snapshot = join(directory, basename(executable));
  await copyFile(executable, snapshot);
  return snapshot;
}
