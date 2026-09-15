import { useRef } from "react";
import { locales } from "../../locales";
import { useCopy, type CopyKey } from "../../ui/copy";
import { useRotatingText } from "../../ui/use-text-rotation";
import { BrandLoader } from "./BrandMark";

const NO_CAPTIONS: readonly string[] = [];

/** Decoration beside a literal status; it never describes operation progress. */
export function WaitingCaption({ context, still = false }: { context: string; still?: boolean }) {
  const { lang, vis } = useCopy();
  const captionRef = useRef<HTMLSpanElement>(null);
  const line = useRotatingText(vis ? NO_CAPTIONS : locales[lang].playful.waiting,
    `${lang}:${context}`, captionRef, still);
  if (!line) return null;
  return <span className="lr-waiting-caption" ref={captionRef} aria-hidden="true">
    <span key={line}>{line}</span>
  </span>;
}

export function LoadingStatus({ label, still = false }: { label: CopyKey; still?: boolean }) {
  const { t, vis } = useCopy();
  return <div className="lr-loading" role="status" aria-label={t(label)}>
    <BrandLoader still={still} />
    {vis ? null : <span>{t(label)}</span>}
    <WaitingCaption context={label} still={still} />
  </div>;
}
