import { AppHeader } from "../components/living/Header";
import { ComicTooltip } from "../components/living/ComicTooltip";
import { HINT_KINDS, HintComic, type HintKind } from "../components/living/hints";
import { useCopy } from "../ui/copy";

export function TooltipPreviewPage() {
  const { vis } = useCopy();
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-room lr-tooltip-preview">
        <header className="lr-tooltip-preview-head">
          <h1>Tooltip preview</h1>
          <p>{vis ? "所有操作提示漫画" : "All control hint comics"}</p>
        </header>
        <div className="lr-tooltip-preview-grid">
          {HINT_KINDS.map((kind: HintKind) => (
            <section className="lr-tooltip-preview-card" key={kind}>
              <header>
                <code>{kind}</code>
                <ComicTooltip kind={kind} place="below">
                  <button type="button" aria-label={`Preview ${kind}`} className="lr-tooltip-preview-trigger">
                    ✦
                  </button>
                </ComicTooltip>
              </header>
              <div className="lr-tooltip-preview-art">
                <HintComic kind={kind} size={320} />
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
