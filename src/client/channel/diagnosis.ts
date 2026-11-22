import type { CopyKey } from "../locales";
import type { AttachmentProgress } from "./attachments";
import type { ChannelRoom } from "./protocol";

const guideSections = {
  troubleshooting: ["troubleshooting", "", ""],
  site: ["troubleshooting", "the-page-opens-but-the-site-will-not-connect", "网页能打开但站点连接不上"],
  app: ["troubleshooting", "opening-app-and-joining-a-room", "打开-app-与加入房间"],
  room: ["troubleshooting", "an-invitation-or-password-is-rejected", "邀请或密码被拒绝"],
  offline: ["troubleshooting", "chat-or-history-will-not-load", "聊天或历史记录加载不出来"],
  picture: ["troubleshooting", "when-video-will-not-connect", "画面连接不上"],
  capture: ["troubleshooting", "app-windows-or-screens-are-missing", "app-找不到窗口或屏幕"],
  webpage: ["sharing", "watch-a-webpage-video-together", "一起看网页视频"],
  attachment: ["troubleshooting", "an-attachment-will-not-open-or-download", "附件打不开或下载不了"],
  storage: ["troubleshooting", "the-beta-app-reports-unsupportedstorageversion", "内测-app-提示-unsupportedstorageversion"],
} as const;

export type ChannelHelpTopic = keyof typeof guideSections;
export function diagnosisGuide(topic: ChannelHelpTopic, lang: string) {
  const zh = lang === "zh";
  const [page, enAnchor, zhAnchor] = guideSections[topic];
  const anchor = zh ? zhAnchor : enAnchor;
  const githubAnchor = topic === "storage" ? anchor.replace("unsupportedstorageversion", "unsupported_storage_version") : anchor;
  return {
    path: `/docs/${zh ? "zh/" : ""}${page}.html${anchor && `#${anchor}`}`,
    fallback: `https://github.com/TNTcraftHIM/Piik/blob/feat/channel-prototype/docs/guide/${page}${zh ? ".zh-CN" : ""}.md${githubAnchor && `#${githubAnchor}`}`,
  };
}

export interface ChannelDiagnosis {
  message: CopyKey;
  next?: CopyKey;
  topic: ChannelHelpTopic;
}

export type AppConnectionState = "idle" | "waking" | "busy" | "approval" | "approving" | "ready" | "unavailable" | "incompatible";
type ChannelFact =
  | { area: "app"; state: AppConnectionState }
  | { area: "screen"; paused: boolean; deliveryFailed?: boolean }
  | { area: "room"; room: Pick<ChannelRoom, "available" | "authorized"> }
  | { area: "attachment"; state: AttachmentProgress["state"] }
  | { area: "error"; code: string | null | undefined };

/** Read the current operation or selected subscription. A peer transport event alone never diagnoses it. */
export function diagnoseChannelFact(fact: ChannelFact): ChannelDiagnosis | null {
  if (fact.area === "app") {
    switch (fact.state) {
      case "approval": return { message: "client.connect.found", next: "client.connect.open", topic: "app" };
      case "unavailable": return { message: "client.connect.unavailable", topic: "app" };
      case "incompatible": return { message: "native.incompatible", topic: "app" };
      default: return null;
    }
  }
  if (fact.area === "screen") return !fact.paused && fact.deliveryFailed
    ? { message: "diagnosis.noPicture", next: "screen.retryPicture", topic: "picture" } : null;
  if (fact.area === "room") {
    if (fact.room.available) return null; // Admission can still be requested until the owner explicitly refuses it.
    return { message: fact.room.authorized ? "channel.error.roomHostOffline" : "room.offline.access", topic: "offline" };
  }
  if (fact.area === "attachment") return fact.state === "waiting-source"
    ? { message: "channel.attachment.waitingSource", topic: "attachment" } : null;

  switch (fact.code) {
    case "site_not_approved": return { message: "client.sites.notAllowed", next: "client.sites.allow", topic: "app" };
    case "room_host_offline": return { message: "channel.error.roomHostOffline", topic: "offline" };
    case "room_access_required":
    case "room_forbidden": return { message: "channel.error.roomAccessDenied", topic: "room" };
    case "capture_targets_failed": return { message: "host.sourcePicker.failed", topic: "capture" };
    case "watch_media_access_denied": return { message: "watch.mediaAccessDenied", topic: "webpage" };
    case "watch_source_inspection_unavailable": return { message: "watch.sourceAccessRequired", topic: "webpage" };
    case "watch_media_unplayable": return { message: "watch.sourceUnplayable", topic: "webpage" };
    case "watch_page_closed":
    case "page_player_closed":
    case "watch_mpd_invalid":
    case "invalid_watch_range_response": return { message: "watch.forward.sourceUnavailable", topic: "webpage" };
    case "attachment_unavailable":
    case "file_unavailable":
    case "file_source_unavailable": return { message: "channel.attachment.sourceUnavailable", topic: "attachment" };
    case "unsupported_storage_version":
    case "unsupported_domain_checkpoint": return { message: "channel.error.unsupportedStorageVersion", topic: "storage" };
    default:
      if (fact.code && /^watch_(?:invalid_manifest|page_unavailable|media_(?:unavailable|timeout|credentials_unavailable|changed|truncated)|resource_unavailable|source_(?:unavailable|failed|changed|retired))$/.test(fact.code))
        return { message: "watch.forward.sourceUnavailable", topic: "webpage" };
      return null;
  }
}
