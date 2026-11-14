import { useId, useLayoutEffect, useRef, useState } from "react";
import { Btn, Pill } from "./primitives";
import { ChannelSettingsDialog } from "../../channel/components/ChannelSettingsDialog";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { siteEntryURL } from "../../lib/site-address";
import "./site-bookmarks.css";

export type SiteBookmark = { id: string; name: string; origin: string };
type BookmarkDraft = Omit<SiteBookmark, "id"> & { id?: string };

export function SiteBookmarks({ bookmarks, initialSite, embedded = false, onSave, onRemove, onOpen }: {
  bookmarks: SiteBookmark[]; initialSite?: string; embedded?: boolean;
  onSave(draft: BookmarkDraft): Promise<void>; onRemove(id: string): Promise<void>; onOpen(site: SiteBookmark): void;
}) {
  const { t, vis } = useCopy();
  const heading = useId();
  const [draft, setDraft] = useState<BookmarkDraft>();
  const [pending, setPending] = useState<"save" | "remove">();
  const busy = pending !== undefined;
  const removalFocus = useRef<number | null>(null);
  const [error, setError] = useState<"client.bookmarks.duplicate" | "client.bookmarks.invalidAddress" | "client.connect.saveFailed">();
  useLayoutEffect(() => {
    const index = removalFocus.current;
    if (index === null || draft) return;
    removalFocus.current = null;
    // The deleted row cannot receive the modal's ordinary focus return.
    const neighbour = bookmarks[Math.min(index, bookmarks.length - 1)];
    document.getElementById(neighbour ? `${heading}-edit-${neighbour.id}` : `${heading}-add`)?.focus();
  }, [bookmarks, draft, heading]);
  function edit(value: BookmarkDraft): void { setError(undefined); setDraft(value); }
  async function save(remove = false): Promise<void> {
    if (!draft || busy) return;
    const url = siteEntryURL(draft.origin);
    if (!remove && !url) { setError("client.bookmarks.invalidAddress"); return; }
    setPending(remove ? "remove" : "save"); setError(undefined);
    try {
      if (remove && draft.id) {
        const index = bookmarks.findIndex(site => site.id === draft.id);
        await onRemove(draft.id);
        removalFocus.current = index;
      }
      else if (url) await onSave({ ...draft, name: draft.name.trim(), origin: url.origin });
      setDraft(undefined);
    } catch (failure) { setError(failure instanceof Error && failure.message === "bookmark_exists" ? "client.bookmarks.duplicate" : "client.connect.saveFailed"); }
    finally { setPending(undefined); }
  }
  return <>
    <section className={`lr-site-bookmarks${embedded ? " is-embedded c3-settings-panels" : ""}`} aria-labelledby={heading}>
      <header><h3 id={heading} className={embedded ? "visually-hidden" : undefined}><Glyph name="star" size={20} /><span className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.title")}</span></h3>
        <Btn id={`${heading}-add`} icon="plus" size="compact" title="client.bookmarks.add" cap="client.bookmarks.add" textTooltip disabled={busy} onClick={() => edit({ name: "", origin: initialSite ?? "" })} />
      </header>
      {bookmarks.length ? <ul>{bookmarks.map(site => <li key={site.id}>
        <div className="lr-site-bookmark-identity"><strong>{site.name || new URL(site.origin).hostname}</strong><span dir="ltr">{site.origin}</span></div>
        <div className="lr-site-bookmark-actions">
          <Btn id={`${heading}-edit-${site.id}`} icon="pencil" size="compact" quiet title={{ text: `${t("client.bookmarks.edit")} ${site.name || site.origin}` }} textTooltip disabled={busy} onClick={() => edit({ ...site })} />
          <Btn icon="arrowRight" size="compact" title={{ text: `${t("client.connect.openSite")} ${site.name || site.origin}` }} cap="client.bookmarks.open" textTooltip onClick={() => onOpen(site)} />
        </div>
      </li>)}</ul> : <p className={vis ? "visually-hidden" : "lr-site-bookmark-empty"}>{t("client.bookmarks.empty")}</p>}
    </section>
    {draft && <ChannelSettingsDialog compact closeDisabled={busy} title={t(draft.id ? "client.bookmarks.edit" : "client.bookmarks.add")} onClose={() => setDraft(undefined)}>
      <form className="c3-settings-panels lr-site-bookmark-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label><span className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.name")}</span><span className="lr-input"><Glyph name="pencil" size={18} /><input autoComplete="off" maxLength={40} value={draft.name} disabled={busy}
          onChange={event => setDraft({ ...draft, name: event.target.value })} /></span></label>
        <label><span className={vis ? "visually-hidden" : undefined}>{t("client.connect.siteAddress")}</span><span className="lr-input"><Glyph name="globe" size={18} />
          <input type="url" inputMode="url" required pattern="https?://.*" autoComplete="url" dir="ltr" placeholder="https://friends.example" value={draft.origin} disabled={busy}
            onChange={event => setDraft({ ...draft, origin: event.target.value })} /></span></label>
        <p className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.addressHint")}</p>
        {error && <Pill icon="alert" tone="bad" comic="signal-failed" alert label={t(error)} />}
        <div className="lr-site-bookmark-form-actions">
          {draft.id && <Btn icon="linkOff" quiet tone="danger" size="compact" title="client.bookmarks.remove" cap="client.bookmarks.remove" busy={pending === "remove"} disabled={busy} onClick={() => void save(true)} />}
          <div><Btn icon="x" size="compact" title="common.cancel" cap="common.cancel" disabled={busy} onClick={() => setDraft(undefined)} />
            <Btn icon="check" size="compact" type="submit" tone="primary" title="client.bookmarks.save" cap="client.bookmarks.save" busy={pending === "save"} disabled={busy} /></div>
        </div>
      </form>
    </ChannelSettingsDialog>}
  </>;
}
