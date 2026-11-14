import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { locales, primaryLanguages, extraLanguages } from "../../locales";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useAnchoredPopover } from "./use-anchored-popover";

// The registry owns languages; the native popover owns visibility and dismissal.
// This control adds Piik's presentation, viewport placement and menu navigation.
export function LanguageControl() {
  const { lang, pinnedLanguage, t, setLang } = useCopy();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const pinned = pinnedLanguage ? locales[pinnedLanguage] : null;
  const selected = lang === pinnedLanguage;
  const opensMenu = selected || !pinned;
  useAnchoredPopover(triggerRef, menuRef, { maxHeight: 360 });

  useEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const opened = () => {
      if (!menu.matches(":popover-open")) return;
      const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      (selected ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
    };
    menu.addEventListener("toggle", opened);
    return () => {
      menu.removeEventListener("toggle", opened);
    };
  }, [extraLanguages.length]);

  function navigate(event: KeyboardEvent<HTMLSpanElement>) {
    const menu = event.currentTarget;
    if (event.key === "Tab") {
      // Resume the page's normal Tab order from the menu's trigger.
      triggerRef.current?.focus();
      menu.hidePopover();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = items[(current + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key.length === 1 && event.key !== " ") {
      next = [...items.slice(current + 1), ...items.slice(0, current + 1)].find((item) =>
        item.getAttribute("aria-label")?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return <>
    <span className="lr-lang" role="group" aria-label={t("mode.language")}>
      {primaryLanguages.map((key) => (
        <button
          key={key} type="button" lang={locales[key].tag}
          className={lang === key ? "is-selected" : ""}
          aria-label={locales[key].name} aria-pressed={lang === key}
          onClick={() => setLang(key)}
        >{locales[key].short}</button>
      ))}
      <span className="lr-lang-extra">
        <button type="button" lang={pinned?.tag} className={selected ? "is-selected" : undefined}
          aria-label={pinned?.name ?? t("mode.more")} aria-pressed={pinned ? selected : undefined}
          aria-haspopup={opensMenu ? "menu" : undefined} popoverTarget={opensMenu ? menuId : undefined}
          onClick={event => {
            if (pinnedLanguage && !selected) { event.preventDefault(); setLang(pinnedLanguage); }
          }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); triggerRef.current?.click(); }
          }}>
          {pinned ? pinned.short : <Glyph name="globe" size={14} />}
        </button>
        <button ref={triggerRef} type="button" className="lr-lang-more" popoverTarget={menuId}
          aria-haspopup="menu" aria-label={t("mode.more")}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.click(); }
          }}>
          <Glyph name="chevron" size={10} />
        </button>
      </span>
    </span>
    <span
      ref={menuRef} id={menuId} popover="auto" role="menu"
      aria-label={t("mode.more")} className="lr-language-menu" onKeyDown={navigate}
      onBlur={(event) => {
        // Either part of the language shortcut can toggle the native menu.
        if (!triggerRef.current?.parentElement?.contains(event.relatedTarget as Node | null) &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          event.currentTarget.hidePopover();
        }
      }}
    >
      {extraLanguages.map((key) => {
        const locale = locales[key];
        const selected = lang === key;
        return <button
          key={key} type="button" role="menuitemradio" tabIndex={-1}
          lang={locale.tag} aria-label={locale.name} aria-checked={selected}
          onClick={() => {
            setLang(key);
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
          }}
        >
          <span className="lr-language-mark" aria-hidden="true">{locale.short}</span>
          <span>{locale.name}</span>
          <Glyph name="check" size={16} className={selected ? "" : "is-unselected"} />
        </button>;
      })}
    </span>
  </>;
}
