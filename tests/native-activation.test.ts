import { describe, expect, it } from "vitest";
import { androidAppIntent } from "../src/client/native/activation";
import { nativeHealthSchema, NATIVE_CLIENT_PROTOCOL, NATIVE_CLIENT_PORT_START } from "../src/client/native/wire";

describe("Android App foreground actions", () => {
  const android = "Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile";
  it("allows only fixed Piik actions in its explicit Android package", () => {
    expect(androidAppIntent("piik://app", android)).toBe("intent://app#Intent;scheme=piik;package=tv.piik.android;end");
    expect(androidAppIntent("piik://media", android)).toBe("intent://media#Intent;scheme=piik;package=tv.piik.android;end");
    for (const action of [undefined, null, "https://piik.tv", "piik://media?approve=true", "piik://media#token=secret",
      "piik://user@media", "piik://media/start", "intent://media#Intent;package=other;end"]) {
      expect(androidAppIntent(action, android)).toBeNull();
    }
    expect(androidAppIntent("piik://media", "Mozilla/5.0 (Windows NT 10.0)")).toBeNull();
    expect(androidAppIntent("piik://app", "Mozilla/5.0 (iPhone)")).toBeNull();
  });

  it("keeps activation optional and validates the known health extension", () => {
    const health = { protocol: NATIVE_CLIENT_PROTOCOL, service: "piik-client", port: NATIVE_CLIENT_PORT_START,
      instanceToken: "a".repeat(43), nativeMedia: {} };
    expect(nativeHealthSchema.parse(health).activationURL).toBeUndefined();
    expect(nativeHealthSchema.parse({ ...health, activationURL: "piik://media" }).activationURL).toBe("piik://media");
    expect(nativeHealthSchema.safeParse({ ...health, activationURL: "piik://app" }).success).toBe(false);
  });
});
