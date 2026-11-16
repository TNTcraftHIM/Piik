import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

function fail(message) { throw new Error(message); }

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (
    value.length === 0 ||
    value.startsWith("../") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Invalid runtime path: ${value}`);
  }
  return value;
}

function regularFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`Runtime contains a link: ${absolute}`);
      if (metadata.isDirectory()) {
        pending.push(absolute);
      } else if (metadata.isFile()) {
        files.push(absolute);
      } else {
        fail(`Runtime contains an unsupported file type: ${absolute}`);
      }
    }
  }
  return files.sort((left, right) => {
    const a = normalizedRelative(root, left), b = normalizedRelative(root, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function fileRecords(root) {
  return regularFiles(root).map(absolute => ({
    path: normalizedRelative(root, absolute), size: statSync(absolute).size, sha256: sha256(absolute),
  }));
}

export function compareFileRecords(expected, actual) {
  if (expected.length !== actual.length) fail("Extracted runtime file count differs");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      left.path !== right.path ||
      left.size !== right.size ||
      left.sha256 !== right.sha256
    ) {
      fail(`Extracted runtime differs at ${left.path}`);
    }
  }
}
