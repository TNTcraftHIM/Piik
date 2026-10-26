import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { PLAYER_CONTROLS_IDLE_MS } from "../src/client/ui/control-timing";
import { REMOTE_TOUCH_HOLD_MS } from "../src/client/remote-control/touchpad";

// Exercise the actual component callbacks without adding a DOM runtime. Native
// click generation and pointer capture ordering still require Browser acceptance.
const source = ts.createSourceFile("RemoteMouse.tsx", readFileSync(
  new URL("../src/client/components/living/RemoteMouse.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "RemoteMouse");
if (!component) throw new Error("Missing remote mouse owner");
const executable = ts.transpileModule(`${component.getText(source)}\nRemoteMouse;`, {
  fileName: "RemoteMouse.tsx",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

type Element = { props: Record<string, any> };
type Slot = { value?: any; deps?: readonly unknown[]; cleanup?: () => void };
function mouse(left = 100, touchMode: "direct" | "trackpad" = "direct") {
  const slots: Slot[] = [], effects: (() => void)[] = [];
  let index = 0, tree: Element;
  const listeners = new Map<string, () => void>();
  const owner = { hidden: false, activeElement: null,
    addEventListener: (type: string, callback: () => void) => listeners.set(type, callback),
    removeEventListener: (type: string) => listeners.delete(type),
    defaultView: { addEventListener: vi.fn(), removeEventListener: vi.fn() } };
  const layer = { clientWidth: 400, clientHeight: 300 };
  const positionRef = { current: layer };
  const widget = { offsetLeft: left, offsetTop: 100, offsetWidth: 44, offsetHeight: 56,
    getBoundingClientRect: () => ({ left, top: 100 }),
    style: { setProperty: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn(), contains: () => false };
  const mini = { matches: () => false, focus: vi.fn() };
  const pointer = { button: vi.fn(), moveBy: vi.fn(), wheel: vi.fn(), setVirtualMouse: vi.fn(), refresh: vi.fn() };
  const slot = () => slots[index++] ?? (slots[index - 1] = {});
  const changed = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
    !previous || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]));
  const effect = (callback: () => (() => void) | void, deps: readonly unknown[]) => {
    const current = slot();
    if (!changed(current.deps, deps)) return;
    current.deps = deps;
    effects.push(() => { current.cleanup?.(); current.cleanup = callback() || undefined; });
  };
  const renderComponent = runInNewContext(executable, {
    exports: {}, require: () => jsxRuntime, setTimeout, clearTimeout, PLAYER_CONTROLS_IDLE_MS, REMOTE_TOUCH_HOLD_MS,
    useCopy: () => ({ t: (key: string) => key }), useSurfaceDocument: () => owner, useId: () => "mouse",
    useState: (initial: unknown) => {
      const current = slot();
      if (!("value" in current)) current.value = initial;
      return [current.value, (value: unknown) => { current.value = typeof value === "function" ? value(current.value) : value; }];
    },
    useRef: (initial: unknown) => { const current = slot(); return current.value ??= { current: initial }; },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const current = slot();
      if (changed(current.deps, deps)) { current.deps = deps; current.value = callback; }
      return current.value;
    },
    useEffect: effect, useLayoutEffect: effect, Glyph: () => null,
  });
  const nodes = (element: Element): Element[] => [element, ...[element.props.children].flat(Infinity)
    .filter((child): child is Element => Boolean(child && typeof child === "object" && "props" in child)).flatMap(nodes)];
  const find = (name: string) => nodes(tree).find(node => node.props.className?.split(" ").includes(name))!;
  const render = () => {
    index = 0;
    tree = renderComponent({ pointer, positionRef, touchMode, pointAt: () => ({ x: .25, y: .3 }) });
    find("lr-remote-mouse-widget").props.ref.current = widget;
    find("lr-remote-mouse-mini").props.ref.current = mini;
    effects.splice(0).forEach(callback => callback());
  };
  render();
  const event = (x = 0, y = 0) => ({ pointerId: 1, button: 0, clientX: x, clientY: y,
    currentTarget: { setPointerCapture: vi.fn() }, preventDefault() {}, stopPropagation() {} });
  return { pointer, widget, owner, listeners, find, render, event,
    setTouchMode: (next: typeof touchMode) => { touchMode = next; render(); },
    expanded: () => !find("lr-remote-mouse-shell").props.inert,
    docked: () => find("lr-remote-mouse-widget").props["data-docked"],
    dispose: () => slots.forEach(current => current.cleanup?.()) };
}

it("retains the compact trackpad option while the full mouse is minimized", () => {
  const view = mouse(100, "trackpad");
  try {
    expect(view.find("lr-remote-touch-cursor")).toBeDefined();
    expect(view.expanded()).toBe(false);
    expect(view.pointer.setVirtualMouse).toHaveBeenLastCalledWith(true);
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 0 }); view.render();
    expect(view.expanded()).toBe(true);
    view.find("lr-remote-mouse-minimize").props.onClick(); view.render();
    expect(view.expanded()).toBe(false);
    expect(view.find("lr-remote-touch-cursor")).toBeDefined();
    expect(view.pointer.setVirtualMouse).toHaveBeenLastCalledWith(true);
    view.setTouchMode("direct");
    expect(view.find("lr-remote-touch-cursor")).toBeUndefined();
    expect(view.pointer.setVirtualMouse).toHaveBeenLastCalledWith(false);
  } finally { view.dispose(); }
});

