import type { SignalConnectionState } from "../types";

export type ViewerHostState =
  | "unknown"
  | "online"
  | "paused"
  | "offline"
  | "stopped";

export type ViewerRouteKind = "none" | "p2p" | "sfu";

export type ViewerFailureCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_ACCESS_DENIED"
  | "INVALID_TOKEN"
  | "ROOM_CLOSED"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "ROOM_LOST"
  | "STALE_CLIENT"
  | "SERVER_ERROR"
  | "SESSION_REPLACED"
  | "SIGNAL_TERMINATED"
  | "HOST_STOPPED"
  | "HOST_OFFLINE"
  | "ROUTE_EXHAUSTED"
  | "AUTOPLAY_BLOCKED"
  | "PLAYBACK_FAILED";

export type ViewerStage =
  | "joining"
  | "room-not-found"
  | "access-denied"
  | "invalid-invite"
  | "room-closed"
  | "room-expired"
  | "room-full"
  | "room-lost"
  | "stale-client"
  | "server-error"
  | "session-replaced"
  | "signal-terminated"
  | "host-paused"
  | "needs-play"
  | "playing"
  | "recovering"
  | "route-failed"
  | "playback-failed"
  | "waiting-host"
  | "host-offline"
  | "waiting-sfu"
  | "preparing-p2p"
  | "preparing-sfu"
  | "receiving"
  | "allocating";

interface ViewerRouteFact {
  revision: number;
  phase: "prepare" | "active";
  kind: ViewerRouteKind;
}

interface ViewerRouteStatusFact {
  revision: number;
  state: "waiting" | "failed";
}

interface ViewerMediaFact {
  generation: number;
  revision: number;
  framePresented: boolean;
}

export interface ViewerPresentationState {
  access: "checking" | "ready" | "denied";
  signal: SignalConnectionState;
  host: ViewerHostState;
  revision: number | null;
  route: ViewerRouteFact | null;
  routeStatus: ViewerRouteStatusFact | null;
  connection:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed";
  media: ViewerMediaFact | null;
  retainedFrame: boolean;
  autoplayBlockedGeneration: number | null;
  failure: ViewerFailureCode | null;
  retryAvailable: boolean;
}

export type ViewerPresentationAction =
  | {
      type: "access";
      access: ViewerPresentationState["access"];
      failure?: ViewerFailureCode | null;
    }
  | { type: "signal"; signal: SignalConnectionState }
  | { type: "host"; host: ViewerHostState }
  | {
      type: "route";
      revision: number;
      phase: "prepare" | "active";
      kind: ViewerRouteKind;
    }
  | {
      type: "route-status";
      revision: number;
      state: "waiting" | "failed";
    }
  | {
      type: "connection";
      revision: number;
      connection: ViewerPresentationState["connection"];
    }
  | { type: "media-bound"; generation: number; revision: number }
  | { type: "frame-presented"; generation: number; revision: number }
  | { type: "autoplay-blocked"; generation: number; revision: number }
  | { type: "autoplay-cleared"; generation: number }
  | { type: "playback-failed"; generation: number; revision: number }
  | { type: "media-invalidated"; revision: number }
  | { type: "media-cleared" }
  | {
      type: "failure";
      failure: ViewerFailureCode | null;
      revision?: number;
    }
  | { type: "retry-available"; available: boolean };

export interface ViewerPresentation {
  stage: ViewerStage;
  message: string;
  notice: string | null;
  overlay: "none" | "status" | "blocking";
  retryAvailable: boolean;
  hasCurrentFrame: boolean;
  hasRetainedFrame: boolean;
  failureCode: ViewerFailureCode | null;
}

export const INITIAL_VIEWER_PRESENTATION_STATE: ViewerPresentationState = {
  access: "checking",
  signal: "offline",
  host: "unknown",
  revision: null,
  route: null,
  routeStatus: null,
  connection: "idle",
  media: null,
  retainedFrame: false,
  autoplayBlockedGeneration: null,
  failure: null,
  retryAvailable: false,
};

