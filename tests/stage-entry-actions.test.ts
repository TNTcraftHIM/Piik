import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StageEntryActions } from "../src/client/components/StageEntryActions.tsx";

describe("Host stage entry layout", () => {
  it("keeps disclosure as the immediate sibling after the fixed action row", () => {
    const closed = renderToStaticMarkup(
      createElement(StageEntryActions, {
        joiningRoom: false,
        onJoinToggle: () => undefined,
        onStartSharing: () => undefined,
      }),
    );
    const open = renderToStaticMarkup(
      createElement(StageEntryActions, {
        joiningRoom: true,
        onJoinToggle: () => undefined,
        onStartSharing: () => undefined,
      }),
    );

    expect(closed.match(/class="entry-action"/g)).toHaveLength(2);
    expect(open.match(/class="entry-action"/g)).toHaveLength(2);
    expect(open).toMatch(
      /class="entry-actions"[\s\S]*?<\/div><form[^>]*class="room-code-entry is-inline"/,
    );
    const row = open.match(/<div class="entry-actions">([\s\S]*?)<\/div>/)?.[1];
    expect(row).toContain("开始分享");
    expect(row).toContain("加入房间");
    expect(row).not.toContain('class="room-code-entry');
    expect(row).not.toContain("<form");
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('id="host-room-code-entry-input"');
  });

  it("uses bounded tracks for both the row and its independent disclosure", () => {
    const css = readFileSync(
      join(import.meta.dirname, "../src/client/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.entry-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 24px minmax\(0, 1fr\);[\s\S]*?width:\s*min\(520px, calc\(100% - 20px\)\);/,
    );
    expect(css).toMatch(
      /\.entry-action\s*\{[\s\S]*?min-height:\s*44px;/,
    );
    expect(css).toMatch(
      /\.room-code-entry\.is-inline\s*\{[\s\S]*?width:\s*min\(520px, calc\(100% - 20px\)\);[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 44px;/,
    );
  });
});
