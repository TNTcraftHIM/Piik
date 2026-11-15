import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { AppConnectionButton } from "../components/living/AppConnectionButton";
import { BrandLockup } from "../components/living/BrandMark";
import { Btn } from "../components/living/primitives";
import { LauncherWorkspace } from "../components/living/LauncherWorkspace";
import { SiteStartControls } from "../components/living/LauncherForm";
import { SiteManagement } from "../components/living/SiteManagement";
import type { SiteBookmark } from "../lib/site-address";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { publicSiteOrigin, siteEntryURL } from "../lib/site-address";
import type { AppMode } from "../lib/app-launch";
import "./launcher-design-preview.css";

type PreviewDestination = SiteBookmark & { invitation?: string };

/** Presentation sandbox: all site, approval and launch state is local to this preview. */
export function LauncherDesignPreview() {
  const { t } = useCopy();
  const samples: SiteBookmark[] = [
    { id: "weekend", name: t("client.launcher.preview.weekend"), origin: "https://weekend.example" },
    { id: "studio", name: t("client.launcher.preview.studio"), origin: "https://studio.example" },
    { id: "friends", name: t("client.launcher.preview.friends"), origin: "https://friends.example" },
  ];
  const sampleLAN = [
    { address: "192.168.1.24", name: "Wi-Fi" },
    { address: "192.168.50.12", name: t("client.launcher.preview.ethernet") },
  ];

  const query = new URLSearchParams(location.search);
  const app = query.has("app") ? <AppConnectionButton connected discovery={{
    connect: async () => `${query.get("app-origin") ?? location.origin}/client?site=${encodeURIComponent(location.origin)}`,
    health: async () => ({}), isIncompatible: () => false,
  }} /> : null;
  const [sites, setSites] = useState<SiteBookmark[]>(query.get("state") === "empty" ? [] : samples);
  const [ready, setReady] = useState(query.get("state") === "ready");
  const [dialog, setDialog] = useState<"bookmarks" | "host" | "about">();
  const [approved, setApproved] = useState(["https://weekend.example"]);
  const [startupSite, setStartupSite] = useState("");
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [mode, setMode] = useState<AppMode>("link");
  const [lanAddress, setLanAddress] = useState(sampleLAN[0]!.address);
  const [port, setPort] = useState(8787);
  const [publicEntry, setPublicEntry] = useState({ existing: false, origin: "https://piik.example" });
  const [publicError, setPublicError] = useState<string>();
  const [notice, setNotice] = useState("");
  function openSite(_site: PreviewDestination) {
    setNotice(t("client.launcher.preview.siteOpened"));
  }
  return <div className="lr-app lr-launcher-page">
    <AppHeader homeHref="/client" appIdentity={<BrandLockup size={30} className="is-compact" suffix={<small>App</small>} />} appControl={app} diagnosticControl={null} />
    <main><LauncherWorkspace bookmarks={sites} onRetryBookmarks={() => {}} onOpenBookmark={openSite} onManageBookmarks={() => setDialog("bookmarks")} ready={ready}
      invitationForm={<>
        <form onSubmit={event => { event.preventDefault(); const url = siteEntryURL(address); setInvalid(!url); if (url) openSite({ id: "invitation", name: url.hostname, origin: url.origin, invitation: url.href }); }}>
          <label><span>{t("client.bookmarks.openInvitation")}</span><span className="lr-input"><Glyph name="link" size={21} /><input value={address} onChange={event => { setAddress(event.target.value); setInvalid(false); }} aria-label={t("client.bookmarks.invitationAddress")} placeholder={t("client.bookmarks.invitationAddress")} inputMode="url" autoCapitalize="none" spellCheck={false} aria-invalid={invalid} aria-describedby="ld-invite-hint" /></span></label>
          <Btn icon="arrowRight" tone="primary" type="submit" title="client.bookmarks.open" cap="client.bookmarks.open" />
        </form>
        <p id="ld-invite-hint" role={invalid ? "alert" : undefined}>{t(invalid ? "client.bookmarks.invalidAddress" : "client.launcher.invitationHint")}</p>
      </>}
      localSiteAction={<Btn icon="arrowRight" title={ready ? "client.connect.continue" : "client.launch.go"} cap={ready ? "client.connect.continue" : "client.launch.go"} onClick={() => ready ? openSite({ id: "local", name: t("client.launcher.preview.myLivingRoom"), origin: "https://my-place.example" }) : setDialog("host")} />}
      footer={<><span>Piik App <small>3.0</small></span><Btn icon="help" quiet size="dense" title={{ text: t("client.launcher.preview.versionHelp") }} cap={{ text: t("client.launcher.preview.versionHelp") }} onClick={() => setDialog("about")} /></>}
    >{notice && <output aria-live="polite">{notice}</output>}</LauncherWorkspace></main>
    <details className="ld-preview-tools"><summary>{t("client.launcher.preview.sampleStates")}</summary><div>{(["empty", "loaded", "ready"] as const).map(state => <Btn key={state} icon={state === "ready" ? "check" : state === "empty" ? "plus" : "star"} quiet size="dense" title={{ text: t(`client.launcher.preview.${state}`) }} cap={{ text: t(`client.launcher.preview.${state}`) }} onClick={() => { setSites(state === "empty" ? [] : samples); setReady(state === "ready"); setNotice(""); }} />)}</div></details>
    {dialog === "bookmarks" && <ChannelSettingsDialog title={t("client.sites.title")} onClose={() => setDialog(undefined)}>
      <SiteManagement bookmarks={sites} sites={approved} startupSite={startupSite} ownedSites={[]} localSite={ready ? "http://127.0.0.1:8787" : undefined} busy={false}
        onApprove={async origin => setApproved(items => [...items, origin])}
        onRevoke={async origin => { setApproved(items => items.filter(item => item !== origin)); if (startupSite === origin) setStartupSite(""); }}
        onStartup={async origin => setStartupSite(origin)}
        onSave={async draft => { if (sites.some(site => site.id !== draft.id && site.origin === draft.origin)) throw new Error("bookmark_exists"); setSites(items => draft.id ? items.map(item => item.id === draft.id ? { ...draft, id: draft.id! } : item) : [...items, { ...draft, id: crypto.randomUUID() }]); }} onRemove={async id => setSites(items => items.filter(item => item.id !== id))} onOpen={origin => { setDialog(undefined); openSite({ id: origin, name: origin, origin }); }} />
    </ChannelSettingsDialog>}
    {dialog === "host" && <ChannelSettingsDialog compact title={t("client.launch.room")} onClose={() => setDialog(undefined)}>
      <form className="c3-settings-panels lr-client-launch-panel" onSubmit={event => {
        event.preventDefault();
        if (mode === "link" && publicEntry.existing && !publicSiteOrigin(publicEntry.origin)) { setPublicError(t("client.launch.invalidPublicAddress")); return; }
        setReady(true); setDialog(undefined); setNotice(t("client.launcher.preview.siteReady"));
      }}>
        <SiteStartControls mode={mode} onModeChange={setMode} port={{ value: port, onChange: setPort }}
          publicEntry={{ ...publicEntry, localAddress: `http://127.0.0.1:${port}`, error: publicError, onChange: next => { setPublicEntry(next); setPublicError(undefined); } }}
          lan={{ addresses: sampleLAN, selected: lanAddress, onChange: setLanAddress }} />
      </form>
    </ChannelSettingsDialog>}
    {dialog === "about" && <ChannelSettingsDialog compact title={t("client.launcher.preview.versionHelp")} onClose={() => setDialog(undefined)}><BrandLockup size={40} /><p>{t("client.launcher.preview.title")}</p><p>{t("client.launcher.preview.description")}</p></ChannelSettingsDialog>}
  </div>;
}
