import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { BrandMark } from "../components/living/BrandMark";
import { StageTv } from "../components/living/Stage";
import { CouchBench } from "../components/living/CouchBench";
import { PawnSvg } from "../components/living/Pawn";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { ChannelAction } from "../channel/components/ChannelAction";
import { ChannelInterfaceControl } from "../channel/components/ChannelInterfaceControl";
import "./channel-first-use-preview.css";

type Layout = "workspace" | "quick";
type Entry = "web" | "app" | "running" | "invite";

/** Optional first-use design comparison. Local state only; no Session or preference writes. */
export function ChannelFirstUsePreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [candidate, setCandidate] = useState<"inline" | "launcher">("inline");
  const [entry, setEntry] = useState<Entry>("web"), [layout, setLayout] = useState<Layout>("workspace");
  const [remembered, setRemembered] = useState<Layout | null>(null), [remember, setRemember] = useState(true);
  const [offered, setOffered] = useState(true), [roomOpen, setRoomOpen] = useState(false);
  const [draft, setDraft] = useState(""), [connection, setConnection] = useState("local");
  const [notice, setNotice] = useState("");
  const title = entry === "invite" ? copy("周五小聚", "Friday with friends") : copy("我的站点", "My site");
  const inRoom = roomOpen || entry === "invite";
  const choose = (value: Layout) => { setLayout(value); if (remember) setRemembered(value); setOffered(false); };
  const openEntry = (value: Entry) => { setEntry(value); setRoomOpen(false); setLayout(remembered ?? "workspace"); setNotice(""); };
  const newVisit = () => { setRoomOpen(false); setLayout(remembered ?? "workspace"); setNotice(copy("已模拟再次打开；上次跳过的建议不会重复出现。", "Another visit simulated; a skipped suggestion stays dismissed.")); };
  const offering = candidate === "inline" && offered && remembered === null && !inRoom && entry !== "running";
  const changeLayout = (value: Layout) => { setLayout(value); setRemembered(value); setNotice(copy("只改变界面，当前房间和草稿保留。", "Only the interface changed. The current room and draft are kept.")); };
  return <div className="lr-app c3-first-use-preview">
    <AppHeader appControl={null} diagnosticControl={null} />
    <main className="lr-room c3-first-use-main">
      <header className="c3-first-use-design"><p>{copy("首次进入设计稿，未改变实际启动方式或偏好", "First-use proposal; actual startup and preferences are unchanged")}</p>
        <div className="lr-toggle" role="group" aria-label={copy("候选方案", "Design candidate")}>
          <button type="button" className={candidate === "inline" ? "is-selected" : undefined} onClick={() => setCandidate("inline")}>A {copy("页面内轻提示", "Inline suggestion")}</button>
          <button type="button" className={candidate === "launcher" ? "is-selected" : undefined} onClick={() => setCandidate("launcher")}>B {copy("启动页按任务", "Task-based launcher")}</button>
        </div>
        <label>{copy("模拟入口", "Entry scenario")}<select className="lr-select" value={entry} onChange={event => openEntry(event.target.value as Entry)}>
          <option value="web">{copy("直接访问 Web", "Direct Web visit")}</option><option value="app">{copy("App 首次启动", "First App start")}</option>
          <option value="running">{copy("返回已运行站点", "Return to running site")}</option><option value="invite">{copy("朋友的房间邀请", "Room invitation")}</option>
        </select></label>
      </header>
      <section className="c3-first-use-surface" aria-label={copy("入口候选", "Entry candidate")}>
        <header><div><BrandMark size={30} /><strong>{candidate === "launcher" && !inRoom ? "Piik App" : title}</strong></div>
          <details className="c3-first-use-options"><summary className="lr-btn is-dense is-quiet">{copy("界面", "Interface")}</summary>
            <ChannelInterfaceControl value={layout} onChange={changeLayout} />
          </details></header>
        {candidate === "launcher" && !inRoom ? <div className="c3-first-use-launcher">
          <p className="c3-first-use-ready"><Glyph name="check" size={18} />{copy("App 已就绪", "App is ready")}</p>
          <h1>{entry === "running" ? copy("回到朋友身边", "Back to your friends") : copy("从哪里开始？", "Where would you like to start?")}</h1>
          {entry === "running" ? <><p>{copy("我的站点仍在运行，返回不会重新创建。", "My site is still running. Returning does not create another site.")}</p>
            <ChannelAction icon="arrowRight" primary label={copy("返回我的站点", "Return to my site")} onClick={() => setRoomOpen(true)} /></>
            : <div className="c3-first-use-tasks">
              <section><Glyph name="cast" size={26} /><h2>{copy("和朋友分享", "Share with friends")}</h2><p>{copy("打开自己的站点，接着选择要分享的画面。", "Open your site, then choose a picture to share.")}</p>
                <ChannelAction icon="arrowRight" primary label={copy("打开我的站点", "Open my site")} onClick={() => setRoomOpen(true)} />
                <details><summary>{copy("连接方式", "Connection method")}</summary><label>{copy("邀请地址", "Invitation address")}<select className="lr-select" value={connection} onChange={event => setConnection(event.target.value)}>
                  <option value="local">{copy("同一局域网", "Local network")}</option><option value="link">{copy("临时公网邀请", "Temporary public invite")}</option></select></label></details>
              </section>
              <section><Glyph name="link" size={26} /><h2>{copy("去朋友的站点", "Visit a friend's site")}</h2><p>{copy("有邀请就直接打开；也可以输入站点地址。", "Open the invitation directly, or enter a site address.")}</p>
                <ChannelAction icon="door" label={copy("模拟打开朋友邀请", "Simulate opening invitation")} onClick={() => openEntry("invite")} /></section>
            </div>}
          <p>{copy("界面偏好放在右上角，可稍后再选。连接方式不决定完整或极简。", "Choose an interface later in the corner. Connection method is separate from full or simple sharing.")}</p>
        </div> : <>
          {offering && <section className="c3-first-use-suggestion" aria-label={copy("选择适合你的界面", "Choose an interface")}>
            <div><h2>{copy("怎么用顺手，就怎么开始", "Start with the view that suits you")}</h2><p>{copy("完整工作区默认可用。只想分享画面？也可以用极简。", "Full workspace is ready by default. Simple sharing puts your picture first.")}</p></div>
            <div className="c3-first-use-choices">{(["workspace", "quick"] as const).map(value => <button type="button" className="lr-tile" key={value} onClick={() => choose(value)}>
              <Glyph name={value === "workspace" ? "sidebar" : "tv"} size={24} /><strong>{value === "workspace" ? copy("完整工作区", "Full workspace") : copy("极简分享", "Simple sharing")}</strong>
              <small>{value === "workspace" ? copy("房间、聊天和画面一起用", "Rooms, chat and pictures together") : copy("画面为主，聊天随手打开", "Picture first, conversation close by")}</small></button>)}</div>
            <div className="c3-first-use-suggestion-footer"><label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{copy("记住这次选择", "Remember this choice")}</label>
              <ChannelAction icon="arrowRight" quiet label={copy("稍后再说", "Maybe later")} onClick={() => setOffered(false)} /></div>
          </section>}
          <div className={`c3-first-use-content is-${layout}`}>
            {layout === "workspace" && <aside><strong>{copy("房间", "Rooms")}</strong><button type="button" className="lr-btn is-quiet" onClick={() => setRoomOpen(true)}><Glyph name="couch" />{copy("周五小聚", "Friday with friends")}</button></aside>}
            <div className="c3-first-use-room"><div className="c3-first-use-room-heading">{!inRoom && <h2>{copy("准备好就开始", "Ready when you are")}</h2>}
              {inRoom && <ChannelAction icon="x" quiet label={copy("返回站点", "Back to site")} onClick={() => { setEntry("web"); setRoomOpen(false); }} />}</div>
              {layout === "quick" ? <StageTv label={copy("分享入口示例", "Example sharing entry")}><div className="c3-first-use-tv"><Glyph name="cast" size={28} /><ChannelAction icon="cast" primary label={copy("开始分享", "Start sharing")}
                onClick={() => setNotice(copy("下一步会打开现有选源器；本设计稿不创建房间或采集画面。", "The existing source picker would open next. This proposal creates no room and captures nothing."))} /></div></StageTv>
                : <div className="c3-first-use-chat"><p>{inRoom ? copy("Ada：到了，先在这里聊聊。", "Ada: Here. Let's chat first.") : copy("从房间列表继续，或在需要时创建房间。", "Continue from the room list, or create a room when you need one.")}</p>
                  <label>{copy("草稿", "Draft")}<textarea className="c3-input" value={draft} onChange={event => setDraft(event.target.value)} placeholder={copy("写点什么…", "Write something…")} /></label></div>}
              {layout === "quick" && <label className="c3-first-use-quick-draft">{copy("聊天草稿", "Chat draft")}<input className="c3-input" value={draft} onChange={event => setDraft(event.target.value)} /></label>}
              <div className="c3-first-use-couch"><CouchBench width={240} /><PawnSvg color="var(--pawn-1)" /><PawnSvg color="var(--pawn-2)" /></div>
            </div>
          </div>
        </>}
        {notice && <p className="c3-first-use-result" role="status">{notice}</p>}
      </section>
      <footer className="c3-first-use-comparison"><p>{candidate === "inline" ? copy("A 建议：不增加启动步骤，只在空站点轻问一次。邀请和正在运行的房间直达。", "A recommendation: no extra launch step; suggest once in an empty site. Invitations and running rooms go straight through.")
        : copy("B 对照：先选择要做的事，界面放在次级入口。App 更易理解，但 Web 仍需自己的首次提示。", "B comparison: choose the task first, interface second. Clearer App entry, but Web still needs its own first-use suggestion.")}</p>
        <ChannelAction icon="refresh" quiet label={copy("模拟再次打开", "Simulate another visit")} onClick={newVisit} />
        <small>{remembered ? copy(`本页记住：${remembered === "quick" ? "极简分享" : "完整工作区"}`, `Remembered on this page: ${remembered === "quick" ? "Simple sharing" : "Full workspace"}`) : copy("本页尚未记住界面选择", "No interface choice remembered on this page")}</small>
      </footer>
    </main>
  </div>;
}
