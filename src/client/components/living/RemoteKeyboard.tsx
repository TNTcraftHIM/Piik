import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RemoteInputEvent } from "../../remote-control/input-session";
import { REMOTE_TEXT_BYTES, type RemoteInputPlatform } from "../../remote-control/protocol";
import { RemoteKeyboardPresses } from "../../remote-control/keyboard";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import { readRoomPreferences, saveRoomPreferences, REMOTE_KEYBOARD_PAGES, type RoomPreferences } from "../../lib/room-preferences";
import { isCopyKey, useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { panelWindowAPI, SurfaceDocument, usePanelWindow } from "../../ui/panel-window";
import { navigateTabs } from "../../ui/tab-navigation";
import { Btn, Chip } from "./primitives";
import { Tooltip } from "./Tooltip";
import { RemoteShortcutSelect } from "./RemoteShortcutSelect";
import { RemoteMouse } from "./RemoteMouse";
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
  functions: [functions(1), functions(7), [["Caps", "CapsLock"], ["PrtSc", "PrintScreen"], ["ScrLk", "ScrollLock"], ["NumLk", "NumLock"]]],
} satisfies Record<string, Key[][]>;
const NAVIGATION: Key[] = [["Esc", "Escape"], ["Tab", "Tab"]];
const EDITING: Key[] = [["Ins", "Insert"], ["Home", "Home"], ["PgUp", "PageUp"], ["Del", "Delete"], ["End", "End"], ["PgDn", "PageDown"]];
const ARROWS: Key[] = [["↑", "ArrowUp"], ["←", "ArrowLeft"], ["↓", "ArrowDown"], ["→", "ArrowRight"]];
type Page = RoomPreferences["keyboardPage"] | "mouse";
const PAGES = REMOTE_KEYBOARD_PAGES;

