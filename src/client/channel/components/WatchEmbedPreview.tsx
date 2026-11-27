import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WatchMedia } from "../watch-media";
import { Btn } from "../../components/living/primitives";
import { useCopy } from "../../ui/copy";
import { channelErrorPresentation } from "../../components/error-presentation";
import "./channel-media.css";

/** Keep the embedded player mounted until the stage takes its element. */
export function WatchEmbedPreview({ media, busy, onConfirm, onCancel, onOriginalPage }: {
  media: WatchMedia; busy: boolean; onConfirm?(): void; onCancel(): void; onOriginalPage?: () => void;
}) {
  const { t } = useCopy();
  const slot = useRef<HTMLDivElement>(null);
  const instruction = useRef<HTMLParagraphElement>(null);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => { instruction.current?.focus(); }, [media]);
  useLayoutEffect(() => {
    const surface = media.presentation, target = slot.current;
    if (surface?.kind !== "embed" || !target) return;
    if (surface.element.parentNode !== target) {
      if (surface.element.isConnected) target.moveBefore(surface.element, null);
      else target.append(surface.element);
    }
    const ownerDocument = target.ownerDocument;
    const sync = () => surface.setVisible(ownerDocument.visibilityState === "visible");
    ownerDocument.addEventListener("visibilitychange", sync); sync();
    return () => {
      ownerDocument.removeEventListener("visibilitychange", sync);
      if (surface.element.parentNode === target) surface.setVisible(false);
    };
  }, [media]);
  useEffect(() => {
    const controller = new AbortController();
    setReady(false); setError(null);
    void media.ready(controller.signal).then(() => { if (!controller.signal.aborted) setReady(true); }, failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "watch_media_failed");
    });
    return () => controller.abort();
  }, [media]);
  return <div className="c3-settings-panels c3-external-input">
    <p ref={instruction} tabIndex={-1}>{t(onConfirm ? "watch.embedHelp" : "watch.embedReceiveHelp")}</p>
    <div ref={slot} className="c3-watch-embed-preview" />
    {error && <p className="c3-settings-error" role="alert">{channelErrorPresentation(error, t).message}</p>}
    <div className="c3-share-title-actions">
      {onConfirm && <Btn icon="check" tone="primary" title="watch.selectVideo" cap="watch.selectVideo" busy={busy} disabled={busy || !ready || !!error} onClick={onConfirm} />}
      {onOriginalPage && <Btn icon="window" quiet title="watch.openPage" cap="watch.openPage" disabled={busy} onClick={onOriginalPage} />}
      <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={busy} onClick={onCancel} />
    </div>
  </div>;
}