export function reduceViewerPresentation(
  state: ViewerPresentationState,
  action: ViewerPresentationAction,
): ViewerPresentationState {
  switch (action.type) {
    case "access":
      return {
        ...state,
        access: action.access,
        failure:
          action.failure !== undefined
            ? action.failure
            : action.access === "ready"
              ? null
              : state.failure,
      };
    case "signal":
      return {
        ...state,
        signal: action.signal,
        failure:
          action.signal === "connected" &&
          (state.failure === "SIGNAL_TERMINATED" ||
            state.failure === "SESSION_REPLACED")
            ? null
            : state.failure,
      };
    case "host": {
      const failure =
        action.host === "offline"
          ? "HOST_OFFLINE"
          : action.host === "stopped"
            ? "HOST_STOPPED"
            : state.failure === "HOST_OFFLINE" ||
                state.failure === "HOST_STOPPED"
              ? null
              : state.failure;
      return { ...state, host: action.host, failure };
    }
    case "route": {
      if (state.revision !== null && action.revision < state.revision) {
        return state;
      }
      const revisionChanged = state.revision !== action.revision;
      const currentFrame = hasCurrentFrame(state);
      return {
        ...state,
        revision: action.revision,
        route: {
          revision: action.revision,
          phase: action.phase,
          kind: action.kind,
        },
        routeStatus:
          state.routeStatus?.revision === action.revision &&
          state.routeStatus.state === "waiting"
            ? state.routeStatus
            : null,
        autoplayBlockedGeneration: revisionChanged
          ? null
          : state.autoplayBlockedGeneration,
        retainedFrame:
          state.retainedFrame || (revisionChanged && currentFrame),
        connection: revisionChanged
          ? action.kind === "none"
            ? "idle"
            : "connecting"
          : state.connection,
        failure:
          revisionChanged &&
          (state.failure === "ROUTE_EXHAUSTED" ||
            state.failure === "AUTOPLAY_BLOCKED" ||
            state.failure === "PLAYBACK_FAILED")
            ? null
            : state.failure,
      };
    }
    case "route-status": {
      if (state.revision !== null && action.revision < state.revision) {
        return state;
      }
      const revisionChanged = state.revision !== action.revision;
      const terminal = action.state === "failed";
      const currentFrame = hasCurrentFrame(state);
      return {
        ...state,
        revision: action.revision,
        routeStatus: {
          revision: action.revision,
          state: action.state,
        },
        media: terminal ? null : state.media,
        autoplayBlockedGeneration: revisionChanged || terminal
          ? null
          : state.autoplayBlockedGeneration,
        retainedFrame:
          state.retainedFrame ||
          ((revisionChanged || terminal) && currentFrame),
        failure:
          action.state === "failed"
            ? "ROUTE_EXHAUSTED"
            : revisionChanged &&
                (state.failure === "ROUTE_EXHAUSTED" ||
                  state.failure === "AUTOPLAY_BLOCKED" ||
                  state.failure === "PLAYBACK_FAILED")
              ? null
              : state.failure,
      };
    }
    case "connection":
      if (state.revision !== null && action.revision < state.revision) {
        return state;
      }
      return {
        ...state,
        revision: Math.max(state.revision ?? 0, action.revision),
        connection: action.connection,
      };
    case "media-bound": {
      if (
        (state.revision !== null && action.revision < state.revision) ||
        (state.media && action.generation <= state.media.generation)
      ) {
        return state;
      }
      return {
        ...state,
        revision: Math.max(state.revision ?? 0, action.revision),
        media: {
          generation: action.generation,
          revision: action.revision,
          framePresented: false,
        },
        retainedFrame: state.retainedFrame || hasCurrentFrame(state),
        autoplayBlockedGeneration: null,
        failure:
          state.failure === "AUTOPLAY_BLOCKED" ||
          state.failure === "PLAYBACK_FAILED" ||
          state.failure === "ROUTE_EXHAUSTED"
            ? null
            : state.failure,
      };
    }
    case "frame-presented":
      if (
        !state.media ||
        state.media.generation !== action.generation ||
        state.media.revision !== action.revision ||
        state.revision !== action.revision
      ) {
        return state;
      }
      return {
        ...state,
        connection: "connected",
        media: { ...state.media, framePresented: true },
        retainedFrame: false,
        failure:
          state.failure === "PLAYBACK_FAILED" ? null : state.failure,
      };
    case "autoplay-blocked":
      if (
        !state.media ||
        state.media.generation !== action.generation ||
        state.media.revision !== action.revision ||
        state.revision !== action.revision
      ) {
        return state;
      }
      return {
        ...state,
        autoplayBlockedGeneration: action.generation,
        failure: "AUTOPLAY_BLOCKED",
      };
    case "autoplay-cleared":
      if (state.autoplayBlockedGeneration !== action.generation) {
        return state;
      }
      return {
        ...state,
        autoplayBlockedGeneration: null,
        failure:
          state.failure === "AUTOPLAY_BLOCKED" ? null : state.failure,
      };
    case "playback-failed":
      if (
        !state.media ||
        state.media.generation !== action.generation ||
        state.media.revision !== action.revision ||
        state.revision !== action.revision
      ) {
        return state;
      }
      return { ...state, failure: "PLAYBACK_FAILED" };
    case "media-invalidated":
      if (state.revision !== action.revision) {
        return state;
      }
      return {
        ...state,
        media: null,
        retainedFrame: state.retainedFrame || hasCurrentFrame(state),
        autoplayBlockedGeneration: null,
      };
    case "media-cleared":
      return {
        ...state,
        media: null,
        retainedFrame: false,
        autoplayBlockedGeneration: null,
      };
    case "failure":
      if (
        action.revision !== undefined &&
        state.revision !== null &&
        action.revision < state.revision
      ) {
        return state;
      }
      const terminalRoute = action.failure === "ROUTE_EXHAUSTED";
      return {
        ...state,
        revision:
          action.revision === undefined
            ? state.revision
            : Math.max(state.revision ?? 0, action.revision),
        media: terminalRoute ? null : state.media,
        retainedFrame:
          state.retainedFrame || (terminalRoute && hasCurrentFrame(state)),
        autoplayBlockedGeneration: terminalRoute
          ? null
          : state.autoplayBlockedGeneration,
        failure: action.failure,
      };
    case "retry-available":
      return { ...state, retryAvailable: action.available };
  }
}

