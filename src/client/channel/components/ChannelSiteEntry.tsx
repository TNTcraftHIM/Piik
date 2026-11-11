import { useCopy } from "../../ui/copy";
import { useProjectLink } from "../../lib/use-project-link";
import { Glyph } from "../../ui/icons";
import { BrandLoader } from "../../components/living/BrandMark";
import { Tooltip } from "../../components/living/Tooltip";
import type { ChannelController } from "../types";
import type { ChannelErrorPresentation } from "../error-presentation";
import { ChannelAction } from "./ChannelAction";
import "./channel-room-controls.css";

/** Site connection precedes Welcome; room access stays with the room entry. */
export function ChannelSiteEntry({ channel, failure }: {
  channel: Pick<ChannelController, "connection" | "reconnect">;
  failure: ChannelErrorPresentation;
}) {
  const { lang, vis } = useCopy(), zh = lang === "zh";
  const connecting = channel.connection === "connecting" || channel.connection === "reconnecting";
  const showConnectionHelp = !connecting && failure.connectionHelp;
  const guide = useProjectLink(`/docs/${zh ? "zh/" : ""}troubleshooting.html#${zh ? "常见问题" : "common-problems"}`,
    `https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/troubleshooting${zh ? ".zh-CN" : ""}.md#${zh ? "常见问题" : "common-problems"}`, showConnectionHelp);
  const helpLabel = zh ? "连接问题排查" : "Connection help";
  const title = connecting ? (zh ? "正在连接" : "Connecting") : (zh ? "未能连接此站点" : "Could not connect to this site");
  return <main className="c3-locked-room c3-site-entry" aria-labelledby="c3-site-entry-title">
    {connecting ? <BrandLoader /> : <Glyph name="signal" size={46} />}
    <h1 id="c3-site-entry-title" className={vis ? "visually-hidden" : undefined}>{title}</h1>
    <p className="c3-site-entry-address">{location.host}</p>
    {connecting ? <span role="status" className="visually-hidden">{title}</span>
        : <>{failure.message && <p role="alert">{failure.message}</p>}<ChannelAction icon="refresh" label={zh ? "重新连接" : "Reconnect"} onClick={channel.reconnect} /></>}
    {showConnectionHelp && <Tooltip kind="hint-help" text={vis ? undefined : helpLabel}>
      <a className="lr-btn is-compact is-quiet" href={guide} target="_blank" rel="noopener noreferrer" aria-label={helpLabel}>
        <Glyph name="book" size={18} />{!vis && <span className="lr-cap">{helpLabel}</span>}
      </a>
    </Tooltip>}
  </main>;
}
