import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractZip } from "./archive-tool.mjs";

// Native x64 client embedded in official Nefarius.ViGEm.Client 1.21.256.
export const GAMEPAD_CLIENT_SHA256 = "00303f99e1968d523fbd08a7c691d60d145b7335059ec593947841d124c10875";
const PACKAGE_SHA256 = "ff460031b33e0882cd1166fe2d072d0fe97578480c61ed85dccfa6c930fdb55e";

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Build-time only: the official managed package embeds the native x64 client
// as a manifest resource. No NuGet/.NET dependency or download ships in App.
export async function downloadGamepadClient(workspace, download) {
  const directory = join(workspace, "gamepad-client");
  mkdirSync(directory);
  const archive = join(directory, "client.nupkg");
  await download(
    "https://api.nuget.org/v3-flatcontainer/nefarius.vigem.client/1.21.256/nefarius.vigem.client.1.21.256.nupkg",
    archive,
  );
  if (digest(archive) !== PACKAGE_SHA256) {
    throw new Error("Gamepad SDK package digest does not match Nefarius.ViGEm.Client 1.21.256");
  }
  extractZip(archive, directory);
  const output = join(directory, "ViGEmClient.dll");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFile($env:PIIK_GAMEPAD_ASSEMBLY)
$resource = $assembly.GetManifestResourceStream('costura64.vigemclient.dll')
if ($null -eq $resource) { throw 'Pinned gamepad SDK x64 resource is missing' }
$output = [IO.File]::Create($env:PIIK_GAMEPAD_OUTPUT)
try { $resource.CopyTo($output) } finally { $output.Dispose(); $resource.Dispose() }
`], { stdio: "pipe", windowsHide: true, env: {
    ...process.env,
    PIIK_GAMEPAD_ASSEMBLY: join(directory, "lib", "netstandard2.0", "Nefarius.ViGEm.Client.dll"),
    PIIK_GAMEPAD_OUTPUT: output,
  } });
  if (digest(output) !== GAMEPAD_CLIENT_SHA256) {
    throw new Error("Extracted gamepad client digest does not match the pinned Windows x64 SDK");
  }
  return output;
}

export function prepareGamepadClient(packageRoot, inputPath) {
  if (!inputPath) return null;
  if (digest(inputPath) !== GAMEPAD_CLIENT_SHA256) {
    throw new Error("Gamepad client digest does not match Nefarius.ViGEm.Client 1.21.256 (Windows x64)");
  }
  const output = join(packageRoot, "ViGEmClient.dll");
  copyFileSync(inputPath, output);
  return output;
}
