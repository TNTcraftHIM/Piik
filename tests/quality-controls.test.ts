import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { VideoRateControls } from "../src/client/components/living/QualityPresets";
import { QUALITY_PROFILES, VIDEO_CAPTURE_LIMITS } from "../src/client/media/quality";

// Exercise the private draft owner without adding a DOM runtime to unit tests.
// Real pointer/focus ordering is also checked in the existing Browser preview.
const source = ts.createSourceFile("QualityPresets.tsx", readFileSync(
  new URL("../src/client/components/living/QualityPresets.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "QualityNumberControl");
if (!owner) throw new Error("Missing numeric quality draft owner");
const executable = ts.transpileModule(`${owner.getText(source)}\nQualityNumberControl;`, {
  fileName: "QualityPresets.tsx",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function editor() {
  const input = { value: "128", validity: { valid: true },
    get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); } };
  const inside = {};
  const container = { contains: (node: unknown) => node === inside };
  const onChange = vi.fn();
  const render = runInNewContext(executable, {
    exports: {}, require: () => jsxRuntime, useRef: () => ({ current: input }), Number,
  });
  let choose!: (next: number) => void;
  let key!: (event: unknown) => void;
  const result = render({ value: 128, min: 6, max: 320, step: 1, unit: "kbps", name: "audioBitrate",
    label: "Audio bitrate", disabled: false, onChange, className: "lr-door-group",
    children: (number: { props: { children: { props: { onKeyDown: typeof key } }[] } }, select: typeof choose) => {
      choose = select;
      key = number.props.children[0]!.props.onKeyDown;
      return number;
    },
  });
  const blur = (relatedTarget: unknown = null) => result.props.onBlur({ currentTarget: container, relatedTarget });
  const press = (value: string) => key({ key: value, currentTarget: { blur: () => blur() },
    preventDefault() {}, stopPropagation() {} });
  return { input, inside, onChange, choose, blur, press };
}

describe("Numeric quality editing group", () => {
  it.each([
    { fps: 30, mbps: 5, maxFps: 240, maxMbps: 240, sliderFps: 60, sliderMbps: 12 },
    { fps: 15, mbps: 5, maxFps: 30, maxMbps: 10, sliderFps: 30, sliderMbps: 10 },
    { fps: 25, mbps: 5, maxFps: 29, maxMbps: 5.2, sliderFps: 25, sliderMbps: 5 },
  ])("keeps common sliders separate from accepted input limits ($maxFps fps, $maxMbps Mbps)", test => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(VideoRateControls, {
      value: { ...QUALITY_PROFILES["1080p30"], maxFramerate: test.fps, maxBitrate: test.mbps * 1_000_000 },
      limits: { ...VIDEO_CAPTURE_LIMITS, maxVideoFramerate: test.maxFps, maxVideoBitrate: test.maxMbps * 1_000_000 },
      disabled: false, onChange,
    }));
    const inputs = html.match(/<input\b[^>]*>/g)!;
    const numbers = inputs.filter(input => input.includes('type="number"'));
    const sliders = inputs.filter(input => input.includes('type="range"'));
    for (const [index, value, max, sliderMin, sliderMax, step] of [
      [0, test.fps, test.maxFps, 15, test.sliderFps, 5], [1, test.mbps, test.maxMbps, 2, test.sliderMbps, 0.5],
    ] as const) {
      expect(numbers[index]).toContain(`max="${max}"`);
      expect(numbers[index]).toContain(`value="${value}"`);
      expect(sliders[index]).toContain(`min="${sliderMin}"`);
      expect(sliders[index]).toContain(`max="${sliderMax}"`);
      expect(sliders[index]).toContain(`step="${step}"`);
      expect(sliders[index]).toContain(`value="${value}"`);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    { fps: 144, mbps: 80, maxFps: 240, maxMbps: 240, returnFps: 60, returnMbps: 12 },
    { fps: 5, mbps: 0.5, maxFps: 240, maxMbps: 240, returnFps: 15, returnMbps: 2 },
    { fps: 29, mbps: 5.1, maxFps: 240, maxMbps: 240, returnFps: 30, returnMbps: 5 },
    { fps: 29, mbps: 5.2, maxFps: 29, maxMbps: 5.2, returnFps: 25, returnMbps: 5 },
    { fps: 8, mbps: 0.5, maxFps: 10, maxMbps: 1, returnFps: null, returnMbps: null },
  ])("preserves custom values without an inaccurate slider ($fps fps, $mbps Mbps)", test => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(createElement(VideoRateControls, {
      value: { ...QUALITY_PROFILES["1080p30"], maxFramerate: test.fps, maxBitrate: test.mbps * 1_000_000 },
      limits: { ...VIDEO_CAPTURE_LIMITS, maxVideoFramerate: test.maxFps, maxVideoBitrate: test.maxMbps * 1_000_000 },
      disabled: false, onChange,
    }));
    const fields = html.split('<div class="lr-quality-rate">').slice(1);
    expect(fields).toHaveLength(2);
    for (const [index, value, nearest, unit] of [[0, test.fps, test.returnFps, "fps"], [1, test.mbps, test.returnMbps, "Mbps"]] as const) {
      expect(fields[index]).toContain(`value="${value}"`);
      expect(fields[index]).not.toContain('type="range"');
      expect(fields[index]).toContain('class="lr-quality-custom"');
      if (nearest === null) expect(fields[index]).not.toContain('<button');
      else expect(fields[index]).toMatch(new RegExp(`<button[^>]*aria-label="[^"]*${nearest} ${unit}`));
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves a draft through group navigation or cancelled selection, then commits on leaving", () => {
    const current = editor();
    current.input.value = "256";
    current.blur(current.inside);
    expect(current.onChange).not.toHaveBeenCalled();
    expect(current.input.value).toBe("256");
    current.blur();
    expect(current.onChange.mock.calls).toEqual([[256]]);
  });

  it.each([64, 128])("a choice of %s replaces the draft before a subsequent blur", next => {
    const current = editor();
    current.input.value = "256";
    current.blur(current.inside);
    current.choose(next);
    current.blur();
    expect(current.input.value).toBe("128");
    expect(current.onChange.mock.calls).toEqual(next === 128 ? [] : [[next]]);
  });

  it.each(["Enter", "Escape"])("handles %s through the same group boundary", key => {
    const current = editor();
    current.input.value = "256";
    current.press(key);
    expect(current.onChange.mock.calls).toEqual(key === "Enter" ? [[256]] : []);
    if (key === "Escape") expect(current.input.value).toBe("128");
  });

  it.each(["", "321"])("restores an empty or invalid draft (%s) without applying it", value => {
    const current = editor();
    current.input.value = value;
    current.input.validity.valid = value === "";
    current.blur();
    expect(current.input.value).toBe("128");
    expect(current.onChange).not.toHaveBeenCalled();
  });
});
