import { existsSync } from "node:fs";
import { join } from "node:path";

export function tarExecutable() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) return "tar";
  const systemTar = join(systemRoot, "System32", "tar.exe");
  return existsSync(systemTar) ? systemTar : "tar";
}
