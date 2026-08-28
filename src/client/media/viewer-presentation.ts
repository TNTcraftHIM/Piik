import type { ServerMessage } from "../../shared/protocol";
import type { CopyKey } from "../ui/copy";
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
  | "STALE_CLIENT"
  | "SERVER_ERROR"
  | "SESSION_REPLACED"
  | "SIGNAL_TERMINATED"
  | "HOST_STOPPED"
  | "HOST_OFFLINE"
  | "ROUTE_EXHAUSTED"
  | "AUTOPLAY_BLOCKED"
  | "PLAYBACK_FAILED";

export type ViewerMessageKey = Extract<CopyKey, `viewer.msg.${string}`>;
export type ViewerNoticeKey = Extract<CopyKey, `viewer.notice.${string}`>;

export type ViewerStage =
  | "joining"
  | "room-not-found"
  | "access-denied"
  | "invalid-invite"
  | "room-closed"
  | "room-expired"
  | "room-full"
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
  boundAtRevision: number;
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
  | { type: "frame-proof-reset"; generation: number; revision: number }
  | { type: "autoplay-blocked"; generation: number; revision: number }
  | { type: "autoplay-cleared"; generation: number }
  | { type: "playback-failed"; generation: number; revision: number }
  | { type: "media-invalidated"; revision: number }
  | { type: "media-cleared" }
  | { type: "sharing-stopped" }
  | {
      type: "failure";
      failure: ViewerFailureCode | null;
      revision?: number;
    };

