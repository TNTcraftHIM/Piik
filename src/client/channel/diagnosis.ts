import type { CopyKey } from "../locales";
import type { ScreenPlaybackError } from "../media/viewer-playback";
import type { NativeRoomOpenReason } from "./hosting-api";
import type { RoomOpenFailure } from "./types";

const guideSections = {
  troubleshooting: ["troubleshooting", "", ""],
  localAccess: ["troubleshooting", "local-invitation-will-not-open", "本地邀请打不开"],
  site: ["troubleshooting", "the-page-opens-but-the-site-will-not-connect", "网页能打开但站点连接不上"],
  app: ["troubleshooting", "opening-app-and-joining-a-room", "打开-app-与加入房间"],
  appConnection: ["troubleshooting", "the-page-cannot-connect-to-app", "网页连接不上-app"],
  appVersion: ["troubleshooting", "app-and-page-versions-are-incompatible", "app-与页面版本不兼容"],
  room: ["troubleshooting", "an-invitation-or-password-is-rejected", "邀请或密码被拒绝"],
  manageRoom: ["room-tools", "manage-a-room", "管理房间"],
  offline: ["troubleshooting", "chat-or-history-will-not-load", "聊天或历史记录加载不出来"],
  picture: ["troubleshooting", "when-video-will-not-connect", "画面连接不上"],
  capture: ["troubleshooting", "app-windows-or-screens-are-missing", "app-找不到窗口或屏幕"],
  webpage: ["sharing", "watch-a-webpage-video-together", "一起看网页视频"],
  gamepad: ["remote-control", "gamepads", "手柄"],
  attachment: ["troubleshooting", "an-attachment-will-not-open-or-download", "附件打不开或下载不了"],
  storage: ["troubleshooting", "the-beta-app-reports-unsupportedstorageversion", "内测-app-提示-unsupportedstorageversion"],
} as const;

export type ChannelHelpTopic = keyof typeof guideSections;
export function diagnosisGuide(topic: ChannelHelpTopic, lang: string) {
  const zh = lang === "zh" || lang === "zh-Hant";
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
  | { area: "screen"; paused: boolean; deliveryFailed?: boolean; awaitingRoute?: boolean; playbackError?: ScreenPlaybackError }
  | { area: "error"; code: string | null | undefined }
  | { area: "roomOpen"; failure: RoomOpenFailure | NativeRoomOpenReason };

/** Read the current operation or selected subscription. A peer transport event alone never diagnoses it. */
export function diagnoseChannelFact(fact: ChannelFact): ChannelDiagnosis | null {
  if (fact.area === "app") {
    switch (fact.state) {
      case "approval": return { message: "client.connect.found", next: "client.connect.open", topic: "app" };
      case "unavailable": return { message: "client.connect.unavailable", topic: "appConnection" };
      case "incompatible": return { message: "client.connect.incompatible", topic: "appVersion" };
      default: return null;
    }
  }
  if (fact.area === "roomOpen") {
    switch (fact.failure) {
      case "in_use": return { message: "room.unopened.inUse", next: "room.unopened.closeOtherApp", topic: "manageRoom" };
      case "ambiguous": return { message: "room.unopened.ambiguous", next: "room.unopened.moveCopies", topic: "manageRoom" };
      case "unsupported_version": return { message: "channel.error.unsupportedStorageVersion", topic: "storage" };
      case "unreadable": return { message: "room.unopened.unreadable", topic: "storage" };
    }
  }
  if (fact.area === "screen") {
    if (fact.paused) return null;
    const message = fact.playbackError === 3 ? "screen.decodeFailed" : fact.playbackError === 4 ? "screen.unplayable"
      : fact.deliveryFailed ? "diagnosis.noPicture" : null;
    if (message) return { message, next: "screen.retryPicture", topic: "picture" };
    // An unplaced viewer has no failure and no deadline; retrying would not place it sooner.
    return fact.awaitingRoute ? { message: "diagnosis.noRoute", topic: "picture" } : null;
  }

  switch (fact.code) {
    case "app_disconnected":
    case "app_context_changed": return { message: "channel.error.appDisconnected", topic: "appConnection" };
    case "app_request_timeout": return { message: "native.fail.requestTimeout", topic: "appConnection" };
    case "site_not_approved": return { message: "client.sites.notAllowed", next: "client.sites.allow", topic: "app" };
    case "room_host_offline": return { message: "channel.error.roomHostOffline", topic: "offline" };
    case "room_access_required":
    case "room_forbidden": return { message: "channel.error.roomAccessDenied", topic: "room" };
    case "capture_targets_failed": return { message: "host.sourcePicker.failed", topic: "capture" };
    case "watch_media_access_denied": return { message: "watch.mediaAccessDenied", topic: "webpage" };
    case "watch_source_inspection_unavailable": return { message: "watch.sourceAccessRequired", topic: "webpage" };
    case "watch_media_unplayable": return { message: "watch.sourceUnplayable", topic: "webpage" };
    case "watch_media_timeout": return { message: "watch.forward.readTimeout", topic: "webpage" };
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
      if (fact.code && /^watch_(?:invalid_manifest|page_unavailable|media_(?:unavailable|credentials_unavailable|changed|truncated)|resource_unavailable|source_(?:unavailable|failed|changed|retired))$/.test(fact.code))
        return { message: "watch.forward.sourceUnavailable", topic: "webpage" };
      return null;
  }
}
