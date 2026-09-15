import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDocumentTitle } from "../src/client/ui/document-title";

const effect = vi.hoisted(() => ({ run: (() => undefined) as () => (() => void) | undefined }));
vi.mock("react", () => ({ useEffect: (run: typeof effect.run) => { effect.run = run; } }));

let cleanup: (() => void) | undefined;
const page = { title: "", visibilityState: "visible" };

beforeEach(() => {
  vi.useFakeTimers();
  page.title = "";
  page.visibilityState = "visible";
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setInterval, clearInterval, matchMedia: () => ({ matches: false }) });
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses every decoration before repeating while retaining room identity and ordinary state", () => {
  useDocumentTitle(["9527", "Sharing"], ["A", "B", "C"]);
  cleanup = effect.run();
  expect(page.title).toBe("Piik | 9527 · Sharing");
  for (const next of ["A", "B", "C"]) {
    vi.advanceTimersByTime(15_000);
    expect(page.title).toBe(`Piik | 9527 · ${next}`);
    vi.advanceTimersByTime(15_000);
    expect(page.title).toBe("Piik | 9527 · Sharing");
  }
  vi.mocked(Math.random).mockReturnValue(0.99);
  vi.advanceTimersByTime(15_000);
  expect(page.title).not.toBe("Piik | 9527 · C");
  cleanup?.();
  cleanup = undefined;
  expect(page.title).toBe("Piik");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps hidden pages from consuming a decoration and replaces the previous context cleanly", () => {
  useDocumentTitle(["9527", "Sharing"], ["A", "B"]);
  cleanup = effect.run();
  page.visibilityState = "hidden";
  vi.advanceTimersByTime(60_000);
  expect(page.title).toBe("Piik | 9527 · Sharing");
  page.visibilityState = "visible";
  vi.advanceTimersByTime(15_000);
  expect(page.title).toBe("Piik | 9527 · A");
  cleanup?.();
  useDocumentTitle(["1234", "Watching"], ["New"]);
  cleanup = effect.run();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(15_000);
  expect(page.title).toBe("Piik | 1234 · New");
});

it.each(["Paused", "Unavailable"])("keeps %s fixed without a rotation timer", (state) => {
  useDocumentTitle(["9527", state]);
  cleanup = effect.run();
  vi.advanceTimersByTime(60_000);
  expect(page.title).toBe(`Piik | 9527 · ${state}`);
  expect(vi.getTimerCount()).toBe(0);
});

it("respects reduced motion with a populated catalog", () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  useDocumentTitle(["9527", "Sharing"], ["A", "B"]);
  cleanup = effect.run();
  vi.advanceTimersByTime(60_000);
  expect(page.title).toBe("Piik | 9527 · Sharing");
  expect(vi.getTimerCount()).toBe(0);
});
