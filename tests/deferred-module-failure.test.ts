import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ChannelSettingsError } from "../src/client/channel/components/ChannelSettingsDialog";
import { settingsActionFailure } from "../src/client/ui/use-settings-action";
import { installDeferredModuleFailureTracking, isDeferredModuleFailure } from "../src/client/lib/deferred-module-failure";
import { say } from "../src/client/ui/copy";

test("deferred module failures show a user-triggered refresh in the shared result", () => {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  try {
    installDeferredModuleFailureTracking();
  } finally {
    vi.unstubAllGlobals();
  }
  const error = new TypeError("The operation failed");
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: error });
  expect(target.dispatchEvent(event)).toBe(true);
  expect(isDeferredModuleFailure(error)).toBe(true);
  expect(isDeferredModuleFailure(new TypeError(error.message))).toBe(false);

  const html = renderToStaticMarkup(createElement(ChannelSettingsError, { error: "deferred_module_load_failed" }));
  expect(html).toContain(say("channel.error.deferredModuleLoad"));
  expect(html).toContain(`aria-label="${say("common.refresh")}"`);
  const ordinaryResult = renderToStaticMarkup(createElement(ChannelSettingsError, { error: "operation_failed" }));
  expect(ordinaryResult).toContain(say("channel.error.actionFailed"));
  expect(ordinaryResult).not.toContain("<button");
});

test("an action owner keeps the failure code the banner would show and ignores cancellation", () => {
  expect(settingsActionFailure(new DOMException("Cancelled", "AbortError"))).toBeNull();
  expect(settingsActionFailure(new DOMException("Declined", "NotAllowedError"))).toBe("NotAllowedError");
  expect(settingsActionFailure(new Error("room_host_offline"))).toBe("room_host_offline");
  expect(settingsActionFailure("unknown")).toBe("operation_failed");
});
