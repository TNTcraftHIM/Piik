import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  reduceViewerPresentation,
  type ViewerFailureCode,
  type ViewerPresentationAction,
  type ViewerPresentationState,
} from "../media/viewer-presentation";
import type { deriveHostStatus } from "../ui/media-status";

export interface StatusScenario {
  id: string;
  name: string;
  note: string;
  state: ViewerPresentationState;
}

const ready: ViewerPresentationAction[] = [
  { type: "access", access: "ready" },
  { type: "signal", signal: "connected" },
  { type: "host", host: "online" },
];
const receiving: ViewerPresentationAction[] = [
  ...ready,
  { type: "route", revision: 1, phase: "active", kind: "p2p" },
  { type: "media-bound", generation: 1, revision: 1 },
  { type: "connection", revision: 1, connection: "connected" },
];
const playing: ViewerPresentationAction[] = [
  ...receiving,
  { type: "frame-presented", generation: 1, proofEpoch: 0, revision: 1 },
];

function scenario(
  id: string,
  name: string,
  note: string,
  actions: ViewerPresentationAction[],
): StatusScenario {
  return {
    id, name, note,
    state: actions.reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE),
  };
}

const denied: [ViewerFailureCode, string][] = [
  ["ROOM_NOT_FOUND", "房间不存在"],
  ["ROOM_ACCESS_DENIED", "没有准入权限"],
  ["INVALID_TOKEN", "邀请无效"],
  ["ROOM_CLOSED", "房间已结束"],
  ["ROOM_FULL", "房间已满"],
  ["STALE_CLIENT", "页面版本已过期"],
  ["SESSION_REPLACED", "被另一个页面接管"],
  ["SIGNAL_TERMINATED", "会话已结束"],
  ["SERVER_ERROR", "服务不可用"],
];

export const STATUS_SCENARIOS: readonly StatusScenario[] = [
  scenario("playing", "正常观看", "已呈现当前连接的画面；逐连接测量留在详情中。", playing),
  scenario("background", "切到后台后回来", "重新武装帧观察，保留之前的播放证明；页面可见性本身不是播放故障。", [
    ...playing, { type: "frame-proof-rearm", generation: 1 },
  ]),
  scenario("signal-recovering", "信令断开，画面仍在播放", "控制连接正在恢复；媒体仍有当前画面，标题保留观看状态。", [
    ...playing, { type: "signal", signal: "reconnecting" },
  ]),
  scenario("host-offline-playing", "房主离线，仍有当前画面", "房主在线状态和正在接收的媒体不是同一件事；先给提示，不直接覆盖画面。", [
    ...playing, { type: "host", host: "offline" },
  ]),
  scenario("joining", "正在加入房间", "尚未完成准入；不能把 WebSocket 连通当成视频已播放。", []),
  scenario("preparing-p2p", "首次 P2P 连接", "已经准入，正在建立直连；等待首个有效画面。", [
    ...ready, { type: "route", revision: 1, phase: "prepare", kind: "p2p" },
  ]),
  scenario("preparing-sfu", "首次 SFU 连接", "正在建立服务器媒体线路；与直连使用同一播放证明。", [
    ...ready, { type: "route", revision: 1, phase: "prepare", kind: "sfu" },
  ]),
  scenario("waiting-sfu", "等待 SFU 线路", "服务端分配尚未完成；显示等待，不显示断线。", [
    ...ready, { type: "route-status", revision: 1, state: "waiting" },
  ]),
  scenario("allocating", "正在分配线路", "房主在线，但还没有确定的媒体上游。", ready),
  scenario("receiving", "已连接，等待首帧", "连接就绪还不够；解码并呈现首帧以后才进入观看。", receiving),
  scenario("needs-play", "需要点击播放", "浏览器阻止了自动播放；画面上的按钮是真正可操作的。", [
    ...receiving, { type: "autoplay-blocked", generation: 1, revision: 1 },
  ]),
  scenario("paused", "房主暂停", "主动暂停与连接失败分开；保留最后画面。", [
    ...playing, { type: "host", host: "paused" },
  ]),
  scenario("recovering", "媒体恢复，保留最后画面", "当前帧证明失效，但有最后画面可保留；真实新帧才能清掉恢复状态。", [
    ...playing,
    { type: "frame-proof-reset", generation: 1, revision: 1 },
    { type: "connection", revision: 1, connection: "reconnecting" },
  ]),
  scenario("route-failed", "媒体线路已失败", "权威线路失败；最后画面只是留存，不冒充正在播放。", [
    ...playing, { type: "route-status", revision: 1, state: "failed" },
  ]),
  scenario("playback-failed", "浏览器播放失败", "连接存在，但播放器无法呈现画面。", [
    ...receiving, { type: "playback-failed", generation: 1, revision: 1 },
  ]),
  scenario("waiting-host", "等待房主开始分享", "房间存在，当前没有共享源。", [{ type: "access", access: "ready" }]),
  scenario("host-offline", "房主离线，没有画面", "没有当前或留存画面，说明房主离线。", [
    ...ready, { type: "host", host: "offline" },
  ]),
  scenario("stopped", "分享已经停止", "正常结束，不伪装为正在恢复或播放失败。", [...playing, { type: "sharing-stopped" }]),
  ...denied.map(([failure, name]) => scenario(failure.toLowerCase(), name,
    "服务端准入或会话终止事实优先；旧画面和旧质量样本不能重新覆盖这个状态。",
    [{ type: "access", access: "denied", failure }])),
];

export const HOST_STATUS_SCENARIOS: readonly {
  name: string;
  facts: Parameters<typeof deriveHostStatus>[0];
}[] = [
  { name: "待机", facts: { phase: "idle", paused: false, signal: "connected", roomReady: false } },
  { name: "房间已就绪", facts: { phase: "idle", paused: false, signal: "connected", roomReady: true } },
  { name: "正在启动", facts: { phase: "starting", paused: false, signal: "connected", roomReady: true } },
  { name: "正在分享", facts: { phase: "live", paused: false, signal: "connected", roomReady: true } },
  { name: "主动暂停", facts: { phase: "live", paused: true, signal: "connected", roomReady: true } },
  { name: "分享结束", facts: { phase: "ended", paused: false, signal: "connected", roomReady: true } },
  { name: "启动失败", facts: { phase: "error", paused: false, signal: "connected", roomReady: true } },
  { name: "分享中，信令恢复", facts: { phase: "live", paused: false, signal: "reconnecting", roomReady: true } },
];
