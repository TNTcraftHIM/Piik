import { useState } from "react";
import { SiteManagement } from "../components/living/SiteManagement";
import type { SiteBookmark } from "../lib/site-address";
import { Btn } from "../components/living/primitives";
import { useCopy } from "../ui/copy";

export function BookmarkPreview() {
  const { lang } = useCopy();
  const en = lang === "en";
  const [bookmarks, setBookmarks] = useState<SiteBookmark[]>([
    { id: "1", name: "Weekend living room", origin: "https://weekend.example" },
    { id: "2", name: "朋友们的放映室 · Friday night together", origin: "https://friends-movie-night.example" },
  ]);
  const [opened, setOpened] = useState("");
  const [approved, setApproved] = useState(["https://weekend.example", "https://approved-only.example"]);
  const [startupSite, setStartupSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const [accessError, setAccessError] = useState<string>();
  function checkAccess() {
    setAccessError(fail ? en ? "Preview: device operation failed." : "预览：设备操作失败。" : undefined);
    if (fail) throw new Error("preview_failure");
  }
  return <section id="bookmark-preview" className="cp-section">
    <header className="cp-section-head"><div><h2>{en ? "Site management" : "站点管理"}</h2>
      <p>{en ? "Sample sites with independent bookmarks, device access and startup choices." : "示例站点：收藏、设备授权和启动设置各自独立。"}</p></div></header>
    <div className="cp-bookmark-tools"><label><input type="checkbox" checked={busy} onChange={event => setBusy(event.target.checked)} />{en ? "Busy" : "处理中"}</label><label><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />{en ? "Fail operations" : "操作失败"}</label><Btn icon="star" size="compact" quiet title={{ text: en ? "8 sites" : "8 个站点" }} cap={{ text: en ? "8 sites" : "8 个站点" }} onClick={() => setBookmarks(Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: index === 3 ? "朋友们的放映室 · A very long Friday night together" : `Living room ${index + 1}`, origin: `https://living-room-${index + 1}.example` })))} /></div>
    <SiteManagement bookmarks={bookmarks} sites={approved} startupSite={startupSite} ownedSites={[]} busy={busy} accessError={accessError} currentOrigin="https://current.example" onOpen={setOpened}
      onApprove={async origin => { checkAccess(); setApproved(current => [...current, origin]); }}
      onRevoke={async origin => { checkAccess(); setApproved(current => current.filter(site => site !== origin)); if (startupSite === origin) setStartupSite(""); }}
      onStartup={async origin => { checkAccess(); setStartupSite(origin); }}
      onSave={async draft => { if (fail) throw new Error("preview_failure"); if (bookmarks.some(site => site.id !== draft.id && site.origin === draft.origin)) throw new Error("bookmark_exists"); setBookmarks(current => draft.id
        ? current.map(site => site.id === draft.id ? { ...draft, id: draft.id! } : site)
        : [...current, { ...draft, id: crypto.randomUUID() }]); }}
      onRemove={async id => { if (fail) throw new Error("preview_failure"); setBookmarks(current => current.filter(site => site.id !== id)); }} />
    <output className="cp-bookmark-result" aria-live="polite">{opened && (en ? "Preview selected: " : "预览已选择：") + opened}</output>
  </section>;
}
