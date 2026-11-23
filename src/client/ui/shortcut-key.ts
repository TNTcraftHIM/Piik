/** IME and alternate-layout text entry own these events before any local shortcut. */
export function isComposingOrAltGraph(event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "getModifierState">): boolean {
  return event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph");
}
