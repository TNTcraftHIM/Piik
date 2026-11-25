import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { locales, type Lang } from "../../locales";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useAnchoredPopover } from "./use-anchored-popover";

// The registry owns languages; the native popover owns visibility and dismissal.
// This control adds Piik's presentation, viewport placement and menu navigation.
export function LanguageControl() {
  const { lang, vis, pinnedChoice, t, setLang, setVis } = useCopy();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const extraLanguages = (Object.keys(locales) as Lang[]).filter((key): boolean => key !== "zh" && key !== "en");
  const pinned = pinnedChoice && pinnedChoice !== "vis" ? locales[pinnedChoice] : null;
  const selected = pinnedChoice === "vis" ? vis : !vis && lang === pinnedChoice;
  const opensMenu = selected || !pinnedChoice;
  const pinnedLabel = pinnedChoice === "vis" ? t("mode.vis") : pinned?.name;
  useAnchoredPopover(triggerRef, menuRef, { maxHeight: 360 });

  useEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const toggled = () => {
      if (!menu.matches(":popover-open")) {
        if (menu.contains(menu.ownerDocument.activeElement)) openerRef.current?.focus();
        return;
      }
      const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      (selected ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
    };
    menu.addEventListener("toggle", toggled);
    return () => {
      menu.removeEventListener("toggle", toggled);
    };
  }, [extraLanguages.length]);

  function dismiss() {
    // Nested native popovers do not restore focus to their own invoker.
    openerRef.current?.focus();
    menuRef.current?.hidePopover();
  }

  function navigate(event: KeyboardEvent<HTMLSpanElement>) {
    const menu = event.currentTarget;
    if (event.key === "Tab" || event.key === "Escape") {
      if (event.key === "Escape") event.preventDefault();
      dismiss();
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
      <span className="lr-lang-extra">
        <button type="button" popoverTarget={opensMenu ? menuId : undefined} aria-haspopup={opensMenu ? "menu" : undefined}
          aria-label={pinnedLabel ?? t("mode.more")} lang={pinned?.tag}
          aria-pressed={pinnedChoice ? selected : undefined}
          className={`lr-lang-marker${selected ? " is-selected" : ""}`}
          onClick={event => {
            if (opensMenu) openerRef.current = event.currentTarget;
            else if (pinnedChoice) {
              event.preventDefault();
              if (pinnedChoice === "vis") setVis(true);
              else setLang(pinnedChoice);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              triggerRef.current?.click();
              openerRef.current = event.currentTarget;
            }
          }}
        >
          {pinnedChoice === "vis" ? "✦" : pinned ? pinned.short : <Glyph name="globe" size={14} />}
        </button>
        <button ref={triggerRef} type="button" className="lr-lang-more" popoverTarget={menuId}
          aria-haspopup="menu" aria-label={t("mode.more")}
          onClick={event => { openerRef.current = event.currentTarget; }}
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
        const selected = !vis && lang === key;
        return <button
          key={key} type="button" role="menuitemradio" tabIndex={-1}
          lang={locale.tag} aria-label={locale.name} aria-checked={selected}
          onClick={() => {
            dismiss();
            setLang(key);
          }}
        >
          <span className="lr-language-mark" aria-hidden="true">{locale.short}</span>
          <span>{locale.name}</span>
          <Glyph name="check" size={16} className={selected ? "" : "is-unselected"} />
        </button>;
      })}
      <button type="button" role="menuitemradio" tabIndex={-1}
        aria-label={t("mode.vis")} aria-checked={vis}
        onClick={() => {
          dismiss();
          setVis(true);
        }}>
        <span className="lr-language-mark" aria-hidden="true">✦</span>
        <span>{t("mode.vis")}</span>
        <Glyph name="check" size={16} className={vis ? "" : "is-unselected"} />
      </button>
    </span>
  </>;
}
