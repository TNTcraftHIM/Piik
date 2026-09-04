import { describe, expect, it } from "vitest";

import {
  createLocalServerConfig,
  loadLocalServerConfig,
} from "../src/server/local-config.ts";

describe("local server configuration", () => {
  it("maps Client inputs into the common P2P-only server contract", () => {
    const config = createLocalServerConfig({
      port: 9123,
      publicAddress: "192.168.1.10",
      allowedAddresses: ["10.0.0.8", "192.168.1.10"],
      siteAccessPassword: "local-access-password",
    });

    expect(config).toMatchObject({
      nodeEnv: "production",
      port: 9123,
      listenHost: "0.0.0.0",
      siteAccessPassword: "local-access-password",
      roomLeaseMs: 86_400_000,
      maxViewersPerRoom: 20,
      peerAssistedMedia: true,
      endpointMediaCopyCapacity: 2,
      stunUrls: [],
      natPredictionEnabled: false,
    });
    expect(config.publicBaseUrl.href).toBe("http://192.168.1.10:9123/");
    expect(config.allowedOrigins).toEqual(new Set([
      "http://localhost:9123",
      "http://127.0.0.1:9123",
      "http://192.168.1.10:9123",
      "http://10.0.0.8:9123",
    ]));
    expect(config.livekitFallback).toBeUndefined();
    expect(config.roomDatabasePath).toBeUndefined();
  });

  it("loads the internal Client process environment", () => {
    const config = loadLocalServerConfig({
      SCREENER_CLIENT_PORT: "9234",
      SCREENER_CLIENT_LAN_ADDRESS: "192.168.50.4",
      SCREENER_CLIENT_ALLOWED_LAN_ADDRESSES: "192.168.50.4, 10.10.0.4",
      SCREENER_CLIENT_LOCAL_PASSWORD: "persistent-local-password",
      SCREENER_CLIENT_PUBLIC_ORIGIN: "https://small-bright-room.trycloudflare.com",
      STUN_URLS: "stun:stun.example:3478, stun:stun.example:3479",
      SCREENER_CLIENT_NAT_PREDICTION_STUN_URLS:
        "stun:survey-a.example:3478, stun:survey-b.example:3478",
    });

    expect(config.port).toBe(9234);
    expect(config.publicBaseUrl.origin).toBe(
      "https://small-bright-room.trycloudflare.com",
    );
    expect(config.allowedOrigins).toContain(
      "https://small-bright-room.trycloudflare.com",
    );
    expect(config.allowedOrigins).toContain("http://10.10.0.4:9234");
    expect(config.stunUrls).toEqual([
      "stun:stun.example:3478",
      "stun:stun.example:3479",
    ]);
    expect(config.natPredictionEnabled).toBe(true);
    expect(config.natPredictionStunUrls).toEqual([
      "stun:survey-a.example:3478",
      "stun:survey-b.example:3478",
    ]);
  });

  it("leaves the Local site open when no password is supplied", () => {
    const config = createLocalServerConfig({
      port: 9235,
      publicAddress: "192.168.1.10",
    });

    expect(config.siteAccessPassword).toBeUndefined();
  });

  it("accepts an empty Client password from the process environment", () => {
    const config = loadLocalServerConfig({
      SCREENER_CLIENT_PORT: "9236",
      SCREENER_CLIENT_LAN_ADDRESS: "192.168.50.4",
      SCREENER_CLIENT_LOCAL_PASSWORD: "",
    });

    expect(config.siteAccessPassword).toBeUndefined();
  });

  it.each([
    { publicAddress: "localhost", password: "valid-password" },
    { publicAddress: "127.0.0.1", password: "valid-password" },
    { publicAddress: "0.0.0.0", password: "valid-password" },
    { publicAddress: "192.168.1.2", password: "short" },
  ])("rejects an invalid Local authority input", ({ publicAddress, password }) => {
    expect(() => createLocalServerConfig({
      publicAddress,
      siteAccessPassword: password,
    })).toThrow();
  });

  it.each([
    "http://public.example",
    "https://public.example/path",
    "https://user@public.example",
  ])("rejects invalid public origin %s", (publicOrigin) => {
    expect(() => createLocalServerConfig({
      publicAddress: "192.168.1.2",
      publicOrigin,
      siteAccessPassword: "valid-password",
    })).toThrow("Local public origin must be an HTTPS origin");
  });
});
