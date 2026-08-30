import { afterEach, describe, expect, it, vi } from "vitest";
import { composeDocumentTitle } from "../src/client/ui/document-title.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("theme preference", () => {
  it("keeps room state compact and the product name first", () => {
    expect(composeDocumentTitle("7063", "Sharing")).toBe(
      "Screener | 7063 · Sharing",
    );
    expect(composeDocumentTitle()).toBe("Screener");
  });

  it("follows the system until the user chooses explicitly", async () => {
    const values = new Map<string, string>();
    let dark = false;
    let onChange = (_event: { matches: boolean }): void => undefined;
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      matchMedia: () => ({
        matches: dark,
        addEventListener: (
          _event: string,
          listener: (event: { matches: boolean }) => void,
        ) => {
          onChange = listener;
        },
      }),
    });

    const theme = await import("../src/client/ui/theme.ts");
    theme.initTheme();
    expect(dataset.theme).toBe("light");

    dark = true;
    onChange({ matches: dark });
    expect(dataset.theme).toBe("dark");

    theme.applyTheme("light");
    expect(values.get("screener:ui-theme")).toBe("light");
    onChange({ matches: true });
    expect(dataset.theme).toBe("light");
  });
});
