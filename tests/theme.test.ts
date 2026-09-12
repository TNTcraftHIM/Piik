import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { composeDocumentTitle } from "../src/client/ui/document-title.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("theme preference", () => {
  it("keeps room state compact and the product name first", () => {
    expect(composeDocumentTitle("7063", "Sharing")).toBe(
      "Piik | 7063 · Sharing",
    );
    expect(composeDocumentTitle()).toBe("Piik");
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
        removeItem: (key: string) => values.delete(key),
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
    expect(theme.currentThemePreference()).toBeNull();

    dark = true;
    onChange({ matches: dark });
    expect(dataset.theme).toBe("dark");

    theme.applyTheme("light");
    expect(values.get("piik:ui-theme")).toBe("light");
    onChange({ matches: true });
    expect(dataset.theme).toBe("light");
    expect(theme.currentThemePreference()).toBe("light");

    theme.initTheme(null);
    expect(values.has("piik:ui-theme")).toBe(false);
    expect(dataset.theme).toBe("dark");
    expect(theme.currentThemePreference()).toBeNull();
    onChange({ matches: false });
    expect(dataset.theme).toBe("light");
  });

  it.each([false, true])("applies launch theme with blocked storage=%s", async (blocked) => {
    const values = new Map([["piik:ui-theme", "dark"]]);
    const dataset: Record<string, string> = { theme: "dark" };
    vi.stubGlobal("document", { documentElement: { dataset } });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (blocked) throw new Error("Storage disabled");
          values.set(key, value);
        },
      },
      matchMedia: () => ({ matches: true, addEventListener: vi.fn() }),
    });

    const theme = await import("../src/client/ui/theme.ts");
    theme.initTheme("light");
    expect(dataset.theme).toBe("light");
    expect(theme.currentThemePreference()).toBe("light");
    if (!blocked) expect(values.get("piik:ui-theme")).toBe("light");
  });

  it("uses the launch theme before first paint, including system and restricted storage", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    for (const [fragment, expected] of [
      ["piik-client=1&piik-theme=light", "light"],
      ["piik-client=1&piik-theme=system", "light"],
      ["piik-theme=light", "dark"],
      ["piik-client=1&piik-theme=invalid", "dark"],
    ]) {
      const dataset: Record<string, string> = {};
      runInNewContext(script!, {
        document: { documentElement: { dataset } },
        matchMedia: () => ({ matches: false }),
        location: { hash: `#${fragment}` },
        localStorage: { getItem: () => "dark" },
        URLSearchParams,
      });
      expect(dataset.theme).toBe(expected);
    }
    const dataset: Record<string, string> = {};
    runInNewContext(script!, {
      document: { documentElement: { dataset } },
      matchMedia: () => ({ matches: false }),
      location: { hash: "#piik-client=1&piik-theme=dark" },
      localStorage: { getItem: () => { throw new Error("Storage disabled"); } },
      URLSearchParams,
    });
    expect(dataset.theme).toBe("dark");
  });
});
