import { useId, useRef, useState } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";
import { useAnchoredPopover } from "./use-anchored-popover";

// Permission belongs to an exact origin, never to an invitation path or fragment.
export function siteEntryOrigin(value: string): string | null {
  try {
    const address = value.trim();
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function SiteAddressEntry({ initialAddress = "", onSelect }: {
  initialAddress?: string; onSelect: (origin: string) => void;
}) {
  const { vis, t } = useCopy();
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useAnchoredPopover(anchor, panel);
  function selectSite() {
    const origin = siteEntryOrigin(input.current?.value ?? "");
    if (!origin) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    panel.current?.hidePopover();
    onSelect(origin);
  }
  return <>
    <span ref={anchor} className="lr-client-site-add">
      <Btn icon="plus" title="client.connect.addSite" size="dense" quiet hint="hint-client-site"
        hintText="client.connect.addSiteHint" expanded={open} controls={id} popoverTarget={id} />
    </span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("client.connect.addSite")}
      className="lr-anchored-card lr-client-site-entry" onToggle={event => {
        if (event.target !== event.currentTarget) return;
        const opened = event.newState === "open";
        setOpen(opened);
        if (opened) input.current?.focus();
      }}>
      <label className="lr-input">
        <Glyph name="globe" size={18} />
        <input ref={input} defaultValue={initialAddress} type="text" inputMode="url" autoComplete="url"
          autoCapitalize="none" spellCheck={false} placeholder="https://…"
          aria-label={t("client.connect.siteAddress")} aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined} onInput={() => setInvalid(false)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              selectSite();
            }
          }} />
      </label>
      {invalid && <p id={`${id}-error`} role="alert">{t("client.connect.invalid")}</p>}
      <Btn icon="arrowRight" title="client.connect.continue" cap="client.connect.continue" tone="primary" onClick={selectSite} />
      <p className={vis ? "visually-hidden" : undefined}>{t("client.connect.addSiteHint")}</p>
    </div>
  </>;
}
