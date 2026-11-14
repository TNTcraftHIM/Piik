import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import { SiteManagement, type SiteManagementProps } from "../components/living/SiteManagement";
import type { SiteBookmark } from "../lib/site-address";
import { Btn } from "../components/living/primitives";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { siteEntryURL } from "../lib/site-address";
import "../components/living/site-bookmarks.css";

const bookmarksSchema = z.object({ bookmarks: z.array(z.object({ id: z.string(), origin: z.string().url(), name: z.string() })) });

type BookmarkView = {
  bookmarks?: SiteBookmark[]; loadError: boolean; retry(): void;
  open(site: SiteBookmark): void; manage(): void; invitationForm: ReactNode;
};

/** Only the local launcher owns this directory and explicit main-window requests. */
export function AppSiteBookmarks({ windowNavigation, closeOnOpen = false, render, ...access }: {
  windowNavigation: boolean; closeOnOpen?: boolean; render?: (view: BookmarkView) => ReactNode;
} & Omit<SiteManagementProps, "bookmarks" | "currentOrigin" | "onSave" | "onRemove" | "onOpen">) {
  const { t, vis } = useCopy();
  const [entry] = useState(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    return { site: hash.get("site"), open: hash.get("open") };
  });
  const [bookmarks, setBookmarks] = useState<z.infer<typeof bookmarksSchema>["bookmarks"]>();
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [address, setAddress] = useState(entry.open ?? "");
  const [pending, setPending] = useState(() => entry.open ? siteEntryURL(entry.open)?.href : undefined);
  const [openError, setOpenError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [managing, setManaging] = useState(false);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const busy = bookmarkBusy || access.busy;
  useEffect(() => {
    if (entry.site || entry.open) history.replaceState(history.state, "", location.pathname + location.search);
  }, [entry]);
  useEffect(() => {
    const abort = new AbortController();
    setLoadError(false);
    void fetch("/api/client-launcher/bookmarks", { cache: "no-store", signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(); return bookmarksSchema.parse(await response.json()); })
      .then(result => setBookmarks(result.bookmarks))
      .catch(() => { if (!abort.signal.aborted) setLoadError(true); });
    return () => abort.abort();
  }, [reload]);
  async function change(method: "POST" | "DELETE", body?: { id?: string; origin: string; name: string }, id?: string): Promise<void> {
    if (busy) throw new Error("save_pending");
    setBookmarkBusy(true);
    try {
      const response = await fetch(`/api/client-launcher/bookmarks${id ? `/${encodeURIComponent(id)}` : ""}`, {
        method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(response.status === 409 ? "bookmark_exists" : "save_failed");
      setBookmarks(bookmarksSchema.parse(await response.json()).bookmarks);
    } finally { setBookmarkBusy(false); }
  }

  function choose(value: string): void {
    if (busy || opening) return;
    const url = siteEntryURL(value);
    setOpenError(undefined);
    if (!url) { setOpenError(t("client.bookmarks.invalidAddress")); return; }
    if (windowNavigation) setPending(url.href);
    else location.assign(url.href);
  }
  async function open(): Promise<void> {
    if (!pending || busy || opening) return;
    if (!windowNavigation) { location.assign(pending); return; }
    setOpening(true); setOpenError(undefined);
    try {
      const response = await fetch("/api/client-launcher/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: pending }),
      });
      if (!response.ok) throw new Error();
      z.object({ opened: z.literal(true) }).parse(await response.json());
      setPending(undefined);
      if (closeOnOpen) window.close();
    } catch { setOpenError(t("client.bookmarks.openFailed")); }
    finally { setOpening(false); }
  }
  const editor = bookmarks ? <SiteManagement {...access} busy={busy} bookmarks={bookmarks} currentOrigin={entry.site ? siteEntryURL(entry.site)?.origin : undefined}
      onSave={draft => change("POST", draft)} onRemove={id => change("DELETE", undefined, id)} onOpen={choose} />
      : loadError ? <div role="alert"><p>{t("client.bookmarks.loadFailed")}</p><Btn icon="refresh" title="common.refresh" cap="common.refresh" onClick={() => setReload(value => value + 1)} /></div>
      : <p role="status">{t("common.loading")}</p>;
  const invitationForm = <>
    <form className="lr-site-bookmark-open" onSubmit={event => { event.preventDefault(); choose(address); }}>
      <label><span className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.openInvitation")}</span>
        <span className="lr-input"><Glyph name="link" size={18} /><input type="url" inputMode="url" required pattern="https?://.*" dir="ltr" autoComplete="off" disabled={busy || opening}
          aria-label={t("client.bookmarks.invitationAddress")} placeholder="https://friends.example" value={address} onChange={event => setAddress(event.target.value)} /></span></label>
      <Btn icon="arrowRight" type="submit" size={render ? undefined : "compact"} tone={render ? "primary" : undefined} title="client.connect.openSite" cap="client.bookmarks.open" disabled={busy || opening} />
    </form>
    {render && <p className={vis ? "visually-hidden" : "lr-launcher-invitation-hint"}>{t("client.launcher.invitationHint")}</p>}
    {!pending && openError && <p role="alert">{openError}</p>}
  </>;
  return <>
    {render ? render({ bookmarks, loadError, retry: () => setReload(value => value + 1),
      open: site => choose(site.origin), manage: () => setManaging(true), invitationForm })
      : <div className="lr-site-bookmark-manager"><h1 className={vis ? "visually-hidden" : undefined}>{t("client.sites.title")}</h1>{editor}{invitationForm}</div>}
    {render && managing && <ChannelSettingsDialog title={t("client.sites.title")} closeDisabled={busy} onClose={() => setManaging(false)}>{editor}</ChannelSettingsDialog>}
    {pending && <ChannelSettingsDialog compact closeDisabled={opening} title={t(windowNavigation ? "client.bookmarks.switchTitle" : "client.connect.openSite")} onClose={() => setPending(undefined)}>
      <div className="c3-settings-panels lr-site-bookmark-form"><strong className="lr-site-bookmark-target" dir="ltr">{new URL(pending).origin}</strong>
        {windowNavigation && <p>{t("client.bookmarks.switchHint")}</p>}
        {openError && <p role="alert">{openError}</p>}
        <div className="lr-site-bookmark-form-actions"><div>
          <Btn icon="x" size="compact" title="common.cancel" cap="common.cancel" disabled={opening} onClick={() => setPending(undefined)} />
          <Btn icon="arrowRight" size="compact" tone="primary" title={windowNavigation ? "client.bookmarks.switchConfirm" : "client.connect.openSite"}
            cap={windowNavigation ? "client.bookmarks.switchConfirm" : "client.connect.openSite"} busy={opening} disabled={busy || opening} onClick={() => void open()} />
        </div></div>
      </div>
    </ChannelSettingsDialog>}
  </>;
}