it("moves only the mini widget and suppresses its following pointer click after capture ends", () => {
  const view = mouse();
  try {
    expect(view.find("lr-remote-touch-cursor")).toBeUndefined();
    view.find("lr-remote-mouse-mini").props.onPointerDown(view.event());
    view.find("lr-remote-mouse").props.onPointerMove(view.event(20, 12));
    view.find("lr-remote-mouse").props.onPointerUp(view.event(20, 12));
    view.find("lr-remote-mouse").props.onLostPointerCapture(view.event(20, 12));
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 1 }); view.render();
    expect(view.widget.style.setProperty).toHaveBeenCalled();
    expect(view.pointer.moveBy).not.toHaveBeenCalled();
    expect(view.pointer.button).not.toHaveBeenCalled();
    expect(view.expanded()).toBe(false);
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 0 }); view.render();
    expect(view.expanded()).toBe(true);
    expect(view.find("lr-remote-touch-cursor")).toBeDefined();
    expect(view.pointer.setVirtualMouse).toHaveBeenLastCalledWith(true, { x: .25, y: .3 });
  } finally { view.dispose(); }
});

it("opens with a mini tap and minimizes explicitly while releasing held remote input", () => {
  const view = mouse();
  try {
    view.find("lr-remote-mouse-mini").props.onPointerDown(view.event());
    view.find("lr-remote-mouse").props.onPointerUp(view.event());
    view.find("lr-remote-mouse").props.onLostPointerCapture(view.event());
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 1 }); view.render();
    expect(view.expanded()).toBe(true);
    view.find("lr-remote-mouse-left").props.onPointerDown(view.event());
    view.find("lr-remote-mouse-body").props.onPointerDown({ ...view.event(), pointerId: 2 });
    view.find("lr-remote-mouse").props.onPointerMove({ ...view.event(20, 12), pointerId: 2 });
    expect(view.pointer.moveBy).toHaveBeenCalledWith(20, 12);
    view.find("lr-remote-mouse").props.onPointerUp({ ...view.event(20, 12), pointerId: 2 });
    expect(view.pointer.button.mock.calls).toEqual([[0, true]]);
    view.find("lr-remote-mouse").props.onPointerMove(view.event(10, 8));
    expect(view.pointer.moveBy).toHaveBeenLastCalledWith(10, 8);
    expect(view.widget.style.setProperty).not.toHaveBeenCalled();
    view.find("lr-remote-mouse-minimize").props.onClick(); view.render();
    view.find("lr-remote-mouse").props.onLostPointerCapture(view.event());
    expect(view.expanded()).toBe(false);
    expect(view.find("lr-remote-touch-cursor")).toBeUndefined();
    expect(view.pointer.setVirtualMouse).toHaveBeenLastCalledWith(false);
    expect(view.pointer.button.mock.calls).toEqual([[0, true], [0, false]]);
  } finally { view.dispose(); }
});

it.each([["left", 0], ["right", 2]] as const)("drags while holding %s and releases once on cancellation", (name, button) => {
  const view = mouse();
  try {
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 0 }); view.render();
    const surface = () => view.find("lr-remote-mouse").props;
    view.find(`lr-remote-mouse-${name}`).props.onPointerDown(view.event(30, 20));
    surface().onPointerMove(view.event(32, 21));
    expect(view.pointer.moveBy).not.toHaveBeenCalled();
    surface().onPointerMove(view.event(40, 28));
    surface().onPointerMove(view.event(44, 30));
    expect(view.pointer.button.mock.calls).toEqual([[button, true]]);
    expect(view.pointer.moveBy.mock.calls).toEqual([[10, 8], [4, 2]]);
    expect(view.widget.style.setProperty).not.toHaveBeenCalled();
    surface().onPointerCancel(view.event(44, 30));
    surface().onLostPointerCapture(view.event(44, 30));
    surface().onPointerMove(view.event(60, 60));
    view.dispose();
    expect(view.pointer.button.mock.calls).toEqual([[button, true], [button, false]]);
    expect(view.pointer.moveBy).toHaveBeenCalledTimes(2);
  } finally { view.dispose(); }
});

