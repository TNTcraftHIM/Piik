import { z } from "zod";

/** Actions a press toggles. The App can also register these outside the window. */
export const voiceToggleActions = ["microphone", "listening"] as const;
export type VoiceToggleAction = typeof voiceToggleActions[number];
/** Every bound voice action. Talk is held, and only a focused page sees it. */
export const voiceShortcutActions = [...voiceToggleActions, "talk"] as const;
export type VoiceShortcutAction = typeof voiceShortcutActions[number];

const functionKey = /^F(?:[1-9]|10|11)$/;

export const voiceShortcutBindingSchema = z.object({
  key: z.string().refine(key => /^[A-Z0-9]$/.test(key) || functionKey.test(key)),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
}).refine(({ ctrl, alt, meta }) => ctrl || alt || meta)
  .refine(({ key, ctrl, alt }) => !(ctrl && alt && functionKey.test(key)));

export type VoiceShortcutBinding = z.infer<typeof voiceShortcutBindingSchema>;
export type VoiceShortcuts = Record<VoiceShortcutAction, VoiceShortcutBinding | null>;
export type VoiceToggleShortcuts = Pick<VoiceShortcuts, VoiceToggleAction>;

export function voiceShortcutDefaults(mac: boolean): VoiceShortcuts {
  const modifiers = { ctrl: !mac, alt: false, shift: true, meta: mac };
  return { microphone: { ...modifiers, key: "M" }, listening: { ...modifiers, key: "D" }, talk: { ...modifiers, key: "V" } };
}

/** Stored choices over the defaults. A default never takes a chord already stored for another action. */
export function voiceShortcutsWithDefaults(mac: boolean, stored: Partial<VoiceShortcuts>): VoiceShortcuts {
  const defaults = voiceShortcutDefaults(mac);
  const taken = voiceShortcutActions.flatMap(action => stored[action] ?? []);
  return Object.fromEntries(voiceShortcutActions.map(action => [action, stored[action] !== undefined ? stored[action]
    : taken.some(binding => matchesVoiceShortcut(binding, defaults[action]!)) ? null : defaults[action]])) as VoiceShortcuts;
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

/**
 * A held chord ends when its key or one of its modifiers comes up. macOS sends
 * no key-up for a letter released while Command is down, so the modifier counts too.
 */
export function releasesVoiceShortcut(binding: VoiceShortcutBinding, event: Pick<KeyboardEvent, "key">): boolean {
  const modifiers: Record<string, boolean> = { Control: binding.ctrl, Alt: binding.alt, Shift: binding.shift, Meta: binding.meta };
  return modifiers[event.key] === true || event.key.toUpperCase() === binding.key;
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
