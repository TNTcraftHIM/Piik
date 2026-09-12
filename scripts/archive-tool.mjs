import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function tarExecutable() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) return "tar";
  const systemTar = join(systemRoot, "System32", "tar.exe");
  return existsSync(systemTar) ? systemTar : "tar";
}

export function createZip(source, archive) {
  archive = resolve(archive);
  if (process.platform === "linux") {
    execFileSync("zip", ["-qry", archive, "."], { cwd: source, stdio: "pipe" });
  } else {
    execFileSync(tarExecutable(), ["--format=zip", "-cf", archive, "."], {
      cwd: source, stdio: "pipe", windowsHide: true,
    });
  }
}

export function extractZip(archive, destination) {
  if (process.platform === "linux") {
    execFileSync("unzip", ["-q", resolve(archive), "-d", destination], { stdio: "pipe" });
  } else {
    execFileSync(tarExecutable(), ["-xpf", resolve(archive), "-C", destination], {
      stdio: "pipe", windowsHide: true,
    });
  }
}
