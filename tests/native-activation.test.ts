import { afterEach, describe, expect, it, vi } from "vitest";
import { activateNativePicker, androidAppIntent } from "../src/client/native/activation";
import { nativeHealthSchema, NATIVE_CLIENT_PROTOCOL } from "../src/client/native/wire";
import { NATIVE_CLIENT_PORT_START } from "../src/client/native/discovery-ports";

describe("Android App foreground actions", () => {
  afterEach(() => vi.unstubAllGlobals());
  const android = "Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile";
  it.each([true, false, undefined])("hands off only while the original gesture is active: %s", isActive => {
    const assign = vi.fn();
    vi.stubGlobal("navigator", { userAgent: android, userActivation: isActive === undefined ? undefined : { isActive } });
    vi.stubGlobal("window", { location: { assign } });
    activateNativePicker(undefined);
    expect(assign).not.toHaveBeenCalled();
    activateNativePicker("silip://media");
    expect(assign).toHaveBeenCalledTimes(isActive ? 1 : 0);
    if (isActive) {
      expect(assign).toHaveBeenCalledWith("intent://media#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end");
      assign.mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
      expect(() => activateNativePicker("silip://media")).not.toThrow();
    }
  });
  it("allows only fixed Silip actions in its explicit Android package", () => {
    expect(androidAppIntent("silip://app", android)).toBe("intent://app#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end");
    expect(androidAppIntent("silip://media", android)).toBe("intent://media#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end");
    for (const action of [undefined, null, "https://silip.example", "silip://media?approve=true", "silip://media#token=secret",
      "silip://user@media", "silip://media/start", "intent://media#Intent;package=other;end"]) {
      expect(androidAppIntent(action, android)).toBeNull();
    }
    expect(androidAppIntent("silip://app", "Mozilla/5.0 (Windows NT 10.0)")).toBeNull();
    expect(androidAppIntent("silip://app", "Mozilla/5.0 (iPhone)")).toBeNull();
  });

  it("uses the connected App's media action in Android desktop mode", () => {
    const desktop = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";
    const assign = vi.fn();
    vi.stubGlobal("navigator", { userAgent: desktop, userActivation: { isActive: true } });
    vi.stubGlobal("window", { location: { assign } });
    activateNativePicker("silip://media");
    expect(assign).toHaveBeenCalledWith("intent://media#Intent;scheme=silip;package=io.github.p4aaaul.silip.android;end");
    expect(androidAppIntent("silip://app", desktop)).toBeNull();
  });

  it("keeps activation optional and validates the known health extension", () => {
    const health = { protocol: NATIVE_CLIENT_PROTOCOL, service: "silip-client", port: NATIVE_CLIENT_PORT_START,
      instanceToken: "a".repeat(43), nativeMedia: {} };
    expect(nativeHealthSchema.parse(health).activationURL).toBeUndefined();
    expect(nativeHealthSchema.parse({ ...health, activationURL: "silip://media" }).activationURL).toBe("silip://media");
    expect(nativeHealthSchema.safeParse({ ...health, activationURL: "silip://app" }).success).toBe(false);
  });
});
