import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { BrandLockup, BrandMark } from "../components/living/BrandMark";
import { Btn } from "../components/living/primitives";
import { SiteBookmarks, type SiteBookmark } from "../components/living/SiteBookmarks";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { siteEntryURL } from "../lib/site-address";
import "./launcher-design-preview.css";

const samples: SiteBookmark[] = [
  { id: "weekend", name: "周末放映室", origin: "https://weekend.example" },
  { id: "studio", name: "一起做点东西", origin: "https://studio.example" },
  { id: "friends", name: "朋友们的客厅", origin: "https://friends.example" },
];
type PreviewDestination = SiteBookmark & { invitation?: string };

/** Presentation sandbox: all site, approval and launch state is local to this preview. */
export function LauncherDesignPreview() {
  const { lang } = useCopy();
  const en = lang === "en";
  const say = (zh: string, english: string) => en ? english : zh;
  const query = new URLSearchParams(location.search);
  const [sites, setSites] = useState<SiteBookmark[]>(query.get("state") === "empty" ? [] : samples);
  const [ready, setReady] = useState(query.get("state") === "ready");
  const [current, setCurrent] = useState<PreviewDestination>();
  const [pending, setPending] = useState<PreviewDestination>();
  const [dialog, setDialog] = useState<"bookmarks" | "host" | "devices" | "about">();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [access, setAccess] = useState("public");
  const [quick, setQuick] = useState(false);
  const [notice, setNotice] = useState("");
  function openSite(site: PreviewDestination) {
    if (current && current.origin !== site.origin) setPending(site);
    else { setCurrent(site); setNotice(say("已在原型中打开站点。", "Site opened in this preview.")); }
  }
  return <div className="lr-app ld-preview">
    <AppHeader homeHref="/client" appControl={null} diagnosticControl={null} />
    <main className="ld-shell">
      <aside className="ld-sidebar">
        <BrandLockup size={44} motion="once" className="ld-brand" suffix={<small>App</small>} />
        <div className="ld-saved-heading"><h2>{say("常去的站点", "Your places")}</h2>
          <Btn icon="pencil" quiet size="compact" title={{ text: say("管理收藏", "Manage bookmarks") }} textTooltip onClick={() => setDialog("bookmarks")} />
        </div>
        <nav className="ld-sites" aria-label={say("站点收藏", "Saved sites")}>
          {sites.map((site, index) => <button key={site.id} className="ld-site" aria-current={current?.origin === site.origin ? "page" : undefined} onClick={() => openSite(site)}>
            <span className="ld-site-symbol"><Glyph name={index === 0 ? "clapperboard" : index === 1 ? "pencil" : "couch"} size={22} /></span>
            <span><strong>{site.name || new URL(site.origin).hostname}</strong><small>{new URL(site.origin).hostname}</small></span>
            <Glyph name="arrowRight" size={16} />
          </button>)}
          {!sites.length && <div className="ld-empty"><Glyph name="star" size={28} /><p>{say("给常去的地方留个位置。", "Keep a place for your favourites.")}</p><Btn icon="plus" quiet cap={{ text: say("添加站点", "Add a site") }} title={{ text: say("添加站点", "Add a site") }} onClick={() => setDialog("bookmarks")} /></div>}
        </nav>
        <div className="ld-local">
          <span className="ld-local-icon"><Glyph name="display" size={20} /></span>
          <div><strong>{say("这台电脑", "This computer")}</strong><small>{ready ? say("你的站点正在运行", "Your site is running") : say("随时可以发起分享", "Ready when you are")}</small></div>
          {ready && <span className="ld-live-dot" aria-label={say("正在运行", "Running")} />}
        </div>
        <Btn icon="lock" quiet size="dense" title={{ text: say("设备授权", "Device access") }} cap={{ text: say("设备授权", "Device access") }} onClick={() => setDialog("devices")} />
      </aside>
      <div className="ld-main">
        {current && <div className="ld-current"><span><Glyph name="globe" size={17} />{say("当前站点", "Current site")}: <strong>{current.name}</strong></span><Btn icon="arrowRight" size="dense" quiet title={{ text: say("返回站点", "Return to site") }} cap={{ text: say("返回站点", "Return to site") }} onClick={() => setNotice(say("已回到当前站点（原型演示）。", "Returned to the current site (preview)."))} /></div>}
        <header className="ld-welcome">
          <div className="ld-welcome-mark"><BrandMark size={80} motion="once" /></div>
          <p className="ld-eyebrow">{say("好东西，一起看。", "Better with company.")}</p>
          <h1>{say("朋友在，", "Good company.")}<br />{say("就有好时光。", "Good times.")}</h1>
          <p>{say("去朋友的站点坐坐，或从这里发起。", "Drop into a friend’s place, or start something here.")}</p>
        </header>
        <section className="ld-join" aria-labelledby="ld-join-title">
          <h2 id="ld-join-title">{say("加入朋友", "Join your friends")}</h2>
          <form onSubmit={event => { event.preventDefault(); const url = siteEntryURL(address); setInvalid(!url); if (url) openSite({ id: "invitation", name: url.hostname, origin: url.origin, invitation: url.href }); }}>
            <label className="lr-input"><Glyph name="link" size={21} /><input value={address} onChange={event => { setAddress(event.target.value); setInvalid(false); }} aria-label={say("邀请链接或站点地址", "Invitation link or site address")} placeholder={say("粘贴邀请链接或站点地址", "Paste an invitation link or site address")} inputMode="url" autoCapitalize="none" spellCheck={false} aria-invalid={invalid} aria-describedby="ld-invite-hint" /></label>
            <Btn icon="arrowRight" tone="primary" type="submit" title={{ text: say("打开", "Open") }} cap={{ text: say("打开", "Open") }} />
          </form>
          <p id="ld-invite-hint" role={invalid ? "alert" : undefined}>{invalid ? say("请填写有效的站点地址或完整邀请链接。", "Enter a valid site address or full invitation link.") : say("完整邀请也能直接打开。朋友用浏览器就能加入。", "Full invitations work here too. Friends can join in their browser.")}</p>
        </section>
        <section className="ld-host">
          <div className="ld-host-icon"><Glyph name={ready ? "check" : "cast"} size={26} /></div>
          <div><h2>{ready ? say("你的站点已就绪", "Your place is ready") : say("这次，你来发起", "Make yourself the host")}</h2><p>{ready ? say("回到工作区，继续邀请朋友。", "Return to your workspace and invite friends.") : say("在这台电脑上开一个站点，叫朋友来。", "Start a site on this computer and bring friends over.")}</p></div>
          <Btn icon="arrowRight" title={{ text: ready ? say("继续", "Continue") : say("创建站点", "Start a site") }} cap={{ text: ready ? say("继续", "Continue") : say("创建站点", "Start a site") }} onClick={() => ready ? openSite({ id: "local", name: say("我的客厅", "My living room"), origin: "https://my-place.example" }) : setDialog("host")} />
        </section>
        <output className="ld-notice" aria-live="polite">{notice}</output>
        <footer className="ld-footer"><span>Piik App <small>3.0</small></span><Btn icon="help" quiet size="dense" title={{ text: say("版本与帮助", "Version & help") }} cap={{ text: say("版本与帮助", "Version & help") }} onClick={() => setDialog("about")} /></footer>
      </div>
    </main>
    <details className="ld-preview-tools"><summary>{say("外观原型 · 示例状态", "Design preview · sample states")}</summary><div>{(["empty", "loaded", "ready"] as const).map(state => <Btn key={state} icon={state === "ready" ? "check" : state === "empty" ? "plus" : "star"} quiet size="dense" title={{ text: state }} cap={{ text: state }} onClick={() => { setSites(state === "empty" ? [] : samples); setReady(state === "ready"); setCurrent(undefined); setNotice(""); }} />)}</div></details>
    {dialog === "bookmarks" && <ChannelSettingsDialog title={say("站点收藏", "Saved sites")} onClose={() => setDialog(undefined)}>
      <SiteBookmarks bookmarks={sites} onSave={async draft => { setSites(items => draft.id ? items.map(item => item.id === draft.id ? { ...draft, id: draft.id! } : item) : [...items, { ...draft, id: crypto.randomUUID() }]); }} onRemove={async id => setSites(items => items.filter(item => item.id !== id))} onOpen={site => { setDialog(undefined); openSite(site); }} />
    </ChannelSettingsDialog>}
    {dialog === "host" && <ChannelSettingsDialog compact title={say("创建你的站点", "Start your site")} onClose={() => setDialog(undefined)}>
      <form className="ld-dialog-form" onSubmit={event => { event.preventDefault(); setReady(true); setDialog(undefined); setNotice(say("站点就绪状态已在原型中展示。", "Showing the ready state in this preview.")); }}>
        <p>{say("选择朋友如何加入。", "Choose how friends can join.")}</p>
        <label><input type="radio" name="ld-access" checked={access === "public"} onChange={() => setAccess("public")} /><span><strong>{say("分享邀请链接", "Share an invitation")}</strong><small>{say("通过 Cloudflare 提供公网访问，需要互联网。", "Public access through Cloudflare. Requires internet.")}</small></span></label>
        <label><input type="radio" name="ld-access" checked={access === "local"} onChange={() => setAccess("local")} /><span><strong>{say("仅本地网络", "Local network only")}</strong><small>{say("让同一网络里的朋友加入。", "For friends on the same network.")}</small></span></label>
        <details><summary>{say("打开方式", "Opening preference")}</summary><label><input type="checkbox" checked={quick} onChange={event => setQuick(event.target.checked)} />{say("使用快捷分享视图", "Use quick sharing view")}</label><p>{say("默认打开完整工作区。", "The full workspace opens by default.")}</p></details>
        <Btn icon="arrowRight" tone="primary" type="submit" title={{ text: say("启动站点", "Start site") }} cap={{ text: say("启动站点", "Start site") }} />
      </form>
    </ChannelSettingsDialog>}
    {dialog === "devices" && <ChannelSettingsDialog compact title={say("设备授权", "Device access")} onClose={() => setDialog(undefined)}><p>{say("允许指定站点使用这台电脑的 App 能力。收藏站点不会授予设备权限。", "Allow a site to use this computer’s App capabilities. Saving a bookmark does not grant device access.")}</p><p>{say("此原型没有已授权站点。", "No sites are authorised in this preview.")}</p></ChannelSettingsDialog>}
    {dialog === "about" && <ChannelSettingsDialog compact title={say("版本与帮助", "Version & help")} onClose={() => setDialog(undefined)}><BrandLockup size={40} /><p>{say("3.0 启动页外观原型", "3.0 launcher design preview")}</p><p>{say("更新、版本和帮助将沿用 App 的共享入口。这里的操作仅改变示例状态。", "Updates, version and help retain the shared App controls. Actions here only change sample state.")}</p></ChannelSettingsDialog>}
    {pending && <ChannelSettingsDialog compact title={say("切换到另一个站点？", "Switch to another site?")} onClose={() => setPending(undefined)}><p>{say("将离开当前站点的页面活动。App 托管的房间会继续运行。", "You’ll leave activities in the current page. Rooms hosted by the App will keep running.")}</p><p><strong>{pending.name}</strong></p><div className="ld-dialog-actions"><Btn icon="x" title="common.cancel" cap="common.cancel" onClick={() => setPending(undefined)} /><Btn icon="arrowRight" tone="primary" title={{ text: say("切换站点", "Switch site") }} cap={{ text: say("切换站点", "Switch site") }} onClick={() => { setCurrent(pending); setPending(undefined); setNotice(say("已在原型中切换当前站点。", "Current site switched in this preview.")); }} /></div></ChannelSettingsDialog>}
  </div>;
}
