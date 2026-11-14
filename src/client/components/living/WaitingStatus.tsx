import { useRef } from "react";
import { locales } from "../../locales";
import { useCopy, type CopyKey } from "../../ui/copy";
import { useRotatingText } from "../../ui/use-text-rotation";
import { BrandLoader } from "./BrandMark";

/** Decoration beside a literal status; it never describes operation progress. */
export function WaitingCaption({ still = false }: { still?: boolean }) {
  const { lang } = useCopy();
  const captionRef = useRef<HTMLSpanElement>(null);
  const line = useRotatingText<string>(locales[lang].playful.waiting,
    lang, { element: captionRef, still });
  if (!line) return null;
  return <span className="lr-waiting-caption" ref={captionRef} aria-hidden="true">
    <span key={line}>{line}</span>
  </span>;
}

export function LoadingStatus({ label, still = false, waitingCaption = false }: {
  label: CopyKey; still?: boolean; waitingCaption?: boolean;
}) {
  const { t } = useCopy();
  return <div className="lr-loading" role="status" aria-label={t(label)}>
    <BrandLoader still={still} />
    <span>{t(label)}</span>
    {waitingCaption && <WaitingCaption still={still} />}
  </div>;
}
