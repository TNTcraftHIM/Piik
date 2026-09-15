import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { locales, type Lang } from "../../locales";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

// The registry owns languages; the native popover owns visibility and dismissal.
// This control adds Piik's presentation, viewport placement and menu navigation.
export function LanguageControl() {
  const { lang, vis, t, setLang, setVis } = useCopy();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const extraLanguages = (Object.keys(locales) as Lang[]).filter((key): boolean => key !== "zh" && key !== "en");
  const selectedExtra = !vis && extraLanguages.includes(lang) ? locales[lang] : null;

  useEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const place = () => {
      if (!menu.matches(":popover-open")) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        menu.hidePopover();
        return;
      }
      const below = Math.max(0, window.innerHeight - rect.bottom - 16);
      const above = Math.max(0, rect.top - 16);
      const openAbove = below < Math.min(menu.scrollHeight, 360) && above > below;
      menu.style.maxHeight = `${Math.min(360, openAbove ? above : below)}px`;
      menu.classList.toggle("is-above", openAbove);
      const top = openAbove ? rect.top - menu.offsetHeight - 8 : Math.max(8, rect.bottom + 8);
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${top}px`;
    };
    const opened = () => {
      if (!menu.matches(":popover-open")) return;
      place();
      const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      (selected ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
    };
    menu.addEventListener("toggle", opened);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      menu.removeEventListener("toggle", opened);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
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
      {(["zh", "en"] as const).map((key) => (
        <button
          key={key} type="button" lang={locales[key].tag}
          className={!vis && lang === key ? "is-selected" : ""}
          aria-label={locales[key].name} aria-pressed={!vis && lang === key}
          onClick={() => setLang(key)}
        >{locales[key].short}</button>
      ))}
      <button
        type="button" className={vis ? "is-selected" : ""}
        aria-label={t("mode.vis")} aria-pressed={vis} onClick={() => setVis(true)}
      >✦</button>
      {extraLanguages.length > 0 && (
        <button
          ref={triggerRef} type="button" popoverTarget={menuId} aria-haspopup="menu"
          aria-label={selectedExtra ? `${t("mode.more")} · ${selectedExtra.name}` : t("mode.more")}
          className={`lr-lang-more${selectedExtra ? " is-selected" : ""}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
        >
          <span aria-hidden="true" lang={selectedExtra?.tag}>
            {selectedExtra ? selectedExtra.short : <Glyph name="globe" size={14} />}
            <Glyph name="chevron" size={10} />
          </span>
        </button>
      )}
    </span>
    {extraLanguages.length > 0 && (
      <span
        ref={menuRef} id={menuId} popover="auto" role="menu"
        aria-label={t("mode.more")} className="lr-language-menu" onKeyDown={navigate}
        onBlur={(event) => {
          // Returning to the trigger lets its native action close the menu.
          if (event.relatedTarget !== triggerRef.current &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)) {
            event.currentTarget.hidePopover();
          }
        }}
      >
        {extraLanguages.map((key) => {
          const locale = locales[key];
          const selected = !vis && lang === key;
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
    )}
  </>;
}
