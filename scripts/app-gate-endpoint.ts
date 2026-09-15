import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
} from "../src/client/native/wire";
import { withDeadline } from "./browser-gate-harness";

const INSTANCE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AppEndpoint {
  url: string;
  host: string;
  port: number;
  instanceToken: string;
}

export function decodeAppEndpoint(line: string): AppEndpoint {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("App endpoint is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App endpoint is invalid");
  }
  const endpoint = value as Partial<AppEndpoint>;
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
    throw new Error("App endpoint is invalid");
  }
  return endpoint as AppEndpoint;
}

// readAppEndpoint waits for the first valid loopback endpoint from stdout.
export async function readAppEndpoint(
  app: ChildProcessWithoutNullStreams,
  options: { timeoutMs?: number; ignoreNonEndpointLines?: boolean } = {},
): Promise<AppEndpoint> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let cleanup = () => undefined;
  try {
    return await withDeadline(
      () => new Promise<AppEndpoint>((resolveEndpoint, rejectEndpoint) => {
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
              const endpoint = decodeAppEndpoint(line);
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
            new Error(`App exited before endpoint (${code ?? signal ?? "signal"})`),
          ));
        cleanup = () => {
          app.stdout.off("data", onData);
          app.off("error", onError);
          app.off("exit", onExit);
        };
        app.stdout.on("data", onData);
        app.once("error", onError);
        app.once("exit", onExit);
      }),
      deadline,
    );
  } finally {
    cleanup();
  }
}
