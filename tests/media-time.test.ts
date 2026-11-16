import { expect, test } from "vitest";
import { formatMediaTime } from "../src/client/media/media-time";

test("media labels preserve real elapsed time and distinguish unknown duration", () => {
  expect([0, 64.9, 3675, Number.NaN, Number.POSITIVE_INFINITY].map(formatMediaTime))
    .toEqual(["0:00", "1:04", "1:01:15", "–:––", "–:––"]);
});
