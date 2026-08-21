import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConnectionDetailsToggle } from "../src/client/components/ConnectionDetailsToggle.tsx";

describe("ConnectionDetailsToggle diagnostic export", () => {
  it("offers the familiar download action only with expanded exportable details", () => {
    const expanded = renderToStaticMarkup(
      createElement(ConnectionDetailsToggle, {
        checked: true,
        onChange: vi.fn(),
        onExport: vi.fn(),
      }),
    );
    const collapsed = renderToStaticMarkup(
      createElement(ConnectionDetailsToggle, {
        checked: false,
        onChange: vi.fn(),
        onExport: vi.fn(),
      }),
    );

    expect(expanded).toContain("下载脱敏连接诊断");
    expect(expanded).toContain("lucide-download");
    expect(collapsed).not.toContain("下载脱敏连接诊断");
  });
});
