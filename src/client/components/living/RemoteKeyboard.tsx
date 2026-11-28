import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { RemoteInputEvent } from "../../remote-control/input-session";
import { remoteTextFits, type RemoteInputState } from "../../remote-control/protocol";
import { RemoteKeyboardPresses } from "../../remote-control/keyboard";
import { readRoomPreferences, saveRoomPreferences, REMOTE_KEYBOARD_PAGES, type RoomPreferences } from "../../lib/room-preferences";
import { onDocumentInactive } from "../../ui/document-active";
import { isCopyKey, useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { panelWindowAPI, SurfaceDocument, usePanelWindow } from "../../ui/panel-window";
import { navigateTabs } from "../../ui/tab-navigation";
import { Btn, Chip, FieldCap, SegmentedChoice, SwitchItem } from "./primitives";
import { Tooltip } from "./Tooltip";
import { RemoteShortcutSelect } from "./RemoteShortcutSelect";
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
type Page = RoomPreferences["keyboardPage"];
const PAGES = REMOTE_KEYBOARD_PAGES;

// The local input owns IME composition. Committed text and physical keys use
// their existing input operations, without clipboard access or another channel.
export function RemoteKeyboard({ input, close, mouseControl, inputSurface, touch, platform, onSurfaceChange, releaseKey, onReleaseKeyChange, allowText = true, virtualSticks, stickMode, stickVisibility }: {
  virtualSticks?: { checked: boolean; onChange(checked: boolean): void };
  stickVisibility?: { checked: boolean; onChange(checked: boolean): void };
  stickMode?: { value: "keyboard" | "gamepad"; onChange(value: "keyboard" | "gamepad"): void };
  input: (event: RemoteInputEvent) => void; close: () => void;
  mouseControl?: ReactNode; touch: boolean;
  inputSurface?: RefObject<HTMLElement | null>;
  platform: RemoteInputState["platform"];
  onSurfaceChange?: (owner: Document) => void;
  releaseKey: number; onReleaseKeyChange: (key: number) => void;
  allowText?: boolean;
}) {
  const { t } = useCopy();
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
  const [page, setPage] = useState<Page>(() => readRoomPreferences("keyboardPage"));
  const pages = PAGES;
  const [text, setText] = useState("");
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [combineKeys, setCombineKeys] = useState(() => readRoomPreferences("combineKeys"));
  const composing = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const textTooLong = !remoteTextFits(text);
  const panel = useRef<HTMLElement>(null);
  const panelWindow = usePanelWindow(true, onSurfaceChange);
  const owner = panelWindow.surfaceDocument ?? document;
  const presses = useMemo(() => new RemoteKeyboardPresses(input), [input]);
  const reset = useCallback(() => { presses.reset(); setModifiers([]); }, [presses]);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const picture = inputSurface?.current;
    const stopListening = onDocumentInactive(owner, reset);
    reset();
    if (picture?.ownerDocument === owner) picture.addEventListener("focusout", reset);
    return () => {
      stopListening();
      picture?.removeEventListener("focusout", reset);
      presses.reset();
    };
  }, [presses, owner, inputSurface, reset]);
  useEffect(() => {
    if (owner !== document) owner.title = `${t("remote.keyboard")} · Piik`;
  }, [owner, t]);
  const rows = page === "text" ? [] : mac && page === "functions"
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
      onPointerCancel={reset}
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

  const keyboard = <SurfaceDocument.Provider value={owner}><section ref={panel} tabIndex={-1} className="lr-remote-keyboard" aria-label={t("remote.keyboard")}
    onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget) || inputSurface?.current?.contains(event.relatedTarget)) return;
      reset();
    }}
    onContextMenu={event => { if ((event.target as Element).closest("button")) event.preventDefault(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (panelWindow.detached) owner.defaultView?.close(); else close();
      }
    }} onKeyUp={event => event.stopPropagation()}>
    <div className="lr-remote-panel-header">
      <strong><Glyph name="keyboard" size={18} />{t("remote.keyboard")}</strong>
      {!panelWindow.detached && <>
        {panelWindowAPI(window) && <Tooltip kind="hint-window-detach" place="below" text={t("floating.detach")}>
          <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("floating.detach")} disabled={panelWindow.opening}
            onClick={() => { reset(); void panelWindow.open(); }}><Glyph name="pip" size={18} /></button>
        </Tooltip>}
        <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("common.close")} onClick={close}><Glyph name="x" size={17} /></button>
      </>}
    </div>
    {panelWindow.failed && <p className="lr-floating-error" role="status">{t("floating.detachFailed")}</p>}
    <div className="lr-toggle lr-remote-key-pages" role="tablist" aria-label={t("remote.keyPages")}
      style={{ "--lr-segments": pages.length, "--lr-selected-index": pages.indexOf(page) } as CSSProperties}
      onKeyDown={navigateTabs}>
      {pages.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`}
        className={page === value ? "is-selected" : undefined} aria-selected={page === value}
        aria-controls={`${id}-panel`} tabIndex={page === value ? 0 : -1}
        aria-label={t(`remote.keys.${value}`)} onClick={() => {
          reset(); setPage(value); saveRoomPreferences({ keyboardPage: value });
        }}>
        {value === "letters" ? "ABC" : value === "symbols" ? "123" : value === "functions" ? "Fn" : t("remote.keys.text")}
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${page}`}>
    {page !== "text" ? <>
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
      <SwitchItem label={t("remote.combinationMode")} checked={combineKeys}
        note={t("remote.combinationHelp")} hint="hint-key-combination" onChange={checked => {
          reset(); setCombineKeys(checked);
          saveRoomPreferences({ combineKeys: checked });
        }} />
      <p>{t(combineKeys ? "remote.combinationHelp" : "remote.keyboardHelp")}</p>
    </> : <>
      <form className="lr-remote-text-entry" onSubmit={event => {
        event.preventDefault();
        if (!allowText || !text || textTooLong || composing.current) return;
        input({ type: "text", text }); setText(""); editor.current?.focus();
      }}>
        <div className="lr-input lr-remote-text-field">
          <textarea ref={editor} rows={4} value={text}
            aria-label={t("remote.text")} placeholder={t("remote.text")} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            aria-invalid={textTooLong || undefined}
            aria-describedby={`${id}-text-help`}
            enterKeyHint="enter" onChange={event => setText(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
          />
          <div className="lr-remote-text-actions">
            <Btn icon="send" cap="remote.typeText" title="remote.sendText" size="compact" hint="hint-remote-keyboard" hintText={allowText ? undefined : "remote.textShared"} tone="primary" type="submit" disabled={!allowText || !text || textTooLong} />
          </div>
        </div>
        {textTooLong ? <p id={`${id}-text-help`} role="alert">{t("remote.textTooLong")}</p> : <p id={`${id}-text-help`}>{t(allowText ? "remote.textHelp" : "remote.textShared")}</p>}
      </form>
      {navigation}
      <div className="lr-remote-keys lr-remote-shortcuts">
        {shortcuts.map(([label, name, codes]) => <button key={name} type="button" className="lr-chip"
          aria-label={t(`remote.key.${name}`)} onClick={() => presses.tap(codes)}>{label}</button>)}
      </div>
    </>}
    </div>
    <details className="lr-settings-disclosure lr-remote-keyboard-settings" onFocusCapture={reset}>
      <summary aria-label={t("remote.localSettings")}>
        <span><Glyph name="sliders" size={17} />{t("remote.localSettings")}</span>
        <Glyph name="chevron" size={16} className="lr-sharing-chevron" />
      </summary>
      <div className="lr-remote-settings-fields">
        <RemoteShortcutSelect value={releaseKey} onChange={onReleaseKeyChange} mac={navigator.platform.startsWith("Mac")} />
        {virtualSticks && <SwitchItem label={t("remote.virtualSticks")}
          checked={virtualSticks.checked} onChange={virtualSticks.onChange} />}
        {virtualSticks?.checked && stickMode && <div className="lr-remote-stick-mode">
          <FieldCap k="remote.stickMode" />
          <SegmentedChoice label={t("remote.stickMode")} value={stickMode.value} onChange={stickMode.onChange} options={[
            { value: "keyboard", label: t("remote.keyboardMouseMode"), icon: "keyboard" },
            { value: "gamepad", label: t("remote.gamepadMode"), icon: "gamepad" },
          ]} />
        </div>}
        {virtualSticks?.checked && stickVisibility && <SwitchItem label={t("remote.stickShowOnTouch")}
          checked={stickVisibility.checked} onChange={stickVisibility.onChange} />}
        {!panelWindow.detached && mouseControl}
      </div>
    </details>
    {touch && <p>{t("remote.touchHelp")}</p>}
  </section></SurfaceDocument.Provider>;
  return <span ref={panelWindow.slot} style={{ display: "contents" }}>
    {panelWindow.container && createPortal(keyboard, panelWindow.container)}
  </span>;
}
