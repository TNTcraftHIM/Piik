import { useId, useRef, useState } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import { ChannelDomainControls } from "./ChannelDomainControls";
import { ChannelIdentityMark } from "./ChannelIdentity";
import { InvitationLink } from "./InvitationLink";

/** Domain actions stay with their directory; room invitations have their own entry. */
export function ChannelDomainMenu({ channel, onPeople }: { channel: ChannelController; onPeople(): void }) {
  const { lang, vis } = useCopy(), zh = lang === "zh";
  const id = useId(), anchor = useRef<HTMLHeadingElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [settingsSlot, setSettingsSlot] = useState<HTMLDivElement | null>(null);
  useAnchoredPopover(anchor, panel, { align: "start" });
  const domain = channel.state?.channel;
  if (!domain) return null;
  const close = () => panel.current?.hidePopover();
  return <>
    <h1 ref={anchor} id="c3-room-list-heading" tabIndex={-1} className="c3-domain-name">
      <Tooltip overflow={{ text: domain.name, selector: ".c3-domain-name-text" }} disabled={open}>
        <button type="button" popoverTarget={id} aria-expanded={open} aria-haspopup="dialog">
          <span className="c3-domain-name-text">{domain.name}</span><Glyph name="chevron" size={14} />
        </button>
      </Tooltip>
    </h1>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={zh ? "域操作" : "Domain actions"}
      className="lr-anchored-card c3-domain-menu" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <header><ChannelIdentityMark icon={domain.icon} size={22} /><strong>{domain.name}</strong></header>
      <details className="c3-domain-invitation"><summary><Glyph name="link" size={18} />{!vis && (zh ? "邀请朋友" : "Invite friends")}<Glyph name="chevron" size={14} /></summary>
        {channel.inviteURL ? <InvitationLink url={channel.inviteURL} label={zh ? "域邀请链接" : "Domain invitation link"}
          copyLabel={domain.access === "public" ? (zh ? "复制域地址" : "Copy domain address") : undefined} />
          : <p>{zh ? "请向域主索取当前邀请。" : "Ask the domain owner for the current invitation."}</p>}
      </details>
      <div className="c3-domain-menu-actions">
        <Btn icon="users" quiet size="compact" title={{ text: zh ? "域内用户" : "Domain users" }} cap={{ text: zh ? "域内用户" : "Domain users" }} onClick={() => { close(); onPeople(); }} />
        <div ref={setSettingsSlot} />
      </div>
    </div>
    <ChannelDomainControls channel={channel} triggerSlot={settingsSlot} onOpen={close} />
  </>;
}
