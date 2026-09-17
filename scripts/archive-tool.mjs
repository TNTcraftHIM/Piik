import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
    // Archiving "." adds ./ members that Windows Explorer treats as an empty ZIP.
    execFileSync(tarExecutable(), ["--format=zip", "-cf", archive, "--", ...readdirSync(source).sort()], {
      cwd: source, stdio: "pipe", windowsHide: true,
    });
  }
  if (process.platform === "win32") {
    // The writer can read its own incompatible ZIPs. Check Explorer separately,
    // including nested helpers and hidden files, before publishing the archive.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
function Check-Folder($folder, [string]$source) {
  if ($null -eq $folder) { throw 'Windows Explorer cannot open the ZIP folder' }
  foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
    $item = $folder.ParseName($entry.Name)
    if ($null -eq $item) { throw "Windows Explorer cannot read ZIP entry: $($entry.Name)" }
    if ($entry.PSIsContainer) { Check-Folder $item.GetFolder $entry.FullName }
  }
}
Check-Folder $shell.NameSpace($env:PIIK_ZIP_ARCHIVE) $env:PIIK_ZIP_SOURCE
`], { stdio: "pipe", windowsHide: true, timeout: 30_000,
      env: { ...process.env, PIIK_ZIP_ARCHIVE: archive, PIIK_ZIP_SOURCE: resolve(source) },
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
