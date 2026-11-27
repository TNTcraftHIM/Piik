import type { ReactNode } from "react";
import { BrandLockup, BrandMark } from "./BrandMark";
import { Btn } from "./primitives";
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
  const { t } = useCopy();
  const showSaved = Boolean(bookmarks?.length || bookmarksError);
  const manage = window.piikNativeWindow !== "integrated" && <Btn icon="star" quiet size="compact" title="client.launcher.manageSites" cap="client.launcher.manageSites" onClick={onManageBookmarks} />;
  return <div className="lr-launcher-shell" data-app-shell data-saved={showSaved || undefined}>
    <div className="lr-launcher-identity">
      <BrandLockup size={44} motion="once" className="lr-launcher-brand" suffix={<small>App</small>} />
    </div>
    <div className="lr-launcher-main">
      <header className="lr-launcher-welcome">
        <div className="lr-launcher-welcome-mark"><BrandMark size={80} motion="once" /></div>
        <p className="lr-launcher-eyebrow">{t("client.launcher.eyebrow")}</p>
        <h1>{t("client.launcher.headlineFirst")}<br />{t("client.launcher.headlineLast")}</h1>
        <p className="lr-launcher-description">{t("client.launcher.description")}</p>
        <WelcomeLine />
      </header>
      <section className="lr-launcher-join" aria-label={t("client.bookmarks.openInvitation")}>
        {invitationForm}
      </section>
      <section className="lr-launcher-host">
        <div className="lr-launcher-host-icon"><Glyph name={ready ? "check" : "cast"} size={26} /></div>
        <div><h2>{t(ready ? "client.launcher.siteReady" : "client.launch.room")}</h2><p>{t(ready ? "client.launcher.siteReadyHint" : "client.launcher.hostHint")}</p></div>
        {localSiteAction}
      </section>
      {children && <div className="lr-launcher-results">{children}</div>}
      {footer && <footer className="lr-launcher-footer">{footer}</footer>}
    </div>
    <aside className="lr-launcher-sidebar">
      {showSaved && <><div className="lr-launcher-saved-heading"><h2>{t("client.bookmarks.title")}</h2>
        {manage}
      </div>
      <nav className="lr-launcher-sites" aria-label={t("client.bookmarks.title")}>
        {bookmarksError && <div className="lr-launcher-empty"><p role="alert">{t("client.bookmarks.loadFailed")}</p><Btn icon="refresh" quiet cap="common.retry" title="common.retry" onClick={onRetryBookmarks} /></div>}
        {bookmarks?.map(site => <button key={site.id} className="lr-launcher-site" onClick={() => onOpenBookmark(site)}>
            <span className="lr-launcher-site-symbol"><Glyph name="globe" size={22} /></span>
            <span><strong>{site.name || new URL(site.origin).hostname}</strong><small dir="ltr">{new URL(site.origin).host}</small></span>
            <Glyph name="arrowRight" size={16} />
          </button>)}
      </nav></>}
      <div className="lr-launcher-local">
        <span className="lr-launcher-local-icon"><Glyph name="display" size={20} /></span>
        <div><strong>{t("client.launcher.thisDevice")}</strong>
          <small role={starting ? "status" : undefined}>{t(starting ? "client.launch.starting" : ready ? "client.launcher.running" : "client.launcher.ready")}</small></div>
        {ready && <span className="lr-launcher-live-dot" aria-hidden="true" />}
        {!showSaved && manage}
      </div>
    </aside>
  </div>;
}
