import { createElement, Fragment, useMemo, type ReactNode } from "react";
import MarkdownIt, { type Token } from "markdown-it";
import type { ChannelMessage, ChannelUserSummary } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import { useCopy } from "../../ui/copy";
import "./channel-message-content.css";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false })
  .disable(["image", "table", "heading", "lheading", "hr"]);
const tags = new Set(["p", "em", "strong", "s", "ul", "ol", "li", "blockquote"]);

function CodeBlock({ text }: { text: string }) {
  const { lang } = useCopy(), zh = lang === "zh", clipboard = useClipboardResult(text);
  return <div className="c3-code-block">
    <div className="c3-code-actions"><ChannelAction icon={clipboard.status === "copied" ? "check" : "copy"}
      label={clipboard.status === "copied" ? (zh ? "已复制" : "Copied") : (zh ? "复制代码" : "Copy code")}
      quiet disabled={!text} onClick={clipboard.copy} /></div>
    <pre tabIndex={0}><code>{text}</code></pre>
    {clipboard.status === "failed" && <small role="status">{zh ? "未能复制，请选择代码后手动复制。" : "Couldn't copy. Select the code and copy it manually."}</small>}
  </div>;
}

/** Raw messages stay unchanged. Only confirmed identity ranges become mention marks. */
export function ChannelMessageContent({ message, users, selfUserId }: {
  message: Pick<ChannelMessage, "text" | "mentions">; users: readonly ChannelUserSummary[]; selfUserId?: string | null;
}) {
  const { marker, references, tokens } = useMemo(() => {
    // Choose a delimiter absent from the raw message so user text cannot forge a reference.
    let marker = "\uE000";
    while (message.text.includes(marker) || message.text.toLowerCase().includes(encodeURI(marker).toLowerCase())) marker += "\uE000";
    const mentions = message.mentions ?? [];
    const references = mentions.map((mention, index) => ({ mention, marker: `${marker}${index}${marker}`,
      text: message.text.slice(mention.start, mention.end) }));
    let cursor = 0;
    const source = references.map(reference => {
      const plain = message.text.slice(cursor, reference.mention.start);
      cursor = reference.mention.end;
      return plain + reference.marker;
    }).join("") + message.text.slice(cursor);
    return { marker, references, tokens: markdown.parse(source, {}) };
  }, [message.text, message.mentions]);
  const restore = (text: string) => references.reduce((text, reference) => text.split(reference.marker).join(reference.text), text);
  const plain = (text: string): ReactNode => text.split(marker).map((part, index, parts) => {
    if (index % 2 === 0) return part;
    const reference = references[Number(part)];
    if (!reference || String(Number(part)) !== part) return marker + part + (index < parts.length - 1 ? marker : "");
    return <mark key={index} className={`c3-message-mention${reference.mention.userId === selfUserId ? " is-self" : ""}`}
      title={users.find(user => user.id === reference.mention.userId)?.name}>{reference.text}</mark>;
  });
  function render(tokens: Token[]): ReactNode[] {
    let index = 0;
    function children(): ReactNode[] {
      const result: ReactNode[] = [];
      while (index < tokens.length) {
        const token = tokens[index++], key = index;
        if (token.nesting === -1) break;
        if (token.type === "inline") result.push(<Fragment key={key}>{render(token.children ?? [])}</Fragment>);
        else if (token.type === "text") result.push(<Fragment key={key}>{plain(token.content)}</Fragment>);
        else if (token.type === "code_inline") result.push(<code key={key}>{restore(token.content)}</code>);
        else if (token.type === "fence" || token.type === "code_block") result.push(<CodeBlock key={key} text={restore(token.content)} />);
        else if (token.type === "softbreak" || token.type === "hardbreak") result.push(<br key={key} />);
        else if (token.nesting === 1) {
          const inner = children();
          if (token.tag === "a") {
            const href = references.reduce((href, reference) => href.split(encodeURI(reference.marker)).join(encodeURI(reference.text)),
              restore(String(token.attrGet("href") ?? "")));
            // Chat links never navigate within the app or execute another URL scheme.
            result.push(/^(?:https?:\/\/|mailto:)/i.test(href)
              ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{inner}</a> : <Fragment key={key}>{inner}</Fragment>);
          } else if (tags.has(token.tag)) result.push(createElement(token.tag, { key,
            ...(token.tag === "ol" && token.attrGet("start") ? { start: Number(token.attrGet("start")) } : {}) }, inner));
          else result.push(<Fragment key={key}>{inner}</Fragment>);
        }
      }
      return result;
    }
    return children();
  }
  return <div className="c3-message-markdown">{render(tokens)}</div>;
}
