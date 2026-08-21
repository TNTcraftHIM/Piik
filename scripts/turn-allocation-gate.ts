import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSelectedEdgeTurn } from "../src/server/config";
import { issueSelectedEdgeTurnCredential } from "../src/server/selected-edge-turn";

const allowedProtocols = new Set(["udp", "tcp", "unknown"]);
const allowedErrorBuckets = new Set(["3xx", "4xx", "5xx", "6xx", "701", "other"]);

export interface TurnAllocationResult {
  status: "passed" | "failed";
  relayCandidateCount: number;
  protocols: string[];
  errorCodeBuckets: string[];
}

export function parseGateEnvironment(input: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const line of input.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

export function parseGateResult(input: string): TurnAllocationResult {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("Chrome returned an invalid TURN allocation result"); }
  if (!value || typeof value !== "object") throw new Error("Chrome returned an invalid TURN allocation result");
  const raw = value as Record<string, unknown>;
  if ((raw.status !== "passed" && raw.status !== "failed") ||
      !Number.isInteger(raw.relayCandidateCount) || Number(raw.relayCandidateCount) < 0 ||
      !Array.isArray(raw.protocols) || !raw.protocols.every((item) => allowedProtocols.has(item)) ||
      !Array.isArray(raw.errorCodeBuckets) || !raw.errorCodeBuckets.every((item) => allowedErrorBuckets.has(item))) {
    throw new Error("Chrome returned an invalid TURN allocation result");
  }
  const protocols = [...new Set(raw.protocols as string[])];
  if (raw.status === "passed" && (Number(raw.relayCandidateCount) === 0 ||
      protocols.length !== 1 || protocols[0] !== "udp")) {
    throw new Error("Chrome returned an invalid TURN allocation result");
  }
  return { status: raw.status, relayCandidateCount: Number(raw.relayCandidateCount),
    protocols,
    errorCodeBuckets: [...new Set(raw.errorCodeBuckets as string[])] };
}

const page = `<!doctype html><script>
(async()=>{const errors=new Set(),protocols=new Set();let count=0,done=false,pc;
const finish=async status=>{if(done)return;done=true;clearTimeout(timer);pc?.close();await fetch("/result",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,relayCandidateCount:count,protocols:[...protocols],errorCodeBuckets:[...errors]})})};
const bucket=n=>n===701?"701":n>=300&&n<700?Math.floor(n/100)+"xx":"other";
const timer=setTimeout(()=>finish("failed"),10000);
try{const iceServer=await fetch("/credential",{cache:"no-store"}).then(r=>r.json());pc=new RTCPeerConnection({iceServers:[iceServer],iceTransportPolicy:"relay"});
pc.onicecandidateerror=e=>errors.add(bucket(e.errorCode));pc.onicecandidate=e=>{if(e.candidate){if(e.candidate.type==="relay"){count++;protocols.add(e.candidate.protocol||"unknown")}}else finish(count>0&&protocols.size===1&&protocols.has("udp")?"passed":"failed")};
pc.createDataChannel("allocation");await pc.setLocalDescription(await pc.createOffer())}catch{finish("failed")}})();
</script>`;

export async function main(): Promise<number> {
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error("CHROME_PATH is required");
  const stdin = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  const config = parseSelectedEdgeTurn({ ...parseGateEnvironment(stdin), ...process.env });
  if (!config) throw new Error("The selected-edge TURN tuple is required");
  const grant = issueSelectedEdgeTurnCredential(config, { edgeKind: "host-sfu-ingress",
    roomId: "allocation-gate", shareGeneration: "gate-share", revision: 1,
    hostPeerId: "gate-host", hostSessionId: "gate-session",
    publicationGeneration: "gate-publication", oldConnectionId: "gate-publication",
    newConnectionId: "gate-connection" }, Date.now());
  let settle!: (result: TurnAllocationResult) => void;
  const resultPromise = new Promise<TurnAllocationResult>((resolve) => { settle = resolve; });
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/credential") response.end(JSON.stringify(grant.iceServer));
    else if (request.url === "/") response.end(page);
    else if (request.url === "/result" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { if (body.length < 4_096) body += chunk; });
      request.on("end", () => {
        try { settle(parseGateResult(body)); response.end(); }
        catch { response.statusCode = 400; response.end(); }
      });
    }
    else { response.statusCode = 404; response.end(); }
  });
  const profile = await mkdtemp(join(tmpdir(), "screener-turn-gate-"));
  let chrome: ReturnType<typeof execFile> | undefined;
  let chromeClosed: Promise<void> = Promise.resolve();
  let timeout: NodeJS.Timeout | undefined;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TURN gate listener failed");
    chrome = execFile(chromePath, ["--headless=new", "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`,
      `http://127.0.0.1:${address.port}/`], { timeout: 20_000, windowsHide: true }, () => {});
    chromeClosed = new Promise((resolve) => { chrome!.once("close", () => resolve()); });
    const chromeFailure = new Promise<never>((_, reject) => {
      chrome!.once("error", () => reject(new Error("Chrome failed to start")));
      chrome!.once("exit", () => reject(new Error("Chrome exited before TURN allocation completed")));
    });
    const result = await Promise.race([resultPromise, chromeFailure,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Chrome did not complete the TURN allocation gate")), 15_000); })]);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
    return result.status === "passed" ? 0 : 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (chrome?.exitCode === null) chrome.kill();
    const serverClose = server.listening
      ? new Promise<void>((resolve) => { server.close(() => resolve()); })
      : Promise.resolve();
    await Promise.allSettled([chromeClosed, serverClose]);
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 2;
  });
}
