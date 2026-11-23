import { useLayoutEffect, useState, type KeyboardEvent } from "react";

export function protectRoomComposition(event: KeyboardEvent<HTMLFormElement>) {
  if ((event.key === "Enter" || event.key === "Escape") &&
      (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
}

/** Resume editing when disabling the submitted form moved focus to the document. */
export function useRoomFormFocus(blocked: boolean) {
  const [field, setField] = useState<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (blocked || !field) return;
    setField(null);
    const owner = field.ownerDocument;
    if (owner.activeElement === owner.body && field.getClientRects().length) {
      field.focus();
    }
  }, [blocked, field]);
  return (form: HTMLFormElement) => {
    const field = form.querySelector<HTMLInputElement>("input.c3-input:focus")
      ?? form.querySelector<HTMLInputElement>("input.c3-input");
    return () => setField(field);
  };
}
