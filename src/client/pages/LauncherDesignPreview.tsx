import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { BrandLockup } from "../components/living/BrandMark";
import { Btn } from "../components/living/primitives";
import { LauncherWorkspace } from "../components/living/LauncherWorkspace";
import { SiteStartControls } from "../components/living/LauncherForm";
import { SiteBookmarks, type SiteBookmark } from "../components/living/SiteBookmarks";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { siteEntryURL } from "../lib/site-address";
import type { AppMode } from "../lib/app-launch";
import "./launcher-design-preview.css";

const samples: SiteBookmark[] = [
  { id: "weekend", name: "周末放映室", origin: "https://weekend.example" },
  { id: "studio", name: "一起做点东西", origin: "https://studio.example" },
  { id: "friends", name: "朋友们的客厅", origin: "https://friends.example" },
];
const sampleLAN = [
  { address: "192.168.1.24", name: "Wi-Fi" },
  { address: "192.168.50.12", name: "Ethernet" },
];
type PreviewDestination = SiteBookmark & { invitation?: string };

/** Presentation sandbox: all site, approval and launch state is local to this preview. */
export function LauncherDesignPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const say = (zh: string, english: string) => en ? english : zh;
  const query = new URLSearchParams(location.search);
  const [sites, setSites] = useState<SiteBookmark[]>(query.get("state") === "empty" ? [] : samples);
  const [ready, setReady] = useState(query.get("state") === "ready");
  const [dialog, setDialog] = useState<"bookmarks" | "host" | "devices" | "about">();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [mode, setMode] = useState<AppMode>("link");
  const [lanAddress, setLanAddress] = useState(sampleLAN[0]!.address);
  const [port, setPort] = useState(8787);
  const [notice, setNotice] = useState("");
  function openSite(_site: PreviewDestination) {
    setNotice(say("已在原型中打开站点。", "Site opened in this preview."));
  }
  return <div className="lr-app lr-launcher-page">
    <AppHeader homeHref="/client" appControl={null} diagnosticControl={null} />
    <main><LauncherWorkspace bookmarks={sites} onRetryBookmarks={() => {}} onOpenBookmark={openSite} onManageBookmarks={() => setDialog("bookmarks")} ready={ready}
      deviceActions={<Btn icon="lock" quiet size="dense" title="client.launcher.deviceAccess" cap="client.launcher.deviceAccess" onClick={() => setDialog("devices")} />}
      invitationForm={<>
        <form onSubmit={event => { event.preventDefault(); const url = siteEntryURL(address); setInvalid(!url); if (url) openSite({ id: "invitation", name: url.hostname, origin: url.origin, invitation: url.href }); }}>
          <label><span>{t("client.bookmarks.openInvitation")}</span><span className="lr-input"><Glyph name="link" size={21} /><input value={address} onChange={event => { setAddress(event.target.value); setInvalid(false); }} aria-label={t("client.bookmarks.invitationAddress")} placeholder={t("client.bookmarks.invitationAddress")} inputMode="url" autoCapitalize="none" spellCheck={false} aria-invalid={invalid} aria-describedby="ld-invite-hint" /></span></label>
          <Btn icon="arrowRight" tone="primary" type="submit" title="client.bookmarks.open" cap="client.bookmarks.open" />
        </form>
        <p id="ld-invite-hint" role={invalid ? "alert" : undefined}>{t(invalid ? "client.bookmarks.invalidAddress" : "client.launcher.invitationHint")}</p>
      </>}
      localSiteAction={<Btn icon="arrowRight" title={ready ? "client.connect.continue" : "client.launch.go"} cap={ready ? "client.connect.continue" : "client.launch.go"} onClick={() => ready ? openSite({ id: "local", name: say("我的客厅", "My living room"), origin: "https://my-place.example" }) : setDialog("host")} />}
      footer={<><span>Piik App <small>3.0</small></span><Btn icon="help" quiet size="dense" title={{ text: say("版本与帮助", "Version & help") }} cap={{ text: say("版本与帮助", "Version & help") }} onClick={() => setDialog("about")} /></>}
    >{notice && <output aria-live="polite">{notice}</output>}</LauncherWorkspace></main>
    <details className="ld-preview-tools"><summary>{say("外观原型 · 示例状态", "Design preview · sample states")}</summary><div>{(["empty", "loaded", "ready"] as const).map(state => <Btn key={state} icon={state === "ready" ? "check" : state === "empty" ? "plus" : "star"} quiet size="dense" title={{ text: state }} cap={{ text: state }} onClick={() => { setSites(state === "empty" ? [] : samples); setReady(state === "ready"); setNotice(""); }} />)}</div></details>
    {dialog === "bookmarks" && <ChannelSettingsDialog title={t("client.bookmarks.title")} onClose={() => setDialog(undefined)}>
      <SiteBookmarks bookmarks={sites} embedded onSave={async draft => { setSites(items => draft.id ? items.map(item => item.id === draft.id ? { ...draft, id: draft.id! } : item) : [...items, { ...draft, id: crypto.randomUUID() }]); }} onRemove={async id => setSites(items => items.filter(item => item.id !== id))} onOpen={site => { setDialog(undefined); openSite(site); }} />
    </ChannelSettingsDialog>}
    {dialog === "host" && <ChannelSettingsDialog compact title={t("client.launch.room")} onClose={() => setDialog(undefined)}>
      <form className="c3-settings-panels lr-client-launch-panel" onSubmit={event => { event.preventDefault(); setReady(true); setDialog(undefined); setNotice(say("站点就绪状态已在原型中展示。", "Showing the ready state in this preview.")); }}>
        <SiteStartControls mode={mode} onModeChange={setMode} port={{ value: port, onChange: setPort }}
          lan={{ addresses: sampleLAN, selected: lanAddress, onChange: setLanAddress }} />
      </form>
    </ChannelSettingsDialog>}
    {dialog === "devices" && <ChannelSettingsDialog compact title={say("设备授权", "Device access")} onClose={() => setDialog(undefined)}><p>{say("允许指定站点使用这台设备的 App 能力。收藏站点不会授予设备权限。", "Allow a site to use this device’s App capabilities. Saving a bookmark does not grant device access.")}</p><p>{say("此原型没有已授权站点。", "No sites are authorised in this preview.")}</p></ChannelSettingsDialog>}
    {dialog === "about" && <ChannelSettingsDialog compact title={say("版本与帮助", "Version & help")} onClose={() => setDialog(undefined)}><BrandLockup size={40} /><p>{say("3.0 启动页外观原型", "3.0 launcher design preview")}</p><p>{say("更新、版本和帮助将沿用 App 的共享入口。这里的操作仅改变示例状态。", "Updates, version and help retain the shared App controls. Actions here only change sample state.")}</p></ChannelSettingsDialog>}
  </div>;
}
