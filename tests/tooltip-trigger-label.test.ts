import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Btn } from "../src/client/components/living/primitives";
import { Tooltip } from "../src/client/components/living/Tooltip";

it("a tooltip around a control named by text carries that text, never an object", () => {
  const markup = renderToStaticMarkup(createElement(Tooltip, { overflow: { text: "Friends", selector: ".lr-cap" },
    children: createElement(Btn, { icon: "chevron", title: { text: "Site settings" }, cap: { text: "Friends" }, disabled: true }) }));
  expect(markup).not.toContain("[object Object]");
  expect(markup).toContain('aria-label="Site settings"');
});
