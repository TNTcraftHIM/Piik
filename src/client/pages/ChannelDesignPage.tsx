import { useEffect, useState, type CSSProperties } from "react";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import { BrandLockup } from "../components/living/BrandMark";
import { HeaderControls } from "../components/living/Header";
import { DesignWorkspace } from "../channel/design/DesignWorkspace";
import { designScenes, readDesignScene, type DesignContent, type DesignScene } from "../channel/design/fixtures";
import "../channel/design/channel-design.css";

const PEOPLE_PRESETS = [1, 2, 4, 12, 20];
const CONTENT_PRESETS: { id: DesignContent; name: [string, string] }[] = [
  { id: "full", name: ["日常内容", "Everyday"] }, { id: "empty", name: ["空聊天", "Empty chat"] },
  { id: "few", name: ["两条消息", "Two messages"] }, { id: "domain", name: ["无房间", "No rooms"] },
];

/** A visual proposal; no channel, session or media state is changed here. */
export function ChannelDesignPage() {
  const { lang } = useCopy();
  const copy = (chinese: string, english: string) => lang === "zh" ? chinese : english;
  const [scene, setScene] = useState(readDesignScene);
  const [phone, setPhone] = useState(false);
  const [content, setContent] = useState<DesignContent>(() => {
    const value = new URLSearchParams(location.search).get("content");
    return CONTENT_PRESETS.find(item => item.id === value)?.id ?? "full";
  });
  const [people, setPeople] = useState(() => {
    const count = Number(new URLSearchParams(location.search).get("people"));
    return PEOPLE_PRESETS.includes(count) ? count : 4;
  });
  const [boardKey, setBoardKey] = useState(0);
  const current = designScenes.find(item => item.id === scene)!;
  useEffect(() => {
    const sync = () => setScene(readDesignScene());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = (next: DesignScene) => {
    if (next === scene) return;
    window.location.hash = next;
  };

  return <div className="cd-book">
    <header className="cd-book-header">
      <a className="cd-book-brand" href="#chat"><BrandLockup size={38} motion="once"><span className="cd-book-version">3.0</span></BrandLockup></a>
      <HeaderControls appControl={null} diagnosticControl={null} />
    </header>
    <section className="cd-book-intro">
      <span className="cd-book-eyebrow">{copy("界面设计稿", "INTERFACE STUDIES")}<span>01—04</span></span>
      <h1>{copy(...current.title)}</h1>
      <p>{copy(...current.note)}</p>
    </section>
    <div className="cd-book-tools">
      <nav className="lr-toggle cd-scene-picker" style={{ "--lr-segments": 4 } as CSSProperties} aria-label={copy("设计场景", "Design scenes")}>
        {designScenes.map((item, index) => <button type="button" key={item.id} className={scene === item.id ? "is-selected" : undefined}
          aria-current={scene === item.id ? "page" : undefined} onClick={() => { setBoardKey(boardKey + 1); navigate(item.id); }}>
          <span className="cd-scene-number">0{index + 1}</span>{copy(...item.name)}
        </button>)}
      </nav>
      <div className="cd-preview-options">
        <label className="cd-content-picker"><span>{copy("内容", "Content")}</span>
          <select value={content} onChange={event => {
            const next = event.target.value as DesignContent;
            setContent(next);
            const url = new URL(location.href); url.searchParams.set("content", next); history.replaceState(null, "", url);
          }}>{CONTENT_PRESETS.map(item => <option key={item.id} value={item.id}>{copy(...item.name)}</option>)}</select>
        </label>
        <div className="lr-toggle cd-people-picker" role="group" aria-label={copy("房间人数预览", "Room size preview")}
          style={{ "--lr-segments": PEOPLE_PRESETS.length } as CSSProperties}>
          {PEOPLE_PRESETS.map(count => <button type="button" key={count} className={people === count ? "is-selected" : undefined}
            aria-pressed={people === count} onClick={() => {
              setPeople(count);
              const url = new URL(location.href); url.searchParams.set("people", String(count)); history.replaceState(null, "", url);
            }}>{copy(`${count} 人`, `${count} ${count === 1 ? "person" : "people"}`)}</button>)}
        </div>
        <div className="lr-toggle cd-size-picker" role="group" aria-label={copy("预览尺寸", "Preview size")}>
          <button type="button" className={!phone ? "is-selected" : undefined} aria-label={copy("桌面", "Desktop")} aria-pressed={!phone} onClick={() => setPhone(false)}><Glyph name="display" size={19} /></button>
          <button type="button" className={phone ? "is-selected" : undefined} aria-label={copy("窄屏", "Narrow screen")} aria-pressed={phone} onClick={() => setPhone(true)}><Glyph name="window" size={18} /></button>
        </div>
      </div>
    </div>
    <div className={"cd-board" + (phone ? " is-phone" : "")}>
      <DesignWorkspace key={`${boardKey}-${people}-${content}`} copy={copy} scene={scene} content={content} peopleCount={people} onScene={navigate} />
    </div>
    <div className="cd-book-notes">
      <article><span>01</span><div><h2>{copy("空间先稳定下来", "A steady sense of place")}</h2><p>{copy("左侧找房间，中央一起聊和看，右侧找朋友。成员列表有自己的位置，不再悬浮在画面上。", "Rooms, conversation and people each have a home. The member list belongs to the layout, not a floating window.")}</p></div></article>
      <article><span>02</span><div><h2>{copy("熟悉的用法，自己的样子", "Familiar habits, our own character")}</h2><p>{copy("保留 Piik 的小人、圆润轮廓、语义配色与控件手感。少放装饰，把层级、间距和文字打磨清楚。", "Piik's people, rounded forms, semantic colours and shared controls. Character comes from the details, not extra decoration.")}</p></div></article>
      <article><span>03</span><div><h2>{copy("先看设计，再接功能", "Design before implementation")}</h2><p>{copy("这些是可操作的设计稿，使用示例聊天与画面。切换场景、收听状态和创建房间只影响当前预览。", "Interactive studies with sample conversations and screens. Scene changes, voice controls and room creation affect this preview only.")}</p></div></article>
    </div>
    <footer className="cd-book-footer"><span>{copy("Piik 3.0 外观原型", "Piik 3.0 visual proposal")}</span><a href="/__channel-preview">{copy("功能原型", "Functional prototype")}<Glyph name="arrowRight" size={14} /></a></footer>
  </div>;
}