it("retains a shared button until its final contact ends and releases remaining buttons on disposal", () => {
  const view = mouse();
  try {
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 0 }); view.render();
    view.find("lr-remote-mouse-left").props.onPointerDown(view.event());
    view.find("lr-remote-mouse-left").props.onPointerDown({ ...view.event(), pointerId: 2 });
    view.find("lr-remote-mouse-right").props.onPointerDown({ ...view.event(), pointerId: 3 });
    view.find("lr-remote-mouse").props.onPointerUp(view.event());
    expect(view.pointer.button.mock.calls).toEqual([[0, true], [2, true]]);
    view.find("lr-remote-mouse").props.onPointerUp({ ...view.event(), pointerId: 2 });
    view.dispose();
    expect(view.pointer.button.mock.calls).toEqual([[0, true], [2, true], [0, false], [2, false]]);
  } finally { view.dispose(); }
});

it("tucks only an idle edge mini and cancels the timer on interaction, expansion, hiding and disposal", () => {
  vi.useFakeTimers();
  const view = mouse(0);
  try {
    vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS - 1); view.render(); expect(view.docked()).toBeUndefined();
    view.find("lr-remote-mouse-mini").props.onPointerDown(view.event());
    expect(vi.getTimerCount()).toBe(0);
    view.find("lr-remote-mouse").props.onPointerUp(view.event());
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 1 }); view.render();
    expect(view.expanded()).toBe(true); expect(vi.getTimerCount()).toBe(0);
    view.find("lr-remote-mouse-minimize").props.onClick(); view.render();
    vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS); view.render(); expect(view.docked()).toBe("left");
    view.find("lr-remote-mouse-mini").props.onPointerDown(view.event());
    view.find("lr-remote-mouse").props.onPointerMove(view.event(10, 0));
    view.find("lr-remote-mouse").props.onPointerUp(view.event(10, 0)); view.render();
    expect(vi.getTimerCount()).toBe(1);
    view.owner.hidden = true; view.listeners.get("visibilitychange")?.();
    expect(vi.getTimerCount()).toBe(0);
    view.dispose();
    const pending = mouse(0);
    expect(vi.getTimerCount()).toBe(1); pending.dispose(); expect(vi.getTimerCount()).toBe(0);
  } finally { view.dispose(); vi.useRealTimers(); }
});

it("distinguishes wheel taps, scrolling and held middle dragging and retires its timer and button", () => {
  vi.useFakeTimers();
  const view = mouse();
  try {
    view.find("lr-remote-mouse-mini").props.onClick({ detail: 0 }); view.render();
    const start = () => view.find("lr-remote-mouse-wheel").props.onPointerDown(view.event());
    const end = () => {
      view.find("lr-remote-mouse").props.onPointerUp(view.event());
      view.find("lr-remote-mouse").props.onLostPointerCapture(view.event());
      view.find("lr-remote-mouse-wheel").props.onClick({ detail: 1 });
    };
    start(); end();
    expect(view.pointer.button.mock.calls).toEqual([[1, true], [1, false]]);
    expect(vi.getTimerCount()).toBe(0);
    view.pointer.button.mockClear();

    start();
    view.find("lr-remote-mouse").props.onPointerMove(view.event(0, 3));
    expect(view.pointer.wheel).not.toHaveBeenCalled();
    view.find("lr-remote-mouse").props.onPointerMove(view.event(0, 14));
    vi.advanceTimersByTime(REMOTE_TOUCH_HOLD_MS); end();
    expect(view.pointer.wheel.mock.calls).toEqual([[14]]);
    expect(view.pointer.button).not.toHaveBeenCalled();
    expect(view.pointer.moveBy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); view.pointer.wheel.mockClear();

    start(); vi.advanceTimersByTime(REMOTE_TOUCH_HOLD_MS - 1);
    expect(view.pointer.button).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); view.render();
    expect(view.find("lr-remote-mouse-wheel").props["aria-pressed"]).toBe(true);
    view.find("lr-remote-mouse").props.onPointerMove(view.event(8, 12)); end();
    expect(view.pointer.button.mock.calls).toEqual([[1, true], [1, false]]);
    expect(view.pointer.moveBy.mock.calls).toEqual([[8, 12]]);
    expect(view.pointer.wheel).not.toHaveBeenCalled(); view.pointer.button.mockClear();

    start(); view.find("lr-remote-mouse").props.onPointerCancel(view.event());
    vi.advanceTimersByTime(REMOTE_TOUCH_HOLD_MS);
    expect(view.pointer.button).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    start(); vi.advanceTimersByTime(REMOTE_TOUCH_HOLD_MS);
    view.owner.hidden = true; view.listeners.get("visibilitychange")?.();
    expect(view.pointer.button.mock.calls).toEqual([[1, true], [1, false]]);
    expect(vi.getTimerCount()).toBe(0);
    view.pointer.button.mockClear(); view.owner.hidden = false;
    start(); expect(vi.getTimerCount()).toBe(1);
    view.dispose(); vi.advanceTimersByTime(REMOTE_TOUCH_HOLD_MS);
    expect(view.pointer.button).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { view.dispose(); vi.useRealTimers(); }
});
