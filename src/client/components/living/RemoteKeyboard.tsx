import { useRef, useState, type ReactNode } from "react";
import type { RemoteInputEvent } from "../../remote-control/input-session";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";

const KEYS = [
  ["Esc", "Escape"], ["Tab", "Tab"], ["←", "ArrowLeft"], ["↑", "ArrowUp"],
  ["↓", "ArrowDown"], ["→", "ArrowRight"], ["⌫", "Backspace"], ["↵", "Enter"],
] as const;

// The local input owns IME composition. Only explicitly submitted, committed
// text leaves the Browser; shortcuts use the existing physical-key path.
export function RemoteKeyboard({ input, close, mouseControl }: {
  input: (event: RemoteInputEvent) => void; close: () => void;
  mouseControl?: ReactNode;
}) {
  const { t } = useCopy();
  const [text, setText] = useState("");
  const composing = useRef(false);
  const editor = useRef<HTMLInputElement>(null);
  const press = (codes: string[]) => {
    input({ type: "reset" });
    codes.forEach(code => input({ type: "key", code, down: true }));
    [...codes].reverse().forEach(code => input({ type: "key", code, down: false }));
  };
  return <section className="lr-remote-keyboard" aria-label={t("remote.keyboard")}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); }
    }} onKeyUp={event => event.stopPropagation()}>
    <div className="lr-remote-keys">
      {KEYS.map(([label, code]) => <button key={code} type="button" className="lr-chip"
        aria-label={t(`remote.key.${code}`)} onClick={() => press([code])}>{label}</button>)}
      {(["A", "C", "V"] as const).map(key => <button key={key} type="button" className="lr-chip"
        aria-label={t(`remote.key.Control${key}`)} onClick={() => press(["ControlLeft", `Key${key}`])}>Ctrl+{key}</button>)}
    </div>
    <form className="lr-remote-policy-actions" onSubmit={event => {
      event.preventDefault();
      if (!text || composing.current) return;
      input({ type: "text", text }); setText(""); editor.current?.focus();
    }}>
      <label className="lr-input"><input ref={editor} autoFocus maxLength={128} value={text}
        aria-label={t("remote.text")} placeholder={t("remote.text")} autoComplete="off"
        enterKeyHint="send" onChange={event => setText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
      <Btn icon="send" title="remote.sendText" type="submit" disabled={!text} />
      <Btn icon="x" title="common.close" onClick={close} />
    </form>
    {mouseControl}
    <p>{t("remote.touchHelp")}</p>
  </section>;
}
