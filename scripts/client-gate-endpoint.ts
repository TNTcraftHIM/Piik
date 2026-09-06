import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
} from "../src/client/native/wire";
import { withDeadline } from "./browser-gate-harness";

const INSTANCE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ClientEndpoint {
  url: string;
  host: string;
  port: number;
  instanceToken: string;
}

export function decodeClientEndpoint(line: string): ClientEndpoint {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Client endpoint is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Client endpoint is invalid");
  }
  const endpoint = value as Partial<ClientEndpoint>;
  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port! < NATIVE_CLIENT_PORT_START ||
    endpoint.port! > NATIVE_CLIENT_PORT_END ||
    endpoint.host !== `127.0.0.1:${endpoint.port}` ||
    endpoint.url !== `http://${endpoint.host}` ||
    typeof endpoint.instanceToken !== "string" ||
    !INSTANCE_TOKEN_PATTERN.test(endpoint.instanceToken) ||
    Object.keys(value).length !== 4
  ) {
    throw new Error("Client endpoint is invalid");
  }
  return endpoint as ClientEndpoint;
}

// readClientEndpoint waits for the first valid loopback endpoint from stdout.
export async function readClientEndpoint(
  client: ChildProcessWithoutNullStreams,
  options: { timeoutMs?: number; ignoreNonEndpointLines?: boolean } = {},
): Promise<ClientEndpoint> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let cleanup = () => undefined;
  try {
    return await withDeadline(
      () => new Promise<ClientEndpoint>((resolveEndpoint, rejectEndpoint) => {
        let buffered = "";
        const finish = (callback: () => void) => {
          cleanup();
          callback();
        };
        const onData = (chunk: Buffer) => {
          buffered += chunk.toString();
          for (;;) {
            const newline = buffered.indexOf("\n");
            if (newline < 0) return;
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            try {
              const endpoint = decodeClientEndpoint(line);
              finish(() => resolveEndpoint(endpoint));
              return;
            } catch (error) {
              if (!options.ignoreNonEndpointLines) {
                finish(() => rejectEndpoint(error));
                return;
              }
            }
          }
        };
        const onError = (error: Error) => finish(() => rejectEndpoint(error));
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
          finish(() => rejectEndpoint(
            new Error(`Client exited before endpoint (${code ?? signal ?? "signal"})`),
          ));
        cleanup = () => {
          client.stdout.off("data", onData);
          client.off("error", onError);
          client.off("exit", onExit);
        };
        client.stdout.on("data", onData);
        client.once("error", onError);
        client.once("exit", onExit);
      }),
      deadline,
    );
  } finally {
    cleanup();
  }
}
