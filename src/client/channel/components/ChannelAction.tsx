import type { ComponentProps } from "react";
import { Btn } from "../../components/living/primitives";
import type { GlyphName } from "../../ui/icons";

/** Literal prototype copy, shared production geometry and guidance. */
export function ChannelAction({ icon, label, onClick, disabled, busy, pressed, danger, primary, hint, textTooltip, iconOnly = false, quiet = false, type = "button" }: {
  icon: GlyphName; label: string; onClick?: () => void; disabled?: boolean;
  busy?: boolean; pressed?: boolean; danger?: boolean; primary?: boolean;
  iconOnly?: boolean; quiet?: boolean;
  hint?: ComponentProps<typeof Btn>["hint"]; textTooltip?: boolean; type?: "button" | "submit";
}) {
  return <Btn icon={icon} title={{ text: label }} cap={iconOnly ? undefined : { text: label }}
    size="compact" quiet={quiet} tone={danger ? "danger" : primary ? "primary" : undefined}
    type={type} onClick={onClick} disabled={disabled || busy} busy={busy} pressed={pressed} hint={hint} textTooltip={textTooltip} />;
}
