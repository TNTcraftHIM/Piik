#!/usr/bin/env node

import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseArtifacts } from "./release-artifacts.mjs";

export function signUpdateIndex(directory, version, revision, outputDirectory) {
  if (!outputDirectory) throw new Error("A new output directory is required");
  const pem = process.env.PIIK_UPDATE_SIGNING_KEY;
  const trustedPublicKey = process.env.PIIK_UPDATE_PUBLIC_KEY;
  if (!pem || !/^\s*-----BEGIN PRIVATE KEY-----/.test(pem)) {
    throw new Error("PIIK_UPDATE_SIGNING_KEY must contain a PKCS8 PEM private key");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trustedPublicKey ?? "")) {
    throw new Error("PIIK_UPDATE_PUBLIC_KEY must contain the trusted 32-byte public key as hex");
  }
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    throw new Error("PIIK_UPDATE_SIGNING_KEY is not a valid PKCS8 PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 signing key is required");
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  if (Buffer.from(publicKey.x, "base64url").toString("hex") !== trustedPublicKey.toLowerCase()) {
    throw new Error("Signing key does not match PIIK_UPDATE_PUBLIC_KEY");
  }

  // Release identity and package hashes have one verifier; no independent index input.
  const release = readReleaseArtifacts(directory, version, revision);
  const targets = Object.fromEntries([...release.packagesByTarget.keys()].sort().map(target => {
    const asset = release.packagesByTarget.get(target);
    return [target, { artifact: asset.name, size: asset.size, sha256: asset.sha256 }];
  }));
  const bytes = Buffer.from(JSON.stringify({
    schema: 1, version: release.version, revision: release.revision, targets,
  }, null, 2) + "\n", "utf8");
  const signature = sign(null, bytes, key);
  const output = resolve(outputDirectory);
  mkdirSync(dirname(output), { recursive: true });
  // A new directory keeps retries from replacing an already signed result.
  mkdirSync(output);
  writeFileSync(join(output, "update.json"), bytes, { flag: "wx" });
  writeFileSync(join(output, "update.json.sig"), signature, { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6) {
      throw new Error("Use release-update-index.mjs <artifacts> <version> <full-SHA> <new-output-directory>");
    }
    signUpdateIndex(...process.argv.slice(2));
    process.stdout.write("Created update.json and update.json.sig.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
