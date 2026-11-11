import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PawnSvg } from "../../components/living/Pawn";
import { participantColor } from "../../components/living/participant-color";
import { useCopy } from "../../ui/copy";
import type { ChannelUser } from "../protocol";
import { useSurfaceDocument } from "../../ui/panel-window";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import "./channel-mention-suggestions.css";

export function editMentions<T extends { start: number; end: number }>(before: string, after: string, mentions: readonly T[]): T[] {
  let start = 0, suffix = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (suffix < before.length - start && suffix < after.length - start
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const end = before.length - suffix, delta = after.length - before.length;
  return mentions.flatMap(mention => start === end && mention.end === start && /^[\p{L}\p{N}_]/u.test(after.slice(start)) ? []
    : mention.end <= start ? [mention]
    : mention.start >= end ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }] : []);
}

/** Textarea selection offsets are UTF-16; an email address is ordinary text. */
export function mentionQuery(text: string, start: number, end = start) {
  if (start !== end) return null;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, start));
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null;
}

export function matchingMentionUsers(users: readonly ChannelUser[], query: string) {
  const search = query.normalize("NFC").toLocaleLowerCase();
  return users.filter(user => user.name.normalize("NFC").toLocaleLowerCase().includes(search));
}

/** The textarea retains focus and owns IME, Arrow/Enter/Escape and active-descendant. */
export function ChannelMentionSuggestions({ id, users, activeIndex, onActiveIndex, onSelect, anchor }: {
  id: string; users: readonly ChannelUser[]; activeIndex: number;
  anchor: RefObject<HTMLElement | null>;
  onActiveIndex(index: number): void; onSelect(user: ChannelUser): void;
}) {
  const { lang } = useCopy();
  const list = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const ownerDocument = useSurfaceDocument();
  useAnchoredPopover(anchor, panel, { side: "above", align: "start", minVisibleHeight: 80 });
  useLayoutEffect(() => {
    const node = panel.current;
    node?.showPopover();
    return () => { if (node?.matches(":popover-open")) node.hidePopover(); };
  }, [ownerDocument]);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, users]);
  return ownerDocument && createPortal(<div ref={panel} popover="manual" className="c3-mention-suggestions">
    <div className="c3-mention-heading">{lang === "zh" ? "提及用户" : "Mention someone"}</div>
    <div ref={list} id={id} role="listbox" aria-label={lang === "zh" ? "用户" : "Users"}>
      {users.map((user, index) => <button type="button" key={user.id} id={`${id}-${user.id}`}
        role="option" aria-selected={index === activeIndex} tabIndex={-1}
        onPointerDown={event => event.preventDefault()} onPointerMove={() => onActiveIndex(index)}
        onClick={() => onSelect(user)}>
        <PawnSvg color={participantColor(user.id)} avatar={user.avatar ?? undefined} />
        <span>{user.name}</span>
      </button>)}
    </div>
    {!users.length && <p role="status">{lang === "zh" ? "没有匹配的用户" : "No matching users"}</p>}
  </div>, ownerDocument.body);
}
