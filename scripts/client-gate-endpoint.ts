import {
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
} from "../src/client/native/wire";

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
