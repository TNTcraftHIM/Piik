import { expect, it } from "vitest";
import { applyPlaybackBufferTarget } from "../src/client/webrtc/receiver-buffer-target";

it("uses instance capability, retains unsupported/failed facts and distinguishes automatic from zero", () => {
  const track = { readyState: "live" };
  const supported = { track, jitterBufferTarget: null as number | null };
  const unsupported = { track };
  const failed = { track, get jitterBufferTarget() { return null; }, set jitterBufferTarget(_value: number | null) { throw new Error("refused"); } };
  const apply = (receivers: unknown[], target: number | null) => applyPlaybackBufferTarget(receivers as RTCRtpReceiver[], target);
  expect(apply([], 300)).toBeNull();
  expect(apply([supported], 0)).toBe("supported"); expect(supported.jitterBufferTarget).toBe(0);
  expect(apply([supported], null)).toBe("supported"); expect(supported.jitterBufferTarget).toBeNull();
  expect(apply([unsupported, supported], 300)).toBe("unsupported");
  expect(apply([supported, failed, unsupported], 300)).toBe("failed");
  expect(() => apply([supported], 4001)).toThrow(RangeError);
  expect(supported.jitterBufferTarget).toBe(300);
});
