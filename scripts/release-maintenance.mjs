#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const command = process.argv[2] ?? "website-check";
const commands = ["website-check", "website-purge", "server-check"];
if (command === "--help") {
  console.log("Usage: node --env-file=.env.maintenance.local scripts/release-maintenance.mjs <command>\nCommands: " + commands.join(", "));
  process.exit(0);
}
assert.ok(commands.includes(command) && process.argv.length <= 3, "Unknown maintenance command; use --help.");
const required = name => {
  const value = process.env[name]?.trim();
  assert.ok(value, `Set ${name} in the local maintenance env file.`);
  return value;
};
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });

async function cloudflare(method, path, body) {
  const zone = encodeURIComponent(required("CLOUDFLARE_ZONE_ID"));
  const response = await request(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, {
    method,
    redirect: "error",
    headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.ok(response.ok && data.success,
    `Cloudflare ${method} ${path}: HTTP ${response.status}; codes ${data.errors?.map(error => error.code).join(", ")}`);
  return data.result;
}

function websiteHosts() {
  const hosts = required("PIIK_WEBSITE_HOSTS").split(",").map(value => value.trim());
  for (const host of hosts) assert.equal(new URL(`https://${host}`).host, host, "Use comma-separated website hostnames.");
  return hosts;
}

async function checkWebsite() {
  const configuration = await Promise.all(["http_request_cache_settings", "http_response_headers_transform"].map(async phase => {
    const result = await cloudflare("GET", `/rulesets/phases/${phase}/entrypoint`);
    const rules = result.rules
      .filter(rule => rule.ref?.startsWith("piik_website_html_"))
      .map(({ ref, action, action_parameters, expression, enabled }) => ({ ref, action, action_parameters, expression, enabled }));
    return { phase, rules };
  }));
  const pages = [];
  for (const host of websiteHosts()) {
    let previousAssets;
    for (const path of ["/", "/index.html"]) {
      const url = `https://${host}${path}`;
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.ok(response.headers.get("cache-control")?.split(",").some(value => value.trim() === "no-cache"), `${url}: HTML must revalidate.`);
      assert.notEqual(response.headers.get("cf-cache-status"), "HIT", `${url}: stale HTML must not remain at the edge.`);
      const html = await response.text();
      const assets = [...html.matchAll(/\b(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(match => new URL(match[1], response.url).href);
      assert.ok(assets.length > 0, `${url}: no built stylesheet or script references.`);
      if (previousAssets) assert.deepEqual(assets, previousAssets, `${host}: root and index.html reference different builds.`);
      else for (const asset of assets) {
        const resource = await request(asset);
        assert.equal(resource.status, 200, asset);
        assert.match(resource.headers.get("content-type") ?? "", /css|javascript/, asset);
        await resource.body.cancel();
      }
      previousAssets = assets;
      pages.push({ url, cacheControl: response.headers.get("cache-control"), edge: response.headers.get("cf-cache-status"), assets });
    }
  }
  return { configuration, pages, passed: true };
}

async function checkServer() {
  const identity = process.env.PIIK_SSH_KEY?.trim();
  const args = [...(identity ? ["-i", identity] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", required("PIIK_SSH_TARGET"), "python3 -"];
  const remote = JSON.parse(execFileSync("ssh", args, {
    input: `import json, os, pathlib, subprocess
p = pathlib.Path('/opt/piik/current')
state = subprocess.run(['systemctl', 'is-active', 'piik'], capture_output=True, text=True).stdout.strip()
pid = int(subprocess.check_output(['systemctl', 'show', '--value', '-p', 'MainPID', 'piik']))
print(json.dumps({
    'revision': (p / 'REVISION').read_text().strip(),
    'service': state,
    'runningPackage': pid > 0 and os.path.samefile('/proc/' + str(pid) + '/exe', p / 'piik-server'),
}))
`,
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 25_000, windowsHide: true,
  }));
  const origin = new URL(required("PIIK_SERVER_ORIGIN"));
  assert.ok(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password, "Use a credential-free Server origin.");
  const response = await request(new URL("/healthz", origin));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  assert.equal(remote.service, "active");
  assert.equal(remote.runningPackage, true, "The running binary differs from the current release.");
  return { ...remote, origin: origin.origin, health: true, passed: true };
}

try {
  let result;
  if (command === "website-check") result = await checkWebsite();
  else if (command === "server-check") result = await checkServer();
  else {
    const files = websiteHosts().flatMap(host => [`https://${host}/`, `https://${host}/index.html`]);
    await cloudflare("POST", "/purge_cache", { files });
    result = { purged: files.length, files };
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
