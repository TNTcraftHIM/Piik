import { useId, useLayoutEffect, useRef, useState } from "react";
import { BackButton, Btn, Pill } from "./primitives";
import { Glyph } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { siteEntryURL } from "../../lib/site-address";
import type { AppMode } from "../../lib/app-launch";
import type { SiteBookmark } from "../../lib/site-address";
import "./site-management.css";

type BookmarkDraft = { id?: string; name: string; origin: string };
export interface SiteManagementProps {
  bookmarks: readonly SiteBookmark[];
  sites: readonly string[];
  currentOrigin?: string;
  startupSite: string;
  ownedStartup?: AppMode;
  ownedSites: readonly string[];
  localSite?: string;
  busy: boolean;
  accessError?: string;
  onSave(draft: BookmarkDraft): Promise<void>;
  onRemove(id: string): Promise<void>;
  onApprove(origin: string): Promise<void>;
  onRevoke(origin: string): Promise<void>;
  onStartup(origin: string): Promise<void>;
  onOpen(origin: string): void;
}

/** One site identity, with independent bookmark, device-consent and startup effects. */
export function SiteManagement({ bookmarks, sites, currentOrigin, startupSite, ownedStartup, ownedSites, localSite,
  busy: ownerBusy, accessError, onSave, onRemove, onApprove, onRevoke, onStartup, onOpen }: SiteManagementProps) {
  const { t, vis } = useCopy();
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const focusReturn = useRef<{ origin?: string; index: number } | null>(null);
  const [detail, setDetail] = useState<{ origin?: string; draft: BookmarkDraft }>();
  const [pending, setPending] = useState<"save" | "remove">();
  const [bookmarkError, setBookmarkError] = useState<CopyKey>();
  const busy = ownerBusy || pending !== undefined;
  const origins = [...new Set([...bookmarks.map(site => site.origin), ...sites, ...(localSite ? [localSite] : [])])];
  const selected = detail?.origin;
  const selectedBookmark = bookmarks.find(site => site.origin === selected);
  const automatic = Boolean(selected && selected === localSite);
  const approved = automatic || Boolean(selected && sites.includes(selected));
  const opensOnStart = (origin: string) => startupSite === origin || Boolean(ownedStartup && ownedSites.includes(origin));
  useLayoutEffect(() => {
    if (detail) {
      panel.current?.querySelector<HTMLElement>(".lr-site-detail-heading")?.focus();
    } else if (focusReturn.current) {
      const previous = focusReturn.current;
      focusReturn.current = null;
      const index = previous.origin && origins.includes(previous.origin) ? origins.indexOf(previous.origin) : Math.min(previous.index, origins.length - 1);
      panel.current?.querySelector<HTMLElement>(index >= 0 ? `[data-site-index="${index}"] button` : "[data-site-add] button")?.focus();
    }
  }, [Boolean(detail)]);
  function edit(origin?: string) {
    if (busy) return;
    focusReturn.current = { origin, index: origin ? origins.indexOf(origin) : -1 };
    setBookmarkError(undefined);
    setDetail({ origin, draft: bookmarks.find(site => site.origin === origin) ?? { name: "", origin: origin ?? currentOrigin ?? "" } });
  }
  function back() { if (!busy) { setDetail(undefined); setBookmarkError(undefined); } }
  async function save(remove = false) {
    if (!detail || busy) return;
    const url = siteEntryURL(detail.draft.origin);
    if (!remove && !url) { setBookmarkError("client.bookmarks.invalidAddress"); return; }
    setPending(remove ? "remove" : "save");
    setBookmarkError(undefined);
    try {
      if (remove && detail.draft.id) await onRemove(detail.draft.id);
      else if (url) await onSave({ ...detail.draft, name: detail.draft.name.trim(), origin: url.origin });
      setDetail(undefined);
    } catch (error) {
      setBookmarkError(error instanceof Error && error.message === "bookmark_exists" ? "client.bookmarks.duplicate" : "client.connect.saveFailed");
    } finally { setPending(undefined); }
  }
  // Device-operation failures belong to the caller's accessError.
  const accessAction = (work: Promise<void>) => { void work.catch(() => {}); };
  const textClass = vis ? "visually-hidden" : undefined;
  return <section ref={panel} className="c3-settings-panels lr-site-management" aria-label={t("client.sites.title")} aria-busy={busy}>
    {detail ? <>
      <div className="lr-site-back"><BackButton onClick={back} disabled={busy} /></div>
      <div className="lr-site-detail-heading" tabIndex={-1}>
        <Glyph name="globe" size={22} /><div><h3>{selected ? selectedBookmark?.name || selected : t("client.bookmarks.add")}</h3>{selected && selectedBookmark?.name && <span dir="ltr">{selected}</span>}</div>
      </div>
      <form className="lr-site-section lr-site-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <h4><Glyph name="star" size={18} /><span className={textClass}>{t("client.sites.bookmark")}</span></h4>
        <label><span className={textClass}>{t("client.bookmarks.name")}</span><span className="lr-input"><Glyph name="pencil" size={18} /><input autoComplete="off" maxLength={40} disabled={busy} value={detail.draft.name} onChange={event => setDetail({ ...detail, draft: { ...detail.draft, name: event.target.value } })} /></span></label>
        <label><span className={textClass}>{t("client.connect.siteAddress")}</span><span className="lr-input"><Glyph name="globe" size={18} /><input type="url" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} dir="ltr" required placeholder="https://friends.example" disabled={busy} value={detail.draft.origin} onChange={event => setDetail({ ...detail, draft: { ...detail.draft, origin: event.target.value } })} /></span></label>
        <p className={textClass}>{t("client.bookmarks.addressHint")}</p>
        {bookmarkError && <Pill icon="alert" tone="bad" comic="signal-failed" alert label={t(bookmarkError)} />}
        <div className="lr-site-form-actions">{detail.draft.id && <Btn icon="linkOff" quiet tone="danger" size="compact" title="client.bookmarks.remove" cap="client.bookmarks.remove" disabled={busy} busy={pending === "remove"} onClick={() => void save(true)} />}<Btn icon="check" type="submit" tone="primary" size="compact" title="client.bookmarks.save" cap="client.bookmarks.save" disabled={busy} busy={pending === "save"} /></div>
      </form>
      {selected && <section className="lr-site-section">
        <h4><Glyph name="lock" size={18} /><span className={textClass}>{t("client.sites.deviceAccess")}</span></h4>
        <p className={textClass}>{t(automatic ? "client.sites.automaticHint" : "client.sites.deviceHint")}</p>
        <div className="lr-site-consent"><span className="lr-site-status"><Glyph name={approved ? "check" : "lock"} size={16} /><span className={textClass}>{t(automatic ? "client.sites.automatic" : approved ? "client.sites.allowed" : "client.sites.notAllowed")}</span></span>
          {!automatic && <Btn icon={approved ? "linkOff" : "check"} quiet={approved} tone={approved ? "danger" : undefined} size="compact" title={approved ? "client.sites.revoke" : "client.sites.allow"} cap={approved ? "client.sites.revoke" : "client.sites.allow"} disabled={busy} onClick={() => accessAction(approved ? onRevoke(selected) : onApprove(selected))} />}</div>
      </section>}
      {approved && selected && <section className="lr-site-section">
        <h4><Glyph name="play" size={18} /><span className={textClass}>{t("client.sites.startup")}</span></h4>
        <label className="lr-client-approval-startup"><input type="checkbox" checked={opensOnStart(selected)} disabled={busy} onChange={() => accessAction(onStartup(opensOnStart(selected) ? "" : selected))} /><Glyph name="window" size={18} /><span className={textClass}>{t("client.connect.openOnStart")}</span></label>
      </section>}
    </> : <>
      <header className="lr-site-list-header"><p className={textClass}>{t("client.sites.hint")}</p><span data-site-add><Btn id={`${id}-add`} icon="plus" size="compact" title="client.bookmarks.add" cap="client.bookmarks.add" disabled={busy} onClick={() => edit()} /></span></header>
      {origins.length ? <ul className="lr-site-list">{origins.map((origin, index) => {
        const bookmark = bookmarks.find(site => site.origin === origin);
        return <li key={origin} data-current={origin === currentOrigin || undefined}>
          <div className="lr-site-identity"><strong>{bookmark?.name || origin}</strong>{bookmark?.name && <span dir="ltr">{origin}</span>}
            <div className="lr-site-statuses">{bookmark && <span className="lr-site-status" title={t("client.sites.saved")}><Glyph name="star" size={14} /><span className={textClass}>{t("client.sites.saved")}</span></span>}{(origin === localSite || sites.includes(origin)) && <span className="lr-site-status" title={t(origin === localSite ? "client.sites.automatic" : "client.sites.allowed")}><Glyph name="lock" size={14} /><span className={textClass}>{t(origin === localSite ? "client.sites.automatic" : "client.sites.allowed")}</span></span>}{opensOnStart(origin) && <span className="lr-site-status" title={t("client.sites.startup")}><Glyph name="play" size={14} /><span className={textClass}>{t("client.sites.startup")}</span></span>}{origin === currentOrigin && <span className="lr-site-status" title={t("client.sites.current")}><Glyph name="window" size={14} /><span className={textClass}>{t("client.sites.current")}</span></span>}</div>
          </div>
          <div className="lr-site-row-actions"><Btn icon="arrowRight" size="compact" title={{ text: `${t("client.bookmarks.open")} ${bookmark?.name || origin}` }} cap="client.bookmarks.open" disabled={busy} onClick={() => onOpen(origin)} /><span data-site-index={index}><Btn icon="sliders" quiet size="compact" title={{ text: `${t("client.sites.manage")} ${bookmark?.name || origin}` }} cap="client.sites.manage" disabled={busy} onClick={() => edit(origin)} /></span></div>
        </li>;
      })}</ul> : <p className={`lr-site-empty${vis ? " visually-hidden" : ""}`}>{t("client.sites.empty")}</p>}
    </>}
    {ownedStartup && <div className="lr-site-owned-startup lr-site-section"><label className="lr-client-approval-startup"><input type="checkbox" checked disabled={busy} onChange={() => accessAction(onStartup(""))} /><Glyph name="window" size={18} /><span className={textClass}>{t("client.connect.openOwnedOnStart", { mode: t(ownedStartup === "local" ? "client.launch.local" : "client.launch.link") })}</span></label></div>}
    {accessError && <Pill icon="alert" tone="bad" comic="signal-failed" alert label={accessError} />}
  </section>;
}
