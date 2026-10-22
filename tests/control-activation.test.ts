import { Children, isValidElement, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Btn, Chip, SwitchItem } from "../src/client/components/living/primitives";

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(), useId: () => "test-switch",
}));

vi.mock("../src/client/ui/copy", () => ({
  useCopy: () => ({ vis: false, t: (key: string) => key }),
}));

function button(node: ReactNode): ComponentProps<"button"> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === "button") return node.props;
  return Children.toArray(node.props.children).map(button).find(Boolean);
}

const controls = {
  button: (activate: () => void) => Btn({ icon: "play", title: "playback.play", hint: "hint-quality", onClick: activate }),
  chip: (activate: () => void) => Chip({ selected: false, title: "720p", hint: "hint-quality", onClick: activate, children: "720p" }),
  switch: (activate: () => void) => SwitchItem({ checked: false, label: "Setting", hint: "hint-quality", onChange: activate }),
};

describe("Hinted control activation", () => {
  it.each(Object.entries(controls))("%s applies the chosen action before focus-leave commits a draft", (_name, render) => {
    const changes: string[] = [];
    let pendingDraft = true;
    const control = button(render(() => { pendingDraft = false; changes.push("chosen action"); }))!;
    const blur = vi.fn(() => { if (pendingDraft) changes.push("unconfirmed draft"); });

    control.onClick!({ detail: 1, currentTarget: { blur } } as unknown as MouseEvent<HTMLButtonElement>);

    expect(changes).toEqual(["chosen action"]);
    expect(blur).toHaveBeenCalledOnce();
  });

  it.each(Object.entries(controls))("%s keeps keyboard focus when activated", (_name, render) => {
    const activate = vi.fn();
    const blur = vi.fn();
    button(render(activate))!.onClick!({ detail: 0, currentTarget: { blur } } as unknown as MouseEvent<HTMLButtonElement>);
    expect(activate).toHaveBeenCalledOnce();
    expect(blur).not.toHaveBeenCalled();
  });
});
