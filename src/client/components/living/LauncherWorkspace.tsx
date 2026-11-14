import type { ReactNode } from "react";
import { BrandLockup, BrandMark } from "./BrandMark";
import { Btn, Pill } from "./primitives";
import { LoadingStatus } from "./WaitingStatus";
import { WelcomeLine } from "./WelcomeLine";
import type { SiteBookmark } from "../../lib/site-address";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import "./launcher-workspace.css";

/** Composition only: the launcher retains all navigation, approval and start owners. */
export function LauncherWorkspace({ bookmarks, bookmarksError, onRetryBookmarks, onOpenBookmark, onManageBookmarks,
  ready, starting = false, invitationForm, localSiteAction, footer, children }: {
  bookmarks?: readonly SiteBookmark[];
  bookmarksError?: boolean;
  onRetryBookmarks(): void;
  onOpenBookmark(site: SiteBookmark): void;
  onManageBookmarks(): void;
  ready: boolean;
  starting?: boolean;
  invitationForm: ReactNode;
  localSiteAction: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-launcher-shell">
    <aside className="lr-launcher-sidebar">
      <BrandLockup size={44} motion="once" className="lr-launcher-brand" suffix={<small>App</small>} />
      <div className="lr-launcher-saved-heading"><h2 className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.title")}</h2>
        {vis && <Glyph name="star" size={20} />}
        <Btn icon="pencil" quiet size="compact" title="client.launcher.manageSites" textTooltip onClick={onManageBookmarks} />
      </div>
      <nav className="lr-launcher-sites" aria-label={t("client.bookmarks.title")}>
        {bookmarksError ? <div className="lr-launcher-empty">{vis
          ? <Pill icon="alert" tone="bad" comic="signal-failed" alert label={t("client.bookmarks.loadFailed")} />
          : <p role="alert">{t("client.bookmarks.loadFailed")}</p>}<Btn icon="refresh" quiet cap="common.refresh" title="common.refresh" onClick={onRetryBookmarks} /></div>
          : !bookmarks ? vis ? <div className="lr-launcher-empty"><LoadingStatus label="common.loading" /></div>
            : <p className="lr-launcher-empty" role="status">{t("common.loading")}</p>
          : bookmarks.length ? bookmarks.map(site => <button key={site.id} className="lr-launcher-site" onClick={() => onOpenBookmark(site)}>
            <span className="lr-launcher-site-symbol"><Glyph name="globe" size={22} /></span>
            <span><strong>{site.name || new URL(site.origin).hostname}</strong><small dir="ltr">{new URL(site.origin).host}</small></span>
            <Glyph name="arrowRight" size={16} />
          </button>) : <div className="lr-launcher-empty"><Glyph name="star" size={28} /><p className={vis ? "visually-hidden" : undefined}>{t("client.bookmarks.empty")}</p><Btn icon="plus" quiet cap="client.bookmarks.add" title="client.bookmarks.add" onClick={onManageBookmarks} /></div>}
      </nav>
      <div className="lr-launcher-local">
        <span className="lr-launcher-local-icon"><Glyph name="display" size={20} /></span>
        <div><strong className={vis ? "visually-hidden" : undefined}>{t("client.launcher.thisDevice")}</strong>
          {vis && starting ? <LoadingStatus label="client.launch.starting" /> : <small className={vis ? "visually-hidden" : undefined} role={starting ? "status" : undefined}>{t(starting ? "client.launch.starting" : ready ? "client.launcher.running" : "client.launcher.ready")}</small>}</div>
        {ready && <span className="lr-launcher-live-dot" aria-hidden="true" />}
      </div>
    </aside>
    <div className="lr-launcher-main">
      <header className="lr-launcher-welcome">
        <div className="lr-launcher-welcome-mark"><BrandMark size={80} motion="once" /></div>
        <p className={vis ? "visually-hidden" : "lr-launcher-eyebrow"}>{t("client.launcher.eyebrow")}</p>
        <h1 className={vis ? "visually-hidden" : undefined}>{t("client.launcher.headlineFirst")}<br />{t("client.launcher.headlineLast")}</h1>
        <p className={vis ? "visually-hidden" : "lr-launcher-description"}>{t("client.launcher.description")}</p>
        <WelcomeLine />
      </header>
      <section className="lr-launcher-join" aria-label={t("client.bookmarks.openInvitation")}>
        {invitationForm}
      </section>
      <section className="lr-launcher-host">
        <div className="lr-launcher-host-icon"><Glyph name={ready ? "check" : "cast"} size={26} /></div>
        <div className={vis ? "visually-hidden" : undefined}><h2>{t(ready ? "client.launcher.siteReady" : "client.launch.room")}</h2><p>{t(ready ? "client.launcher.siteReadyHint" : "client.launcher.hostHint")}</p></div>
        {localSiteAction}
      </section>
      {children && <div className="lr-launcher-results">{children}</div>}
      {footer && <footer className="lr-launcher-footer">{footer}</footer>}
    </div>
  </div>;
}
