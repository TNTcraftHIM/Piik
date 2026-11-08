import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnchoredPopover } from "../src/client/components/living/use-anchored-popover";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void)[] }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) hooks.effects.push(cleanup);
  },
}));
vi.mock("../src/client/ui/panel-window", () => ({ useSurfaceDocument: () => undefined }));

afterEach(() => {
  for (const cleanup of hooks.effects.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

function surface() {
  const frame = new Map<number, FrameRequestCallback>();
  let sequence = 0, visible = true, open = true;
  const field = {};
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
  const view = Object.assign(new EventTarget(), {
    visualViewport: viewport, innerWidth: 390, innerHeight: 844,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frame.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => { frame.delete(id); },
  });
  const owner = { defaultView: view, activeElement: null as unknown };
  const anchor = {
    getBoundingClientRect: () => ({ left: 40, right: 350, top: 600, bottom: 650, width: 310, height: 50 }),
    getClientRects: () => visible ? [{}] : [],
    closest: () => null,
  };
  const style: Record<string, string> = {};
  const hidePopover = vi.fn(() => { open = false; });
  const menu = Object.assign(new EventTarget(), {
    ownerDocument: owner, style, classList: { toggle: vi.fn() }, scrollHeight: 700, offsetWidth: 300,
    contains: (element: unknown) => element === field,
    matches: () => open, hidePopover,
  });
  Object.defineProperty(menu, "offsetHeight", { get: () => Math.min(700, parseFloat(style.maxHeight) || 700) });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  useAnchoredPopover({ current: anchor as unknown as HTMLElement }, { current: menu as unknown as HTMLElement });
  const resize = (height: number) => {
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
    for (const [id, callback] of [...frame]) { frame.delete(id); callback(0); }
  };
  return { owner, field, menu, style, hidePopover, resize, removeAnchor: () => { visible = false; } };
}

describe("Anchored popover input ownership", () => {
  it("keeps an active editor open and inside the keyboard viewport", () => {
    const current = surface();
    current.owner.activeElement = current.field;
    current.resize(320);
    expect(current.hidePopover).not.toHaveBeenCalled();
    expect(current.owner.activeElement).toBe(current.field);
    expect(parseFloat(current.style.top!)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(current.style.top!) + parseFloat(current.style.maxHeight!)).toBeLessThanOrEqual(312);

    current.removeAnchor();
    current.resize(320);
    expect(current.hidePopover).toHaveBeenCalledOnce();
  });

  it("still dismisses an inactive menu whose anchor leaves view", () => {
    const current = surface();
    current.resize(320);
    expect(current.hidePopover).toHaveBeenCalledOnce();
  });
});
