import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "../../components/living/BrandMark";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { siteEntryOrigin } from "../../lib/site-address";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { DOMAIN_BOOKMARKS_KEY, domainBookmarkURL, readDomainBookmarks, saveDomainBookmarks, type DomainBookmark } from "../bookmarks";
import "./channel-bookmarks.css";

export function ChannelBookmarks({ currentName, currentIcon, onCurrent, className = "" }: {
  currentName: string; currentIcon?: ReactNode; onCurrent(): void; className?: string;
}) {
  const { lang, vis } = useCopy();
  const copy = (cn: string, en: string) => lang === "zh" ? cn : en;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const [bookmarks, setBookmarks] = useState(readDomainBookmarks);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<"address" | "duplicate" | "storage" | null>(null);
  const currentOrigin = location.origin;
  const title = copy("域收藏", "Saved domains");
  const errorText = error === "address" ? copy("请输入有效的网址。", "Enter a valid web address.")
    : error === "duplicate" ? copy("这个地址已在收藏中。", "This address is already saved.")
    : copy("无法保存收藏，请检查浏览器存储设置。", "Could not save. Check your browser's storage settings.");

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (!event.key || event.key === DOMAIN_BOOKMARKS_KEY) setBookmarks(readDomainBookmarks()); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function edit(bookmark?: DomainBookmark) {
    setEditing(bookmark?.origin ?? null);
    setAddress(bookmark?.origin ?? "");
    setName(bookmark?.name ?? "");
    setError(null);
    addressInput.current?.focus();
  }
  function save(next: DomainBookmark[]) {
    if (!saveDomainBookmarks(next)) { setError("storage"); return; }
    setBookmarks(next);
    edit();
  }
  function submit() {
    const origin = siteEntryOrigin(address);
    if (!origin) { setError("address"); addressInput.current?.focus(); return; }
    if (bookmarks.some(item => item.origin === origin && item.origin !== editing)) {
      setError("duplicate"); addressInput.current?.focus(); return;
    }
    const item = { origin, name: name.trim() || new URL(origin).host };
    save(editing ? bookmarks.map(previous => previous.origin === editing ? item : previous) : [...bookmarks, item]);
  }
  return <>
    <nav className={`c3-domain-rail ${className}`} aria-label={copy("域列表", "Domains")}>
      <span className="c3-domain-brand" aria-label="Piik"><BrandMark size={30} /></span>
      <span className="c3-domain-rule" />
      <Tooltip kind="hint-join-go" text={vis ? undefined : currentName}>
        <button type="button" className="lr-btn c3-domain-icon is-on" aria-current="page" aria-label={currentName} onClick={onCurrent}>
          {currentIcon ?? <Glyph name="couch" size={26} />}
        </button>
      </Tooltip>
      <div className="c3-domain-saved">
        {bookmarks.filter(item => item.origin !== currentOrigin).map(item => <Tooltip key={item.origin} kind="hint-invite-link"
          text={vis ? undefined : copy(`打开 ${item.name}（新标签页）`, `Open ${item.name} in a new tab`)}>
          <a className="lr-btn c3-domain-icon" href={domainBookmarkURL(item.origin)} target="_blank" rel="noopener noreferrer"
            aria-label={copy(`打开 ${item.name}（新标签页）`, `Open ${item.name} in a new tab`)}>
            <span className="c3-domain-initial" aria-hidden="true">{Array.from(item.name.trim())[0]?.toLocaleUpperCase() || <Glyph name="globe" size={24} />}</span>
          </a>
        </Tooltip>)}
      </div>
      <Btn icon="plus" size="compact" quiet title={{ text: title }} hint="hint-invite-link" expanded={open} controls={id}
        onClick={() => { edit(); setOpen(true); dialog.current?.showModal(); addressInput.current?.focus(); }} />
      <span className="c3-domain-version">3.0</span>
    </nav>
    <dialog ref={dialog} id={id} className="c3-bookmarks-dialog" aria-labelledby={`${id}-title`} onClose={() => setOpen(false)}>
      <header><div><h2 id={`${id}-title`}>{title}</h2><p>{copy("把朋友的频道留在手边。", "Keep your favourite places close.")}</p></div>
        <Btn icon="x" title="common.close" hint="hint-close" size="compact" quiet onClick={() => dialog.current?.close()} />
      </header>
      {!bookmarks.some(item => item.origin === currentOrigin) && <div className="c3-bookmark-current">
        <span><Glyph name="couch" size={19} /><strong>{currentName}</strong></span>
        <Btn icon="star" size="dense" quiet title={{ text: copy("收藏当前域", "Save this domain") }} cap={{ text: copy("收藏", "Save") }}
          hint="hint-invite-link" onClick={() => save([...bookmarks, { origin: currentOrigin, name: currentName }])} />
      </div>}
      {bookmarks.length > 0 && <ul className="c3-bookmark-list" aria-label={title}>
        {bookmarks.map(item => <li key={item.origin} data-editing={editing === item.origin}>
          <a href={domainBookmarkURL(item.origin)} target="_blank" rel="noopener noreferrer" aria-label={copy(`打开 ${item.name}（新标签页）`, `Open ${item.name} in a new tab`)}>
            <span><strong>{item.name}</strong><small>{item.origin}</small></span><span className="c3-bookmark-arrow" aria-hidden="true">↗</span>
          </a>
          <Btn icon="pencil" size="dense" quiet title={{ text: copy(`修改 ${item.name}`, `Edit ${item.name}`) }} hint="hint-rename" onClick={() => edit(item)} />
        </li>)}
      </ul>}
      <form onSubmit={event => { event.preventDefault(); submit(); }} onKeyDown={event => {
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }}>
        <h3>{editing ? copy("修改收藏", "Edit bookmark") : copy("添加域", "Add a domain")}</h3>
        <label><span>{copy("网址", "Address")}</span><span className="lr-input"><Glyph name="globe" size={18} />
          <input ref={addressInput} type="text" inputMode="url" enterKeyHint="next" autoComplete="url" autoCapitalize="none" spellCheck={false}
            placeholder="piik.example" value={address} required aria-invalid={error === "address" || error === "duplicate"}
            aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setAddress(event.target.value); setError(null); }}
            onBlur={() => { const origin = siteEntryOrigin(address); if (origin) setAddress(origin); }} />
        </span></label>
        <label><span>{copy("备注", "Label")}<small>{copy("可选，仅自己可见", "Optional, just for you")}</small></span>
          <span className="lr-input"><input value={name} onChange={event => setName(event.target.value)} autoComplete="off"
            placeholder={copy("比如，周末联机", "Maybe, Weekend party")} /></span></label>
        {error && <p id={`${id}-error`} className="c3-bookmark-error" role="alert">{errorText}</p>}
        <footer>
          {editing && <Btn icon="x" size="dense" quiet tone="danger" title={{ text: copy("移除收藏", "Remove bookmark") }} cap={{ text: copy("移除", "Remove") }}
            onClick={() => save(bookmarks.filter(item => item.origin !== editing))} />}
          <span />
          {editing && <Btn icon="x" size="compact" quiet title="common.cancel" cap="common.cancel" onClick={() => edit()} />}
          <Btn icon={editing ? "check" : "plus"} size="compact" tone="primary" type="submit" disabled={!address.trim()}
            title={{ text: editing ? copy("保存", "Save") : copy("添加", "Add") }} cap={{ text: editing ? copy("保存", "Save") : copy("添加", "Add") }} />
        </footer>
      </form>
      <p className="c3-bookmark-note">{copy("保存在当前浏览器。地址变了，可以在这里修改。", "Saved in this browser. Edit the address here if it changes.")}</p>
    </dialog>
  </>;
}
