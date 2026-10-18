import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RemoteInputEvent } from "../../remote-control/input-session";
import type { RemoteInputPlatform } from "../../remote-control/protocol";
import { RemoteKeyboardPresses } from "../../remote-control/keyboard";
import { isCopyKey, useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { panelWindowAPI, SurfaceDocument, usePanelWindow } from "../../ui/panel-window";
import { Btn, Chip } from "./primitives";
import { Tooltip } from "./Tooltip";
import "./floating-panel.css";

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
const NAVIGATION: Key[] = [["Esc", "Escape"], ["Tab", "Tab"], ["␣", "Space"], ["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"]];
type Page = keyof typeof ROWS | "text";

// The local input owns IME composition. Committed text and physical keys use
// their existing input operations, without clipboard access or another channel.
export function RemoteKeyboard({ input, close, mouseControl, touch, platform, onSurfaceChange }: {
  input: (event: RemoteInputEvent) => void; close: () => void;
  mouseControl?: ReactNode; touch: boolean;
  platform: RemoteInputPlatform;
  onSurfaceChange?: (owner: Document) => void;
}) {
  const { t, vis } = useCopy();
  const mac = platform === "darwin";
  const command = mac ? "MetaLeft" : "ControlLeft";
  const modifiersKeys: Key[] = [["Ctrl", "ControlLeft"], [mac ? "Opt" : "Alt", "AltLeft"], ["Shift", "ShiftLeft"],
    [mac ? "Cmd" : platform === "windows" ? "Win" : "Super", "MetaLeft"]];
  const shortcuts = [
    [`${mac ? "Cmd" : "Ctrl"}+A`, "ControlA", [command, "KeyA"]],
    [`${mac ? "Cmd" : "Ctrl"}+C`, "ControlC", [command, "KeyC"]],
    [`${mac ? "Cmd" : "Ctrl"}+V`, "ControlV", [command, "KeyV"]],
    ...(platform === "windows" ? [["Win", "MetaLeft", ["MetaLeft"]], ["Win+Space", "InputLanguage", ["MetaLeft", "Space"]]] as const
      : mac ? [["Ctrl+Space", "InputLanguage", ["ControlLeft", "Space"]], ["Cmd+`", "SwitchWindow", ["MetaLeft", "Backquote"]]] as const : []),
    [`${mac ? "Cmd" : "Alt"}+Tab`, mac ? "SwitchApp" : "SwitchWindow", [mac ? "MetaLeft" : "AltLeft", "Tab"]],
  ] as const;
  const [page, setPage] = useState<Page>("letters");
  const [text, setText] = useState("");
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [keepModifiers, setKeepModifiers] = useState(false);
  const composing = useRef(false);
  const editor = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelWindow = usePanelWindow(true, onSurfaceChange);
  const owner = panelWindow.surfaceDocument ?? document;
  const presses = useMemo(() => new RemoteKeyboardPresses(input), [input]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const reset = () => { presses.reset(); setModifiers([]); };
    const hidden = () => { if (owner.hidden) reset(); };
    reset();
    owner.defaultView?.addEventListener("blur", reset);
    owner.addEventListener("visibilitychange", hidden);
    return () => {
      owner.defaultView?.removeEventListener("blur", reset);
      owner.removeEventListener("visibilitychange", hidden);
      presses.reset();
    };
  }, [presses, owner]);
  useEffect(() => {
    if (owner !== document) owner.title = `${t("remote.keyboard")} · Piik`;
  }, [owner, t]);
  const rows = page === "text" ? [] : mac && page === "functions"
    ? [...ROWS.functions.slice(0, 2), ROWS.functions.slice(2).flat().filter(([, code]) => !["Insert", "PrintScreen", "ScrollLock", "NumLock"].includes(code))]
    : ROWS[page];

  const key = ([label, code, shifted]: Key) => {
    const name = `remote.key.${code}`;
    const caption = shifted && modifiers.includes("ShiftLeft") ? shifted : label;
    return <button key={code} type="button" className="lr-chip"
      data-key={code} aria-label={isCopyKey(name) ? t(name) : caption}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        presses.down(event.pointerId, [...modifiers, code]); if (!keepModifiers) setModifiers([]);
      }}
      onPointerUp={event => presses.up(event.pointerId)}
      onPointerCancel={() => { presses.reset(); setModifiers([]); }}
      onLostPointerCapture={event => presses.up(event.pointerId)}
      onClick={event => {
        if (event.detail === 0) { presses.tap([...modifiers, code]); if (!keepModifiers) setModifiers([]); }
      }}>
      {caption}
    </button>;
  };

  const keyboard = <SurfaceDocument.Provider value={owner}><section ref={panel} tabIndex={-1} className="lr-remote-keyboard" aria-label={t("remote.keyboard")}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (panelWindow.detached) owner.defaultView?.close(); else close();
      }
    }} onKeyUp={event => event.stopPropagation()}>
    <div className="lr-remote-panel-header">
      <strong><Glyph name="keyboard" size={18} />{vis ? null : t("remote.keyboard")}</strong>
      {!panelWindow.detached && <>
        {panelWindowAPI(window) && <Tooltip kind="hint-window-detach" place="below" text={vis ? undefined : t("floating.detach")}>
          <button type="button" className="lr-popover-close" aria-label={t("floating.detach")} disabled={panelWindow.opening}
            onClick={() => { presses.reset(); setModifiers([]); void panelWindow.open(); }}><Glyph name="pip" size={18} /></button>
        </Tooltip>}
        <button type="button" className="lr-popover-close" aria-label={t("common.close")} onClick={close}><Glyph name="x" size={17} /></button>
      </>}
    </div>
    {panelWindow.failed && <p className="lr-floating-error" role="status">{t("floating.detachFailed")}</p>}
    <div className="lr-remote-key-pages" role="group" aria-label={t("remote.keyPages")}>
      {(["letters", "symbols", "functions", "text"] as const).map(id => <Chip key={id}
        selected={page === id} title={t(`remote.keys.${id}`)} onClick={() => {
          presses.reset(); setModifiers([]); setPage(id);
        }}>
        {id === "letters" ? "ABC" : id === "symbols" ? "123" : id === "functions" ? "Fn" : vis ? <Glyph name="pencil" size={16} /> : t("remote.keys.text")}
      </Chip>)}
    </div>
    {page !== "text" ? <>
      <div className={`lr-remote-key-layout is-${page}`}>
        {rows.map((row, index) => <div className="lr-remote-key-row" key={index}>{row.map(key)}</div>)}
      </div>
      <div className="lr-remote-key-row lr-remote-modifiers">
        {modifiersKeys.map(([label, code], index) => <Chip key={code} title={mac && code === "AltLeft" ? "Option" : label} selected={modifiers.includes(code)}
          onClick={() => {
            const selected = modifiers.includes(code);
            if (keepModifiers) {
              if (selected) presses.up(-2 - index);
              else presses.down(-2 - index, [code], false);
            }
            setModifiers(current => selected ? current.filter(item => item !== code) : [...current, code]);
          }}>{label}</Chip>)}
        {key(["⌫", "Backspace"])}{key(["↵", "Enter"])}
      </div>
      <div className="lr-remote-key-row lr-remote-navigation">{NAVIGATION.map(key)}</div>
      <label className="lr-remote-keep-modifiers"><input type="checkbox" checked={keepModifiers}
        aria-label={t("remote.keepModifiers")}
        onChange={event => { presses.reset(); setModifiers([]); setKeepModifiers(event.target.checked); }} />
        {vis ? <span aria-hidden="true"><kbd>Ctrl / ⇧</kbd><Glyph name="lock" size={14} /></span> : t("remote.keepModifiers")}</label>
      {!vis && <p>{t("remote.modifierHelp", { modifiers: modifiersKeys.map(([label, code]) => mac && code === "AltLeft" ? "Option" : label).join(" / ") })}</p>}
    </> : <>
      <div className="lr-remote-keys">{[...NAVIGATION.filter(([, code]) => code !== "Space"), ["⌫", "Backspace"], ["↵", "Enter"]].map(item => key(item as Key))}</div>
      <div className="lr-remote-keys lr-remote-shortcuts">
        {shortcuts.map(([label, name, codes]) => <button key={name} type="button" className="lr-chip"
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
    {!panelWindow.detached && mouseControl}
    {!vis && touch && <p>{t("remote.touchHelp")}</p>}
  </section></SurfaceDocument.Provider>;
  return <span ref={panelWindow.slot} style={{ display: "contents" }}>
    {panelWindow.container && createPortal(keyboard, panelWindow.container)}
  </span>;
}