export interface ViewerPresentation {
  stage: ViewerStage;
  messageKey: ViewerMessageKey;
  noticeKey: ViewerNoticeKey | null;
  overlay: "none" | "status" | "blocking";
  hasCurrentFrame: boolean;
  hasRetainedFrame: boolean;
  failureCode: ViewerFailureCode | null;
  connectionState:
    | "routing"
    | "waiting"
    | Exclude<ViewerPresentationState["connection"], "idle">;
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
      const committedRoute = action.phase === "active" && action.kind !== "none";
      const reactivatingTerminalRoute =
        committedRoute &&
        (state.routeStatus?.state === "failed" ||
          state.failure === "ROUTE_EXHAUSTED");
      return {
        ...state,
        revision: action.revision,
        route: {
          revision: action.revision,
          phase: action.phase,
          kind: action.kind,
        },
        routeStatus:
          !committedRoute && state.routeStatus?.revision === action.revision
            ? state.routeStatus
            : null,
        connection: reactivatingTerminalRoute
          ? state.media
            ? "reconnecting"
            : "connecting"
          : revisionChanged && state.media === null
            ? action.kind === "none"
              ? "idle"
              : "connecting"
            : state.connection,
        failure:
          committedRoute && state.failure === "ROUTE_EXHAUSTED"
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
      const currentMedia =
        terminal && state.media
          ? { ...state.media, framePresented: false }
          : state.media;
      return {
        ...state,
        revision: action.revision,
        routeStatus: {
          revision: action.revision,
          state: action.state,
        },
        connection: terminal
          ? "failed"
          : state.media
            ? state.connection
            : "connecting",
        media: currentMedia,
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
        (state.media && action.generation <= state.media.generation) ||
        (state.routeStatus?.revision === action.revision &&
          state.routeStatus.state === "failed") ||
        (state.revision === action.revision &&
          state.failure === "ROUTE_EXHAUSTED")
      ) {
        return state;
      }
      return {
        ...state,
        media: {
          generation: action.generation,
          boundAtRevision: action.revision,
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
        state.routeStatus?.state === "failed" ||
        state.failure === "ROUTE_EXHAUSTED"
      ) {
        return state;
      }
      return {
        ...state,
        connection: "connected",
        media: { ...state.media, framePresented: true },
        retainedFrame: false,
        routeStatus: null,
        failure:
          state.failure === "PLAYBACK_FAILED" ? null : state.failure,
      };
    case "frame-proof-reset":
      if (
        !state.media ||
        state.media.generation !== action.generation ||
        !state.media.framePresented
      ) {
        return state;
      }
      return {
        ...state,
        media: { ...state.media, framePresented: false },
        retainedFrame: true,
      };
    case "autoplay-blocked":
      if (
        !state.media ||
        state.media.generation !== action.generation
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
        state.media.generation !== action.generation
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
    case "sharing-stopped":
      return {
        ...state,
        host: "stopped",
        revision: null,
        route: null,
        routeStatus: null,
        connection: "idle",
        media: null,
        retainedFrame: false,
        autoplayBlockedGeneration: null,
        failure: "HOST_STOPPED",
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
      const terminalMedia =
        terminalRoute && state.media
          ? { ...state.media, framePresented: false }
          : state.media;
      return {
        ...state,
        revision:
          action.revision === undefined
            ? state.revision
            : Math.max(state.revision ?? 0, action.revision),
        media: terminalMedia,
        connection: terminalRoute ? "failed" : state.connection,
        retainedFrame:
          state.retainedFrame || (terminalRoute && hasCurrentFrame(state)),
        autoplayBlockedGeneration: terminalRoute
          ? null
          : state.autoplayBlockedGeneration,
        failure: action.failure,
      };
  }
}

export function deriveViewerPresentation(
  state: ViewerPresentationState,
): ViewerPresentation {
  const currentFrame = hasCurrentFrame(state);
  const retainedFrame = state.retainedFrame;
  const frameOverlay = retainedFrame ? "status" : "blocking";

  if (state.access === "checking") {
    return presentation("joining", "viewer.msg.joining", "blocking", state);
  }
  if (state.access === "denied") {
    switch (state.failure) {
      case "ROOM_NOT_FOUND":
        return presentation(
          "room-not-found",
          "viewer.msg.notFound",
          "blocking",
          state,
        );
      case "ROOM_ACCESS_DENIED":
        return presentation(
          "access-denied",
          "viewer.msg.denied",
          "blocking",
          state,
        );
      case "INVALID_TOKEN":
        return presentation(
          "invalid-invite",
          "viewer.msg.invalidInvite",
          "blocking",
          state,
        );
      case "ROOM_EXPIRED":
        return presentation("room-expired", "viewer.msg.expired", "blocking", state);
      case "ROOM_CLOSED":
        return presentation("room-closed", "viewer.msg.closed", "blocking", state);
      case "ROOM_FULL":
        return presentation("room-full", "viewer.msg.full", "blocking", state);
      case "STALE_CLIENT":
        return presentation(
          "stale-client",
          "viewer.msg.stale",
          "blocking",
          state,
        );
      case "SESSION_REPLACED":
        return presentation(
          "session-replaced",
          "viewer.msg.sessionReplaced",
          "blocking",
          state,
        );
      case "SIGNAL_TERMINATED":
        return presentation(
          "signal-terminated",
          "viewer.msg.signalTerminated",
          "blocking",
          state,
        );
      default:
        return presentation(
          "server-error",
          "viewer.msg.joinUnavailable",
          "blocking",
          state,
        );
    }
  }

  if (state.host === "paused") {
    return presentation(
      "host-paused",
      "viewer.msg.hostPaused",
      currentFrame || retainedFrame ? "status" : "blocking",
      state,
    );
  }

  if (
    state.media &&
    state.autoplayBlockedGeneration === state.media.generation &&
    state.connection === "connected"
  ) {
    return presentation("needs-play", "viewer.msg.needsPlay", "status", state);
  }

  if (currentFrame) {
    const signalRecovering =
      state.signal === "reconnecting" ||
      state.signal === "connecting";
    const mediaRecovering =
      state.connection === "reconnecting" || state.connection === "failed";
    return {
      ...presentation(
        signalRecovering || mediaRecovering ? "recovering" : "playing",
        signalRecovering || mediaRecovering ? "viewer.msg.recovering" : "viewer.msg.playing",
        "none",
        state,
      ),
      noticeKey: state.host === "offline"
        ? "viewer.notice.hostOffline"
        : signalRecovering
          ? "viewer.notice.signalRecovering"
        : mediaRecovering
          ? "viewer.notice.mediaRecovering"
          : null,
    };
  }

  if (state.routeStatus?.state === "failed") {
    return presentation(
      "route-failed",
      "viewer.msg.routeFailed",
      frameOverlay,
      state,
    );
  }

  switch (state.failure) {
    case "ROUTE_EXHAUSTED":
      return presentation(
        "route-failed",
        "viewer.msg.routeFailed",
        frameOverlay,
        state,
      );
    case "PLAYBACK_FAILED":
      return presentation(
        "playback-failed",
        "viewer.msg.playbackFailed",
        frameOverlay,
        state,
      );
    case "SERVER_ERROR":
      return presentation(
        "server-error",
        "viewer.msg.serverError",
        frameOverlay,
        state,
      );
    case "STALE_CLIENT":
      return presentation(
        "stale-client",
        "viewer.msg.stale",
        frameOverlay,
        state,
      );
    case "SESSION_REPLACED":
      return presentation(
        "session-replaced",
        "viewer.msg.sessionReplaced",
        frameOverlay,
        state,
      );
    case "SIGNAL_TERMINATED":
      return presentation(
        "signal-terminated",
        "viewer.msg.signalTerminated",
        frameOverlay,
        state,
      );
    case "HOST_OFFLINE":
      return presentation(
        "host-offline",
        "viewer.msg.hostOffline",
        frameOverlay,
        state,
      );
    case "HOST_STOPPED":
      return presentation(
        "waiting-host",
        "viewer.msg.waitingHost",
        frameOverlay,
        state,
      );
  }

  if (state.routeStatus?.state === "waiting") {
    return presentation(
      "waiting-sfu",
      "viewer.msg.preparingSfu",
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
      "viewer.msg.recovering",
      frameOverlay,
      state,
    );
  }
  if (state.media) {
    return presentation(
      "receiving",
      "viewer.msg.receiving",
      frameOverlay,
      state,
    );
  }
  if (state.route?.phase === "prepare") {
    return presentation(
      state.route.kind === "sfu" ? "preparing-sfu" : "preparing-p2p",
      state.route.kind === "sfu" ? "viewer.msg.preparingSfu" : "viewer.msg.preparingP2p",
      frameOverlay,
      state,
    );
  }
  if (state.host === "stopped" || state.host === "unknown") {
    return presentation(
      "waiting-host",
      "viewer.msg.waitingHost",
      frameOverlay,
      state,
    );
  }
  if (state.host === "offline") {
    return presentation(
      "host-offline",
      "viewer.msg.hostOffline",
      frameOverlay,
      state,
    );
  }
  if (state.route?.kind === "p2p") {
    return presentation(
      "preparing-p2p",
      "viewer.msg.preparingP2p",
      frameOverlay,
      state,
    );
  }
  if (state.route?.kind === "sfu") {
    return presentation(
      "preparing-sfu",
      "viewer.msg.preparingSfu",
      frameOverlay,
      state,
    );
  }
  return presentation(
    "allocating",
    "viewer.msg.allocating",
    frameOverlay,
    state,
  );
}

export function viewerFailureFromServerCode(
  code: Extract<ServerMessage, { type: "error" }>["code"],
): ViewerFailureCode | null {
  switch (code) {
    case "ROOM_NOT_FOUND":
      return "ROOM_NOT_FOUND";
    case "ROOM_ACCESS_DENIED":
      return "ROOM_ACCESS_DENIED";
    case "INVALID_TOKEN":
    case "AUTH_REQUIRED":
      return "INVALID_TOKEN";
    case "ROOM_EXPIRED":
      return "ROOM_EXPIRED";
    case "ROOM_FULL":
      return "ROOM_FULL";
    case "SERVER_ERROR":
      return "SERVER_ERROR";
    default:
      return null;
  }
}

function hasCurrentFrame(state: ViewerPresentationState): boolean {
  return state.media?.framePresented === true;
}

function presentation(
  stage: ViewerStage,
  messageKey: ViewerMessageKey,
  overlay: ViewerPresentation["overlay"],
  state: ViewerPresentationState,
): ViewerPresentation {
  return {
    stage,
    messageKey,
    noticeKey: null,
    overlay,
    hasCurrentFrame: hasCurrentFrame(state),
    hasRetainedFrame: state.retainedFrame,
    failureCode: state.failure,
    connectionState:
      state.connection === "idle"
        ? state.host === "online" || state.host === "paused"
          ? "routing"
          : "waiting"
        : state.connection,
  };
}
