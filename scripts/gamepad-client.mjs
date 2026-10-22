import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Native x64 client embedded in official Nefarius.ViGEm.Client 1.21.256.
export const GAMEPAD_CLIENT_SHA256 = "00303f99e1968d523fbd08a7c691d60d145b7335059ec593947841d124c10875";

export function prepareGamepadClient(packageRoot, inputPath) {
  if (!inputPath) return null;
  const digest = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
  if (digest !== GAMEPAD_CLIENT_SHA256) {
    throw new Error("Gamepad client digest does not match Nefarius.ViGEm.Client 1.21.256 (Windows x64)");
  }
  const output = join(packageRoot, "ViGEmClient.dll");
  copyFileSync(inputPath, output);
  return output;
}
