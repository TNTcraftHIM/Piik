import { afterEach, describe, expect, it, vi } from "vitest";
import { activateNativePicker, androidAppIntent } from "../src/client/native/activation";
import { nativeHealthSchema, NATIVE_CLIENT_PROTOCOL, NATIVE_CLIENT_PORT_START } from "../src/client/native/wire";

describe("Android App foreground actions", () => {
  afterEach(() => vi.unstubAllGlobals());
  const android = "Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile";
  it.each([true, false, undefined])("hands off only while the original gesture is active: %s", isActive => {
    const assign = vi.fn();
    vi.stubGlobal("navigator", { userAgent: android, userActivation: isActive === undefined ? undefined : { isActive } });
    vi.stubGlobal("window", { location: { assign } });
    activateNativePicker(undefined);
    expect(assign).not.toHaveBeenCalled();
    activateNativePicker("piik://media");
    expect(assign).toHaveBeenCalledTimes(isActive ? 1 : 0);
    if (isActive) {
      expect(assign).toHaveBeenCalledWith("intent://media#Intent;scheme=piik;package=tv.piik.android;end");
      assign.mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
      expect(() => activateNativePicker("piik://media")).not.toThrow();
    }
  });
  it("allows only fixed Piik actions in its explicit Android package", () => {
    expect(androidAppIntent("piik://app", android)).toBe("intent://app#Intent;scheme=piik;package=tv.piik.android;end");
    expect(androidAppIntent("piik://media", android)).toBe("intent://media#Intent;scheme=piik;package=tv.piik.android;end");
    for (const action of [undefined, null, "https://piik.tv", "piik://media?approve=true", "piik://media#token=secret",
      "piik://user@media", "piik://media/start", "intent://media#Intent;package=other;end"]) {
      expect(androidAppIntent(action, android)).toBeNull();
    }
    expect(androidAppIntent("piik://app", "Mozilla/5.0 (Windows NT 10.0)")).toBeNull();
    expect(androidAppIntent("piik://app", "Mozilla/5.0 (iPhone)")).toBeNull();
  });

  it("uses the connected App's media action in Android desktop mode", () => {
    const desktop = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";
    const assign = vi.fn();
    vi.stubGlobal("navigator", { userAgent: desktop, userActivation: { isActive: true } });
    vi.stubGlobal("window", { location: { assign } });
    activateNativePicker("piik://media");
    expect(assign).toHaveBeenCalledWith("intent://media#Intent;scheme=piik;package=tv.piik.android;end");
    expect(androidAppIntent("piik://app", desktop)).toBeNull();
  });

  it("keeps activation optional and validates the known health extension", () => {
    const health = { protocol: NATIVE_CLIENT_PROTOCOL, service: "piik-client", port: NATIVE_CLIENT_PORT_START,
      instanceToken: "a".repeat(43), nativeMedia: {} };
    expect(nativeHealthSchema.parse(health).activationURL).toBeUndefined();
    expect(nativeHealthSchema.parse({ ...health, activationURL: "piik://media" }).activationURL).toBe("piik://media");
    expect(nativeHealthSchema.safeParse({ ...health, activationURL: "piik://app" }).success).toBe(false);
  });
});
