import { useEffect, useRef, useState } from "react";
import { useCopy, type CopyKey } from "../../ui/copy";
import { createTextCycle, startTextRotation } from "../../ui/text-rotation";
import { Comic } from "./Comic";

export const WAITING_LINES = [
  "waiting.seat", "waiting.snack", "waiting.popcorn", "waiting.stretch",
  "waiting.water", "waiting.couch", "waiting.quest", "waiting.audience",
  "waiting.pixels", "waiting.loot", "waiting.scene", "waiting.cat",
  "waiting.blink", "waiting.calm", "waiting.shells", "waiting.narrator",
  "waiting.daydream", "waiting.break", "waiting.dance", "waiting.save",
] as const satisfies readonly CopyKey[];

/** Decoration beside a literal status; it never describes operation progress. */
export function WaitingCaption() {
  const { t, vis } = useCopy();
  const [line, setLine] = useState<CopyKey | null>(null);
  const captionRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setLine(null);
    if (vis) return;
    const next = createTextCycle(WAITING_LINES);
    return startTextRotation(() => {
      if (!captionRef.current?.closest('[data-comic-reduced-motion="true"]')) {
        setLine(next() ?? null);
      }
    }, 8_000);
  }, [vis]);

  if (vis) return null;
  return <span className="lr-waiting-caption" ref={captionRef} aria-hidden="true">
    {line !== null && <span key={line}>{t(line)}</span>}
  </span>;
}

export function LoadingStatus({ label }: { label: CopyKey }) {
  const { t, vis } = useCopy();
  return <div className="lr-loading" role="status" aria-label={t(label)}>
    <Comic kind="signal-connecting" theme="paper" />
    {vis ? null : <span>{t(label)}</span>}
    <WaitingCaption key={label} />
  </div>;
}
