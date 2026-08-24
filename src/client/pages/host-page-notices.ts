import type { ServerMessage } from "../../shared/protocol";

export type HostAction =
  | "capture"
  | "source"
  | "quality"
  | "connection"
  | "room";

const HOST_ACTION_FALLBACK: Record<HostAction, string> = {
  capture: "启动分享失败",
  source: "切换分享来源失败",
  quality: "应用画质设置失败",
  connection: "观看连接处理失败",
  room: "房间操作失败",
};

type ServerErrorCode = Extract<
  ServerMessage,
  { type: "error" }
>["code"];

const HOST_SERVER_ERROR_NOTICE: Record<ServerErrorCode, string> = {
  AUTH_REQUIRED: "站点访问已失效，请重新验证",
  INVALID_MESSAGE: "页面版本已更新，请刷新后重试",
  INVALID_TOKEN: "分享凭证已失效，请重新创建房间",
  ROOM_ACCESS_DENIED: "当前操作没有权限",
  ROOM_EXPIRED: "房间已过期，请重新创建",
  ROOM_FULL: "房间已满",
  HOST_ALREADY_CONNECTED: "此房间已在另一个页面中分享",
  PEER_NOT_FOUND: "对应的观看连接已经离开",
  FORBIDDEN: "当前操作不可用",
  SERVER_ERROR: "服务暂时不可用，请稍后重试",
};

export function hostActionErrorNotice(
  error: unknown,
  action: HostAction,
): string {
  if (
    error instanceof DOMException &&
    (action === "capture" || action === "source")
  ) {
    switch (error.name) {
      case "NotAllowedError":
        return "屏幕选择已取消或没有共享权限";
      case "NotFoundError":
        return "没有可用的屏幕分享来源";
      case "NotReadableError":
        return "浏览器暂时无法读取所选分享来源";
      case "SecurityError":
        return "当前页面无法启动屏幕分享";
    }
  }
  return HOST_ACTION_FALLBACK[action];
}

export function hostServerErrorNotice(code: ServerErrorCode): string {
  return HOST_SERVER_ERROR_NOTICE[code];
}

export function sourceSwitchNotice({
  failedPeerCount,
  sfuReplaced,
  sfuWarning,
}: {
  failedPeerCount: number;
  sfuReplaced: boolean;
  sfuWarning: string | null;
}): string {
  const peerWarning =
    failedPeerCount > 0 ? "部分观看者正在重新连接" : null;
  if (!sfuReplaced) {
    return [
      sfuWarning ?? "SFU 分享来源未切换成功，正在恢复观看连接",
      peerWarning,
    ]
      .filter((message): message is string => message !== null)
      .join("；");
  }
  if (sfuWarning) {
    return [sfuWarning, peerWarning]
      .filter((message): message is string => message !== null)
      .join("；");
  }
  return peerWarning
    ? `分享来源已切换，但${peerWarning}`
    : "分享来源已切换";
}

export function shouldPauseLocalPreview(
  visibilityState: DocumentVisibilityState,
  hasFocus: boolean,
): boolean {
  return visibilityState !== "visible" || !hasFocus;
}

export function videoCodecLockNotice(phase: string): string | null {
  return phase === "starting" || phase === "live"
    ? "本次分享的视频编码已固定，停止分享后可更改"
    : null;
}
