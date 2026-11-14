import { useRef } from "react";
import { locales, type WelcomeEntry } from "../../locales";
import { useCopy } from "../../ui/copy";
import { useRotatingText } from "../../ui/use-text-rotation";

/** Welcome decoration never describes loading or connection progress. */
export function WelcomeLine({ still = false }: { still?: boolean }) {
  const { lang } = useCopy();
  const element = useRef<HTMLParagraphElement>(null);
  const line = useRotatingText<WelcomeEntry>(locales[lang].playful.welcome, lang, { element, still, rotate: false });
  if (!line) return null;
  return <p ref={element} className={`lr-welcome${still ? " is-still" : ""}`}>
    <span key={line.text} className="lr-welcome-text">{line.text}</span>
  </p>;
}