export function deriveViewerPresentation(
  state: ViewerPresentationState,
): ViewerPresentation {
  const currentFrame = hasCurrentFrame(state);
  const retainedFrame = state.retainedFrame;
  const frameOverlay = retainedFrame ? "status" : "blocking";

  if (state.access === "checking") {
    return presentation("joining", "正在加入房间", "blocking", state);
  }
  if (state.access === "denied") {
    switch (state.failure) {
      case "ROOM_NOT_FOUND":
        return presentation(
          "room-not-found",
          "房间不存在或已过期",
          "blocking",
          state,
        );
      case "ROOM_ACCESS_DENIED":
        return presentation(
          "access-denied",
          "当前无法通过房间号加入",
          "blocking",
          state,
        );
      case "INVALID_TOKEN":
        return presentation(
          "invalid-invite",
          "邀请链接无效或已失效",
          "blocking",
          state,
        );
      case "ROOM_EXPIRED":
        return presentation("room-expired", "房间已过期", "blocking", state);
      case "ROOM_CLOSED":
        return presentation("room-closed", "房间已关闭", "blocking", state);
      case "ROOM_FULL":
        return presentation("room-full", "当前无法加入房间", "blocking", state);
      case "ROOM_LOST":
        return presentation(
          "room-lost",
          "服务器已重启，房间已失效",
          "blocking",
          state,
        );
      case "STALE_CLIENT":
        return presentation(
          "stale-client",
          "页面版本已更新，请刷新后重试",
          "blocking",
          state,
        );
      case "SESSION_REPLACED":
        return presentation(
          "session-replaced",
          "此页面的会话已被另一个标签页接管",
          "blocking",
          state,
        );
      case "SIGNAL_TERMINATED":
        return presentation(
          "signal-terminated",
          "连接已终止，请刷新后重试",
          "blocking",
          state,
        );
      default:
        return presentation(
          "server-error",
          "暂时无法加入房间",
          "blocking",
          state,
        );
    }
  }

  if (state.host === "paused") {
    return presentation(
      "host-paused",
      "分享者已暂停",
      currentFrame || retainedFrame ? "status" : "blocking",
      state,
    );
  }

  if (
    state.media &&
    state.media.revision === state.revision &&
    state.autoplayBlockedGeneration === state.media.generation &&
    state.connection === "connected"
  ) {
    return presentation("needs-play", "点击播放", "status", state);
  }

  if (currentFrame) {
    const signalRecovering =
      state.signal === "reconnecting" || state.signal === "connecting";
    const mediaRecovering =
      state.connection === "reconnecting" || state.connection === "failed";
    return {
      ...presentation(
        signalRecovering || mediaRecovering ? "recovering" : "playing",
        signalRecovering || mediaRecovering ? "正在恢复连接" : "正在播放",
        "none",
        state,
      ),
      notice: state.host === "offline"
        ? "分享者连接已中断，画面可能冻结"
        : signalRecovering
        ? "服务器连接正在恢复，画面仍在播放"
        : mediaRecovering
          ? "媒体连接正在恢复"
          : null,
    };
  }

  switch (state.failure) {
    case "ROUTE_EXHAUSTED":
      return presentation(
        "route-failed",
        "没有可用的媒体线路",
        frameOverlay,
        state,
      );
    case "PLAYBACK_FAILED":
      return presentation(
        "playback-failed",
        "浏览器无法播放当前画面",
        frameOverlay,
        state,
      );
    case "SERVER_ERROR":
      return presentation(
        "server-error",
        "连接服务暂时不可用",
        frameOverlay,
        state,
      );
    case "STALE_CLIENT":
      return presentation(
        "stale-client",
        "页面版本已更新，请刷新后重试",
        frameOverlay,
        state,
      );
    case "SESSION_REPLACED":
      return presentation(
        "session-replaced",
        "此页面的会话已被另一个标签页接管",
        frameOverlay,
        state,
      );
    case "SIGNAL_TERMINATED":
      return presentation(
        "signal-terminated",
        "连接已终止，请刷新后重试",
        frameOverlay,
        state,
      );
    case "HOST_OFFLINE":
      return presentation(
        "host-offline",
        "分享者连接已中断",
        frameOverlay,
        state,
      );
    case "HOST_STOPPED":
      return presentation(
        "waiting-host",
        "等待开始分享",
        frameOverlay,
        state,
      );
  }

  if (state.routeStatus?.state === "waiting") {
    return presentation(
      "waiting-sfu",
      "正在连接备用线路",
      frameOverlay,
      state,
    );
  }
  if (state.media && state.media.revision === state.revision) {
    return presentation(
      "receiving",
      "正在接收画面",
      frameOverlay,
      state,
    );
  }
  if (state.route?.phase === "prepare") {
    return presentation(
      state.route.kind === "sfu" ? "preparing-sfu" : "preparing-p2p",
      state.route.kind === "sfu" ? "正在连接备用线路" : "正在建立 P2P",
      frameOverlay,
      state,
    );
  }
  if (
    state.signal === "reconnecting" ||
    state.connection === "reconnecting" ||
    state.connection === "failed"
  ) {
    return presentation(
      "recovering",
      "正在恢复连接",
      frameOverlay,
      state,
    );
  }
  if (state.host === "stopped" || state.host === "unknown") {
    return presentation(
      "waiting-host",
      "等待开始分享",
      frameOverlay,
      state,
    );
  }
  if (state.host === "offline") {
    return presentation(
      "host-offline",
      "分享者连接已中断",
      frameOverlay,
      state,
    );
  }
  if (state.route?.kind === "p2p") {
    return presentation(
      "preparing-p2p",
      "正在建立 P2P",
      frameOverlay,
      state,
    );
  }
  if (state.route?.kind === "sfu") {
    return presentation(
      "preparing-sfu",
      "正在连接备用线路",
      frameOverlay,
      state,
    );
  }
  return presentation(
    "allocating",
    "正在分配线路",
    frameOverlay,
    state,
  );
}

function hasCurrentFrame(state: ViewerPresentationState): boolean {
  return Boolean(
    state.media?.framePresented && state.media.revision === state.revision,
  );
}

function presentation(
  stage: ViewerStage,
  message: string,
  overlay: ViewerPresentation["overlay"],
  state: ViewerPresentationState,
): ViewerPresentation {
  return {
    stage,
    message,
    notice: null,
    overlay,
    retryAvailable:
      state.access === "ready" && state.host !== "paused" && state.retryAvailable,
    hasCurrentFrame: hasCurrentFrame(state),
    hasRetainedFrame: state.retainedFrame,
    failureCode: state.failure,
  };
}
