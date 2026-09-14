import { afterEach, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomAdmissionBadge } from "../src/client/components/living/RoomChip";
import { HintComic, type HintKind } from "../src/client/components/living/hints";
import type { Tooltip } from "../src/client/components/living/Tooltip";
import { setCopy, t } from "../src/client/ui/copy";

// Open the tooltip content for SSR; keep the actual badge, Pill and scene.
vi.mock("../src/client/components/living/Tooltip", () => ({
  Tooltip: ({ kind, tone, motion, children }: Parameters<typeof Tooltip>[0]) =>
    createElement(Fragment, null, children, createElement(HintComic, { kind: kind as HintKind, tone, motion })),
}));

afterEach(() => setCopy({ lang: "zh", vis: false }));

it.each([
  ["open", false, "currentOpen", true, false, false],
  ["open", true, "currentOpen", true, false, false],
  ["private", true, "currentPassword", true, true, false],
  ["private", false, "currentInvite", false, false, true],
] as const)("shows the current admission credential for %s / password=%s", (policy, passwordEnabled, label, code, password, invite) => {
  for (const mode of ["zh", "en", "vis"] as const) {
    const lang = mode === "zh" ? "zh" : "en";
    setCopy({ lang, vis: mode === "vis" });
    const html = renderToStaticMarkup(createElement(RoomAdmissionBadge, { policy, passwordEnabled }));
    expect(html).toContain(t(lang, `host.policy.${label}`));
    expect(html).toContain('data-comic-tone="off"');
    expect(html).toContain('data-comic-motion="still"');
    expect(html.includes('class="vls-admission-code"')).toBe(code);
    expect(html.includes('class="vls-admission-password"')).toBe(password);
    expect(html.includes('class="vls-admission-invite"')).toBe(invite);
    expect(html).not.toContain("vls-priv-lock");
  }
});
