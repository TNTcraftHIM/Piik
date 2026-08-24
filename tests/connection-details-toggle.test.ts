import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConnectionDetailsToggle } from "../src/client/components/ConnectionDetailsToggle.tsx";

describe("ConnectionDetailsToggle", () => {
  it("renders only the controlled connection-details checkbox", () => {
    const expanded = renderToStaticMarkup(
      createElement(ConnectionDetailsToggle, {
        checked: true,
        onChange: vi.fn(),
      }),
    );
    const collapsed = renderToStaticMarkup(
      createElement(ConnectionDetailsToggle, {
        checked: false,
        onChange: vi.fn(),
      }),
    );

    expect(expanded).toContain("显示连接详情");
    expect(expanded).toContain('type="checkbox"');
    expect(expanded).toContain("checked=\"\"");
    expect(expanded).not.toContain("button");
    expect(collapsed).not.toContain("checked=\"\"");
    expect(collapsed).not.toContain("下载");
  });
});
