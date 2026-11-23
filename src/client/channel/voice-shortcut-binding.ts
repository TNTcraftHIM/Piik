import { z } from "zod";

export const voiceShortcutActions = ["microphone", "listening"] as const;
export type VoiceShortcutAction = typeof voiceShortcutActions[number];

export const voiceShortcutBindingSchema = z.object({
  key: z.string().regex(/^(?:[A-Z0-9]|F(?:[1-9]|10|11))$/),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
}).refine(({ ctrl, alt, meta }) => ctrl || alt || meta);

export type VoiceShortcutBinding = z.infer<typeof voiceShortcutBindingSchema>;
export type VoiceShortcuts = Record<VoiceShortcutAction, VoiceShortcutBinding | null>;

export function voiceShortcutDefaults(mac: boolean): VoiceShortcuts {
  const modifiers = { ctrl: !mac, alt: false, shift: true, meta: mac };
  return { microphone: { ...modifiers, key: "M" }, listening: { ...modifiers, key: "D" } };
}

export function voiceShortcutFromEvent(event: KeyboardEvent): VoiceShortcutBinding | null {
  // Use the logical letter so the binding follows the user's keyboard layout.
  const result = voiceShortcutBindingSchema.safeParse({
    key: event.key.toUpperCase(), ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
  });
  return result.success ? result.data : null;
}

export function matchesVoiceShortcut(binding: VoiceShortcutBinding | null, candidate: VoiceShortcutBinding): boolean {
  return binding?.key === candidate.key && binding.ctrl === candidate.ctrl && binding.alt === candidate.alt
    && binding.shift === candidate.shift && binding.meta === candidate.meta;
}

export function voiceShortcutLabel(binding: VoiceShortcutBinding, mac: boolean): string {
  return [
    binding.ctrl && "Ctrl", binding.alt && (mac ? "Option" : "Alt"), binding.shift && "Shift",
    binding.meta && (mac ? "⌘" : "Meta"), binding.key,
  ].filter(Boolean).join(" + ");
}

export function voiceShortcutAria(binding: VoiceShortcutBinding | null): string | undefined {
  if (!binding) return undefined;
  return [binding.ctrl && "Control", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "Meta", binding.key]
    .filter(Boolean).join("+");
}
