import { describe, expect, it, vi } from "vitest";

import { copyRoomCode } from "../src/client/components/room-code.ts";

describe("room code copy boundary", () => {
  it("copies only the visible room code", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();

    await copyRoomCode("123456", writeText);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("123456");
  });

  it("propagates clipboard failures for the UI to report", async () => {
    const failure = new Error("clipboard unavailable");
    const writeText = vi.fn<(value: string) => Promise<void>>().mockRejectedValue(failure);

    await expect(copyRoomCode("7", writeText)).rejects.toBe(failure);
  });
});
