import { useId, useRef, useState } from "react";
import type { StatusDescriptor } from "../../ui/media-status";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Comic } from "./Comic";
import { HintComic, isHintKind } from "./hints";
import { BrowserDiagnosticsButton } from "./Header";
import { StatusIndicator } from "./StatusIndicator";
import "./share-failure-help.css";

/** The current status owns this disclosure; closing/replacing it retains no error history. */
export function ShareFailureHelp({ status, label, code, checks }: {
  status: StatusDescriptor; label: string; code: string; checks: CopyKey[];
}) {
  const { lang, vis, t } = useCopy();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copyRequest = useRef<object | null>(null);
  const hint = (status.tooltip ?? status.comic)!;
  const guide = `https://github.com/P4-aaaul/Silip/blob/main/docs/guide/troubleshooting${lang === "zh" ? ".zh-CN" : ""}.md`;
  return <>
    <StatusIndicator status={status} label={label} onActivate={() => {
      copyRequest.current = null;
      setCopied("idle");
      setOpen(true);
      dialog.current?.showModal();
    }} />
    <dialog ref={dialog} className="lr-share-help" aria-labelledby={titleId} onClose={() => {
      copyRequest.current = null;
      setOpen(false);
    }}>
      {open && <>
        <header><h2 id={titleId}>{vis && <Glyph name="alert" size={20} />}<span className={vis ? "visually-hidden" : undefined}>{t("shareHelp.title")}</span></h2>
          <button type="button" className="lr-btn is-dense is-quiet" aria-label={t("common.close")} autoFocus onClick={() => dialog.current?.close()}>
            <Glyph name="x" size={18} />
          </button>
        </header>
        <div className="lr-share-help-scene" aria-hidden="true">
          {isHintKind(hint) ? <HintComic kind={hint} tone={status.tone} /> : <Comic kind={hint} theme="paper" tone={status.tone} />}
        </div>
        <p className={vis ? "visually-hidden" : "lr-share-help-reason"}>{label}</p>
        <code>{code}</code>
        <ol className={vis ? "visually-hidden" : undefined}>
          {checks.map(key => <li key={key}>{t(key)}</li>)}
          <li>{t("shareHelp.report")}</li>
        </ol>
        {!vis && code.startsWith("app/") && <p className="lr-share-help-note">{t("shareHelp.appDebug")}</p>}
        <nav aria-label={t("shareHelp.title")}>
          <a className="lr-btn" href={guide} target="_blank" rel="noopener noreferrer" aria-label={t("shareHelp.guide")}>{!vis && t("shareHelp.guide")}<Glyph name="arrowRight" size={16} /></a>
          <BrowserDiagnosticsButton />
          <button type="button" className="lr-btn" aria-label={t(copied === "done" ? "shareHelp.copied" : "shareHelp.copy")} onClick={() => {
            // Deliberately excludes URLs, invitation credentials and raw exceptions.
            const version = import.meta.env.VITE_SILIP_VERSION ?? "development";
            const request = copyRequest.current = {};
            void Promise.resolve().then(() => navigator.clipboard.writeText(`Silip Web ${version}\n${label}\n${code}`)).then(
              () => { if (copyRequest.current === request) setCopied("done"); },
              () => { if (copyRequest.current === request) setCopied("failed"); });
          }}><Glyph name={copied === "done" ? "check" : "copy"} size={16} />{!vis && t(copied === "done" ? "shareHelp.copied" : "shareHelp.copy")}</button>
        </nav>
        <span role="status">{copied === "failed" ? t("shareHelp.copyFailed") : ""}</span>
      </>}
    </dialog>
  </>;
}
