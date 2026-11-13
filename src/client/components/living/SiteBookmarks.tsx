import { useId, useState } from "react";
import { Btn } from "./primitives";
import { ChannelSettingsDialog } from "../../channel/components/ChannelSettingsDialog";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { siteEntryURL } from "../../lib/site-address";
import "./site-bookmarks.css";

export type SiteBookmark = { id: string; name: string; origin: string };
type BookmarkDraft = Omit<SiteBookmark, "id"> & { id?: string };

export function SiteBookmarks({ bookmarks, initialSite, onSave, onRemove, onOpen }: {
  bookmarks: SiteBookmark[]; initialSite?: string;
  onSave(draft: BookmarkDraft): Promise<void>; onRemove(id: string): Promise<void>; onOpen(site: SiteBookmark): void;
}) {
  const { t, vis } = useCopy();
  const heading = useId();
  const [draft, setDraft] = useState<BookmarkDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"client.bookmarks.duplicate" | "client.bookmarks.invalidAddress" | "client.connect.saveFailed">();
  function edit(value: BookmarkDraft): void { setError(undefined); setDraft(value); }
  async function save(remove = false): Promise<void> {
    if (!draft || busy) return;
    const url = siteEntryURL(draft.origin);
    if (!remove && !url) { setError("client.bookmarks.invalidAddress"); return; }
    setBusy(true); setError(undefined);
    try {
      if (remove && draft.id) await onRemove(draft.id);
      else if (url) await onSave({ ...draft, name: draft.name.trim(), origin: url.origin });
      setDraft(undefined);
    } catch (failure) { setError(failure instanceof Error && failure.message === "bookmark_exists" ? "client.bookmarks.duplicate" : "client.connect.saveFailed"); }
    finally { setBusy(false); }
  }
  return <>
    <section className="lr-site-bookmarks" aria-labelledby={heading}>
      <header><h3 id={heading}><Glyph name="star" size={20} /><span className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.title")}</span></h3>
        <Btn icon="plus" size="compact" title="client.bookmarks.add" cap="client.bookmarks.add" textTooltip disabled={busy} onClick={() => edit({ name: "", origin: initialSite ?? "" })} />
      </header>
      {bookmarks.length ? <ul>{bookmarks.map(site => <li key={site.id}>
        <div className="lr-site-bookmark-identity"><strong>{site.name || new URL(site.origin).hostname}</strong><span dir="ltr">{site.origin}</span></div>
        <div className="lr-site-bookmark-actions">
          <Btn icon="pencil" size="compact" quiet title={{ text: `${t("client.bookmarks.edit")} ${site.name || site.origin}` }} textTooltip disabled={busy} onClick={() => edit({ ...site })} />
          <Btn icon="arrowRight" size="compact" title={{ text: `${t("client.connect.openSite")} ${site.name || site.origin}` }} cap="client.bookmarks.open" textTooltip onClick={() => onOpen(site)} />
        </div>
      </li>)}</ul> : <p className="lr-site-bookmark-empty">{t("client.bookmarks.empty")}</p>}
    </section>
    {draft && <ChannelSettingsDialog compact closeDisabled={busy} title={t(draft.id ? "client.bookmarks.edit" : "client.bookmarks.add")} onClose={() => setDraft(undefined)}>
      <form className="c3-settings-panels lr-site-bookmark-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label><span>{t("client.bookmarks.name")}</span><span className="lr-input"><Glyph name="pencil" size={18} /><input autoComplete="off" maxLength={40} value={draft.name} disabled={busy}
          onChange={event => setDraft({ ...draft, name: event.target.value })} /></span></label>
        <label><span>{t("client.connect.siteAddress")}</span><span className="lr-input"><Glyph name="globe" size={18} />
          <input type="url" inputMode="url" required pattern="https?://.*" autoComplete="url" dir="ltr" placeholder="https://friends.example" value={draft.origin} disabled={busy}
            onChange={event => setDraft({ ...draft, origin: event.target.value })} /></span></label>
        <p>{t("client.bookmarks.addressHint")}</p>
        {error && <p role="alert">{t(error)}</p>}
        <div className="lr-site-bookmark-form-actions">
          {draft.id && <Btn icon="x" quiet size="compact" title="client.bookmarks.remove" cap="client.bookmarks.remove" disabled={busy} onClick={() => void save(true)} />}
          <div><Btn icon="x" size="compact" title="common.cancel" cap="common.cancel" disabled={busy} onClick={() => setDraft(undefined)} />
            <Btn icon="check" size="compact" type="submit" tone="primary" title="client.bookmarks.save" cap="client.bookmarks.save" busy={busy} disabled={busy} /></div>
        </div>
      </form>
    </ChannelSettingsDialog>}
  </>;
}
