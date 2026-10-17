import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RemoteInputEvent } from "../../remote-control/input-session";
import { RemoteKeyboardPresses } from "../../remote-control/keyboard";
import { isCopyKey, useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, Chip } from "./primitives";

type Key = readonly [label: string, code: string, shifted?: string];
const letters = (row: string): Key[] => [...row].map(letter => [letter, `Key${letter}`]);
const functions = (start: number): Key[] => Array.from({ length: 6 }, (_, i) => [`F${start + i}`, `F${start + i}`]);
const ROWS = {
  letters: [letters("QWERTYUIOP"), letters("ASDFGHJKL"), letters("ZXCVBNM")],
  symbols: [
    [..."1234567890"].map((digit, i): Key => [digit, `Digit${digit}`, "!@#$%^&*()"[i]]),
    [["`", "Backquote", "~"], ["-", "Minus", "_"], ["=", "Equal", "+"], ["[", "BracketLeft", "{"], ["]", "BracketRight", "}"], ["\\", "Backslash", "|"]],
    [[";", "Semicolon", ":"], ["'", "Quote", '"'], [",", "Comma", "<"], [".", "Period", ">"], ["/", "Slash", "?"]],
  ],
  functions: [functions(1), functions(7), [["Ins", "Insert"], ["Del", "Delete"], ["Home", "Home"], ["End", "End"], ["PgUp", "PageUp"], ["PgDn", "PageDown"]],
    [["Caps", "CapsLock"], ["PrtSc", "PrintScreen"], ["ScrLk", "ScrollLock"], ["NumLk", "NumLock"]]],
} satisfies Record<string, Key[][]>;
const MODIFIERS: Key[] = [["Ctrl", "ControlLeft"], ["Alt", "AltLeft"], ["Shift", "ShiftLeft"], ["Win", "MetaLeft"]];
const NAVIGATION: Key[] = [["Esc", "Escape"], ["Tab", "Tab"], ["␣", "Space"], ["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"]];
const SHORTCUTS = [
  ["Ctrl+A", "ControlA", ["ControlLeft", "KeyA"]], ["Ctrl+C", "ControlC", ["ControlLeft", "KeyC"]],
  ["Ctrl+V", "ControlV", ["ControlLeft", "KeyV"]], ["Win", "MetaLeft", ["MetaLeft"]],
  ["Win+Space", "InputLanguage", ["MetaLeft", "Space"]], ["Alt+Tab", "SwitchWindow", ["AltLeft", "Tab"]],
] as const;
type Page = keyof typeof ROWS | "text";

// The local input owns IME composition. Committed text and physical keys use
// their existing input operations, without clipboard access or another channel.
export function RemoteKeyboard({ input, close, mouseControl, touch }: {
  input: (event: RemoteInputEvent) => void; close: () => void;
  mouseControl?: ReactNode; touch: boolean;
}) {
  const { t, vis } = useCopy();
  const [page, setPage] = useState<Page>("letters");
  const [text, setText] = useState("");
  const [modifiers, setModifiers] = useState<string[]>([]);
  const composing = useRef(false);
  const editor = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const presses = useMemo(() => new RemoteKeyboardPresses(input), [input]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const reset = () => { presses.reset(); setModifiers([]); };
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("blur", reset); presses.reset(); };
  }, [presses]);

  const key = ([label, code, shifted]: Key) => {
    const name = `remote.key.${code}`;
    const caption = shifted && modifiers.includes("ShiftLeft") ? shifted : label;
    return <button key={code} type="button" className="lr-chip"
      data-key={code} aria-label={isCopyKey(name) ? t(name) : caption}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        presses.down(event.pointerId, [...modifiers, code]); setModifiers([]);
      }}
      onPointerUp={event => presses.up(event.pointerId)}
      onPointerCancel={event => presses.up(event.pointerId)}
      onLostPointerCapture={event => presses.up(event.pointerId)}
      onClick={event => {
        if (event.detail === 0) { presses.tap([...modifiers, code]); setModifiers([]); }
      }}>
      {caption}
    </button>;
  };

  return <section ref={panel} tabIndex={-1} className="lr-remote-keyboard" aria-label={t("remote.keyboard")}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); }
    }} onKeyUp={event => event.stopPropagation()}>
    <div className="lr-remote-panel-header">
      <strong><Glyph name="keyboard" size={18} />{vis ? null : t("remote.keyboard")}</strong>
      <button type="button" className="lr-popover-close" aria-label={t("common.close")} onClick={close}><Glyph name="x" size={17} /></button>
    </div>
    <div className="lr-remote-key-pages" role="group" aria-label={t("remote.keyPages")}>
      {(["letters", "symbols", "functions", "text"] as const).map(id => <Chip key={id}
        selected={page === id} title={t(`remote.keys.${id}`)} onClick={() => {
          presses.reset(); setPage(id); if (id === "text") setModifiers([]);
        }}>
        {id === "letters" ? "ABC" : id === "symbols" ? "123" : id === "functions" ? "Fn" : vis ? <Glyph name="pencil" size={16} /> : t("remote.keys.text")}
      </Chip>)}
    </div>
    {page !== "text" ? <>
      <div className={`lr-remote-key-layout is-${page}`}>
        {ROWS[page].map((row, index) => <div className="lr-remote-key-row" key={index}>{row.map(key)}</div>)}
      </div>
      <div className="lr-remote-key-row lr-remote-modifiers">
        {MODIFIERS.map(([label, code]) => <Chip key={code} title={label} selected={modifiers.includes(code)}
          onClick={() => setModifiers(current => current.includes(code) ? current.filter(item => item !== code) : [...current, code])}>{label}</Chip>)}
        {key(["⌫", "Backspace"])}{key(["↵", "Enter"])}
      </div>
      <div className="lr-remote-key-row lr-remote-navigation">{NAVIGATION.map(key)}</div>
      {!vis && <p>{t("remote.modifierHelp")}</p>}
    </> : <>
      <div className="lr-remote-keys">{[...NAVIGATION.filter(([, code]) => code !== "Space"), ["⌫", "Backspace"], ["↵", "Enter"]].map(item => key(item as Key))}</div>
      <div className="lr-remote-keys lr-remote-shortcuts">
        {SHORTCUTS.map(([label, name, codes]) => <button key={name} type="button" className="lr-chip"
          aria-label={t(`remote.key.${name}`)} onClick={() => presses.tap(codes)}>{label}</button>)}
      </div>
      <form className="lr-remote-policy-actions" onSubmit={event => {
        event.preventDefault();
        if (!text || composing.current) return;
        input({ type: "text", text }); setText(""); editor.current?.focus();
      }}>
        <label className="lr-input"><Glyph name="pencil" size={18} /><input ref={editor} autoFocus maxLength={128} value={text}
          aria-label={t("remote.text")} placeholder={vis ? "" : t("remote.text")} autoComplete="off"
          enterKeyHint="send" onChange={event => setText(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
        <Btn icon="send" title="remote.sendText" type="submit" disabled={!text} />
      </form>
    </>}
    {mouseControl}
    {!vis && touch && <p>{t("remote.touchHelp")}</p>}
  </section>;
}
