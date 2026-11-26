import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileRecords, compareFileRecords } from "./package-files.mjs";
import { webSourceAssets } from "./container-web-identity.mjs";

// A build receipt uses the same identity and file records as release packaging.
// It stays beside the Web tree, so it does not become another served resource.
const receiptPath = directory => `${resolve(directory)}.build.json`;

function checkEntry(directory, records, revision) {
  const paths = new Set(records.map(record => record.path));
  const html = readFileSync(join(directory, "index.html"), "utf8");
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const value = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!value) continue;
    const asset = new URL(value, "http://piik.invalid/");
    if (asset.origin === "http://piik.invalid")
      assert.ok(paths.has(decodeURIComponent(asset.pathname).slice(1)), `Built Web linked asset is missing: ${value}`);
  }
  assert.ok(webSourceAssets(html).some(asset => readFileSync(join(directory, asset.slice(1)), "utf8").includes(revision)),
    "Web and runtime must have the same source identity");
  assert.ok(records.some(record => record.path.endsWith(".wasm") &&
    readFileSync(join(directory, record.path)).subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))),
  "Built Web has no Rust/WASM adapter");
  assert.ok(records.some(record => record.path === "third-party-licenses.txt" && record.size > 0),
    "Built Web third-party notices are missing");
}

export function recordChannelWeb(directory, { version, revision }) {
  const files = fileRecords(directory);
  checkEntry(directory, files, revision);
  writeFileSync(receiptPath(directory), `${JSON.stringify({ version, revision, files }, null, 2)}\n`);
}

function readReceipt(directory, { version, revision }) {
  const receipt = JSON.parse(readFileSync(receiptPath(directory), "utf8"));
  assert.ok(receipt.version === version && receipt.revision === revision, "Shared Web build identity mismatch");
  assert.ok(Array.isArray(receipt.files) && receipt.files.every(file => file && typeof file.path === "string" &&
    Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256)), "Invalid shared Web file inventory");
  return receipt;
}

function checkReceipt(directory, receipt) {
  compareFileRecords(receipt.files, fileRecords(directory));
  checkEntry(directory, receipt.files, receipt.revision);
}

/** Reuse exact bytes; a missing or mismatched receipt never triggers a build. */
export function verifyChannelWeb(directory, identity) {
  directory = resolve(directory);
  checkReceipt(directory, readReceipt(directory, identity));
  return directory;
}

/** Verify reused Web against the receipt read before copying into the package. */
export function copyChannelWeb(directory, staged, identity) {
  const receipt = identity && readReceipt(directory, identity);
  cpSync(directory, staged, { recursive: true });
  if (receipt) checkReceipt(staged, receipt);
}
