import { useState } from "react";
import { SiteBookmarks, type SiteBookmark } from "../components/living/SiteBookmarks";
import { useCopy } from "../ui/copy";

export function BookmarkPreview() {
  const { lang } = useCopy();
  const en = lang === "en";
  const [bookmarks, setBookmarks] = useState<SiteBookmark[]>([
    { id: "1", name: "Weekend living room", origin: "https://weekend.example" },
    { id: "2", name: "朋友们的放映室 · Friday night together", origin: "https://friends-movie-night.example" },
  ]);
  const [opened, setOpened] = useState("");
  return <section id="bookmark-preview" className="cp-section">
    <header className="cp-section-head"><div><h2>{en ? "Client bookmarks" : "客户端站点收藏"}</h2>
      <p>{en ? "Sample sites. Try adding, editing or opening one." : "示例站点，可以试试添加、编辑和打开。"}</p></div></header>
    <SiteBookmarks bookmarks={bookmarks} onOpen={site => setOpened(site.origin)}
      onSave={async draft => { setBookmarks(current => draft.id
        ? current.map(site => site.id === draft.id ? { ...draft, id: draft.id! } : site)
        : [...current, { ...draft, id: crypto.randomUUID() }]); }}
      onRemove={async id => { setBookmarks(current => current.filter(site => site.id !== id)); }} />
    <output className="cp-bookmark-result" aria-live="polite">{opened && (en ? "Preview selected: " : "预览已选择：") + opened}</output>
  </section>;
}
