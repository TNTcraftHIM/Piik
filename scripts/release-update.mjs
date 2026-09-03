#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const DEFAULT_RELEASE_API_URL =
  "https://api.github.com/repos/TNTcraftHIM/Screener/releases/latest";

export const UPDATE_EXIT_CODES = Object.freeze({
  upToDate: 0,
  available: 10,
  unavailable: 20,
});

const FULL_REVISION = /^[0-9a-f]{40}$/i;
const RELEASE_PATH_PREFIX = "/TNTcraftHIM/Screener/releases/tag/";

export function normalizeRevision(value) {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FULL_REVISION.test(revision) ? revision : null;
}

export function parseReleaseMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (value.draft === true || value.prerelease === true) {
    return null;
  }
  const revision = normalizeRevision(value.tag_name);
  if (!revision || typeof value.html_url !== "string") {
    return null;
  }

  let releaseURL;
  try {
    releaseURL = new URL(value.html_url);
  } catch {
    return null;
  }
  if (
    releaseURL.protocol !== "https:" ||
    releaseURL.hostname !== "github.com" ||
    releaseURL.username ||
    releaseURL.password ||
    releaseURL.port ||
    releaseURL.search ||
    releaseURL.hash ||
    !releaseURL.pathname.startsWith(RELEASE_PATH_PREFIX)
  ) {
    return null;
  }
  let tag = "";
  try {
    tag = decodeURIComponent(releaseURL.pathname.slice(RELEASE_PATH_PREFIX.length));
  } catch {
    return null;
  }
  if (normalizeRevision(tag) !== revision) {
    return null;
  }
  return { revision, url: releaseURL.toString() };
}

export function unavailableResult(currentRevision) {
  return {
    status: "unavailable",
    currentRevision: normalizeRevision(currentRevision),
    latestRevision: null,
    releaseUrl: null,
  };
}

export async function checkRelease({
  currentRevision,
  apiURL = DEFAULT_RELEASE_API_URL,
  token = process.env.GITHUB_TOKEN || "",
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = normalizeRevision(currentRevision);
  if (!current || typeof fetchImpl !== "function") {
    return unavailableResult(currentRevision);
  }

  let endpoint;
  try {
    endpoint = new URL(apiURL);
  } catch {
    return unavailableResult(currentRevision);
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    return unavailableResult(currentRevision);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Screener-release-check",
    };
    if (
      endpoint.protocol === "https:" &&
      endpoint.hostname === "api.github.com" &&
      typeof token === "string" &&
      token.trim() !== ""
    ) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    const response = await fetchImpl(endpoint.toString(), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) {
      return unavailableResult(current);
    }
    const latest = parseReleaseMetadata(await response.json());
    if (!latest) {
      return unavailableResult(current);
    }
    return {
      status: latest.revision === current ? "up-to-date" : "update-available",
      currentRevision: current,
      latestRevision: latest.revision,
      releaseUrl: latest.url,
    };
  } catch {
    return unavailableResult(current);
  } finally {
    clearTimeout(timer);
  }
}

function usage() {
  return "Usage: node scripts/release-update.mjs --current-file <REVISION> [--api-url <URL>]";
}

function parseArguments(argumentsList) {
  let currentFile = null;
  let apiURL = DEFAULT_RELEASE_API_URL;
  let apiURLSet = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      (name === "--current-file" || name === "--api-url") &&
      (!value || value.startsWith("--"))
    ) {
      throw new Error(usage());
    }
    if (name === "--current-file" && currentFile === null) {
      currentFile = value;
      index += 1;
    } else if (name === "--api-url" && !apiURLSet) {
      apiURL = value;
      apiURLSet = true;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (!currentFile) {
    throw new Error(usage());
  }
  return { currentFile, apiURL };
}

async function main() {
  let argumentsValue;
  try {
    argumentsValue = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : usage()}\n`);
    process.exitCode = 2;
    return;
  }

  let currentRevision = null;
  try {
    currentRevision = readFileSync(resolve(argumentsValue.currentFile), "ascii");
  } catch {
    // An unavailable deployed identity is an unavailable check, not an update.
  }
  const result = await checkRelease({
    currentRevision,
    apiURL: argumentsValue.apiURL,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = UPDATE_EXIT_CODES[
    result.status === "update-available"
      ? "available"
      : result.status === "up-to-date"
        ? "upToDate"
        : "unavailable"
  ];
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const self = resolve(dirname(fileURLToPath(import.meta.url)), "release-update.mjs");
if (entry === self) {
  await main();
}