// The local input owns IME composition. Committed text and physical keys use
// their existing input operations, without clipboard access or another channel.
export function RemoteKeyboard({ input, close, mouseControl, pointer, touch, platform, onSurfaceChange, releaseKey, onReleaseKeyChange, allowText = true }: {
  input: (event: RemoteInputEvent) => void; close: () => void;
  mouseControl?: ReactNode; touch: boolean;
  pointer?: RemoteTouchpad;
  platform: RemoteInputPlatform;
  onSurfaceChange?: (owner: Document) => void;
  releaseKey: number; onReleaseKeyChange: (key: number) => void;
  allowText?: boolean;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const mac = platform === "darwin";
  const metaKeyTitle = t(mac ? "remote.key.Command" : platform === "windows" ? "remote.key.Windows" : "remote.key.Super");
  const command = mac ? "MetaLeft" : "ControlLeft";
  const modifiersKeys: Key[] = [["Ctrl", "ControlLeft"],
    [mac ? "Cmd" : platform === "windows" ? "Win" : "Super", "MetaLeft"], [mac ? "Opt" : "Alt", "AltLeft"], ["Shift", "ShiftLeft"]];
  const shortcuts = [
    [`${mac ? "Cmd" : "Ctrl"}+A`, "ControlA", [command, "KeyA"]],
    [`${mac ? "Cmd" : "Ctrl"}+C`, "ControlC", [command, "KeyC"]],
    [`${mac ? "Cmd" : "Ctrl"}+V`, "ControlV", [command, "KeyV"]],
    ...(platform === "windows" ? [["Win", "MetaLeft", ["MetaLeft"]], ["Win+Space", "InputLanguage", ["MetaLeft", "Space"]]] as const
      : mac ? [["Ctrl+Space", "InputLanguage", ["ControlLeft", "Space"]], ["Cmd+`", "SwitchWindow", ["MetaLeft", "Backquote"]]] as const : []),
    [`${mac ? "Cmd" : "Alt"}+Tab`, mac ? "SwitchApp" : "SwitchWindow", [mac ? "MetaLeft" : "AltLeft", "Tab"]],
  ] as const;
  const [page, setPage] = useState<Page>(() => pointer && touch ? "mouse" : readRoomPreferences().keyboardPage);
  const pages: readonly Page[] = pointer ? ["mouse", ...PAGES] : PAGES;
  const title = pointer ? "remote.inputTools" : "remote.keyboard";
  const [text, setText] = useState("");
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [combineKeys, setCombineKeys] = useState(() => readRoomPreferences().combineKeys);
  const composing = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const textTooLong = new TextEncoder().encode(text).length > REMOTE_TEXT_BYTES;
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
    if (owner !== document) owner.title = `${t(title)} · Piik`;
  }, [owner, t, title]);
  const rows = page === "text" || page === "mouse" ? [] : mac && page === "functions"
    ? ROWS.functions.slice(0, 2)
    : ROWS[page];

  const releaseModifiers = () => {
    modifiersKeys.forEach((_, index) => presses.up(-2 - index));
    setModifiers([]);
  };

  const key = ([label, code, shifted]: Key) => {
    const name = `remote.key.${code}`;
    const caption = shifted && modifiers.includes("ShiftLeft") ? shifted : label;
    return <button key={code} type="button" className="lr-chip"
      data-key={code} aria-label={code === "MetaLeft" ? metaKeyTitle : isCopyKey(name) ? t(name) : caption}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        presses.down(event.pointerId, [...modifiers, code], !modifiersKeys.some(([, value]) => value === code));
      }}
      onPointerUp={event => { presses.up(event.pointerId); releaseModifiers(); }}
      onPointerCancel={() => { presses.reset(); setModifiers([]); }}
      onLostPointerCapture={event => { presses.up(event.pointerId); releaseModifiers(); }}
      onClick={event => {
        if (event.detail === 0) { presses.tap([...modifiers, code]); releaseModifiers(); }
      }}>
      {caption}
    </button>;
  };

  const modifier = ([label, code]: Key, index: number) => <span className="lr-remote-modifier-key" key={code}>
    {combineKeys ? <Chip title={code === "MetaLeft" ? metaKeyTitle : code === "ShiftLeft" ? t("remote.key.ShiftLeft") : mac && code === "AltLeft" ? "Option" : label} selected={modifiers.includes(code)} onClick={() => {
      const selected = modifiers.includes(code);
      if (selected) presses.up(-2 - index);
      else presses.down(-2 - index, [code], false);
      setModifiers(current => selected ? current.filter(item => item !== code) : [...current, code]);
    }}>{code === "ShiftLeft" ? "⇧" : label}</Chip> : key([code === "ShiftLeft" ? "⇧" : label, code])}
  </span>;

  const navigation = <div className="lr-remote-navigation">
    <div className={`lr-remote-key-row lr-remote-navigation-actions${page === "functions" ? " is-editing" : page === "text" ? " is-text" : ""}`}>
      {(page === "functions" ? EDITING.filter(([, code]) => !mac || code !== "Insert")
        : [...NAVIGATION, ...(page === "text" ? [["⌫", "Backspace"], ["↵", "Enter"]] : [])]).map(item => key(item as Key))}
    </div>
    <div className="lr-remote-key-row lr-remote-arrows">{ARROWS.map(key)}</div>
  </div>;

  const keyboard = <SurfaceDocument.Provider value={owner}><section ref={panel} tabIndex={-1} className="lr-remote-keyboard" aria-label={t(title)}
    onContextMenu={event => { if ((event.target as Element).closest("button")) event.preventDefault(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (panelWindow.detached) owner.defaultView?.close(); else close();
      }
    }} onKeyUp={event => event.stopPropagation()}>
    <div className="lr-remote-panel-header">
      <strong><Glyph name="keyboard" size={18} />{vis ? null : t(title)}</strong>
      {!panelWindow.detached && <>
        {panelWindowAPI(window) && <Tooltip kind="hint-window-detach" place="below" text={vis ? undefined : t("floating.detach")}>
          <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("floating.detach")} disabled={panelWindow.opening}
            onClick={() => { presses.reset(); setModifiers([]); void panelWindow.open(); }}><Glyph name="pip" size={18} /></button>
        </Tooltip>}
        <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("common.close")} onClick={close}><Glyph name="x" size={17} /></button>
      </>}
    </div>
    {panelWindow.failed && <p className="lr-floating-error" role="status">{t("floating.detachFailed")}</p>}
    <div className="lr-toggle lr-remote-key-pages" role="tablist" aria-label={t("remote.inputPages")}
      style={{ "--lr-segments": pages.length, "--lr-selected-index": pages.indexOf(page) } as CSSProperties}
      onKeyDown={navigateTabs}>
      {pages.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`}
        className={page === value ? "is-selected" : undefined} aria-selected={page === value}
        aria-controls={`${id}-panel`} tabIndex={page === value ? 0 : -1}
        aria-label={t(value === "mouse" ? "remote.mouse" : `remote.keys.${value}`)} onClick={() => {
          presses.reset(); pointer?.reset(); setModifiers([]); setPage(value);
          if (value !== "mouse") saveRoomPreferences({ keyboardPage: value });
        }}>
        {value === "mouse" ? <Glyph name="mouse" size={17} /> : value === "letters" ? "ABC" : value === "symbols" ? "123" : value === "functions" ? "Fn" : vis ? <Glyph name="pencil" size={16} /> : t("remote.keys.text")}
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${page}`}>
    {page === "mouse" && pointer ? <RemoteMouse pointer={pointer} /> : page !== "text" ? <>
      <div className={`lr-remote-key-layout is-${page}`}>
        {rows.map((row, index) => <div className="lr-remote-key-row" key={index}>
          {index === 2 && page !== "functions" && modifier(modifiersKeys[3], 3)}{row.map(key)}{index === 2 && page !== "functions" && key(["⌫", "Backspace"])}
        </div>)}
      </div>
      {page === "functions" && <div className="lr-remote-key-row">{NAVIGATION.map(key)}{mac && key(["Caps", "CapsLock"])}{modifier(modifiersKeys[3], 3)}{key(["⌫", "Backspace"])}</div>}
      <div className="lr-remote-key-row lr-remote-bottom-row">
        {modifiersKeys.slice(0, 3).map(modifier)}{key(["␣", "Space"])}{key(["↵", "Enter"])}
      </div>
      {navigation}
      <Tooltip kind="hint-key-combination" className="lr-remote-combine-hint" text={vis ? undefined : t("remote.combinationHelp")}>
      <label className="lr-remote-combine-keys"><input type="checkbox" checked={combineKeys}
        aria-label={t("remote.combinationMode")}
        onChange={event => {
          presses.reset(); setModifiers([]); setCombineKeys(event.target.checked);
          saveRoomPreferences({ combineKeys: event.target.checked });
        }} />
        {vis ? <span aria-hidden="true"><kbd>⇧</kbd><span>+</span><kbd>…</kbd></span> : t("remote.combinationMode")}</label>
      </Tooltip>
      {!vis && <p>{t(combineKeys ? "remote.combinationHelp" : "remote.keyboardHelp")}</p>}
    </> : <>
      <form className="lr-remote-text-entry" onSubmit={event => {
        event.preventDefault();
        if (!allowText || !text || textTooLong || composing.current) return;
        input({ type: "text", text }); setText(""); editor.current?.focus();
      }}>
        <div className="lr-input lr-remote-text-field">
          <textarea ref={editor} rows={4} value={text}
            aria-label={t("remote.text")} placeholder={vis ? "" : t("remote.text")} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            aria-invalid={textTooLong || undefined}
            aria-describedby={vis ? undefined : `${id}-text-help`}
            enterKeyHint="enter" onChange={event => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
          />
          <div className="lr-remote-text-actions">
            <Btn icon="send" cap="remote.typeText" title="remote.sendText" size="compact" hint="hint-remote-keyboard" hintText={allowText ? undefined : "remote.textShared"} tone="primary" type="submit" disabled={!allowText || !text || textTooLong} />
          </div>
        </div>
        {textTooLong ? <p id={`${id}-text-help`} role="alert">{t("remote.textTooLong")}</p> : !vis && <p id={`${id}-text-help`}>{t(allowText ? "remote.textHelp" : "remote.textShared")}</p>}
      </form>
      {navigation}
      <div className="lr-remote-keys lr-remote-shortcuts">
        {shortcuts.map(([label, name, codes]) => <button key={name} type="button" className="lr-chip"
          aria-label={t(`remote.key.${name}`)} onClick={() => presses.tap(codes)}>{label}</button>)}
      </div>
    </>}
    </div>
    {page !== "mouse" && <RemoteShortcutSelect value={releaseKey} onChange={onReleaseKeyChange} mac={navigator.platform.startsWith("Mac")} />}
    {!panelWindow.detached && (!pointer || page === "mouse") && mouseControl}
    {!vis && touch && page !== "mouse" && <p>{t("remote.touchHelp")}</p>}
  </section></SurfaceDocument.Provider>;
  return <span ref={panelWindow.slot} style={{ display: "contents" }}>
    {panelWindow.container && createPortal(keyboard, panelWindow.container)}
  </span>;
}
