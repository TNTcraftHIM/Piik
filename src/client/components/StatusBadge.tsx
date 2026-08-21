import { CircleAlert, Network, Radio, Server, Wifi, WifiOff } from "lucide-react";
import type {
  MediaPath,
  SignalConnectionState,
} from "../types";
import { MEDIA_ROUTE_PRESENTATION, ROUTING_STATUS_PRESENTATION } from "./status-badge-model";

interface BadgeProps {
  tone: "good" | "warning" | "danger" | "neutral";
  label: string;
  title?: string;
}

function Badge({ tone, label, title }: BadgeProps) {
  return (
    <span className={`status-badge status-${tone}`} title={title}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function SignalStatusBadge({
  state,
}: {
  state: SignalConnectionState;
}) {
  const values: Record<SignalConnectionState, BadgeProps> = {
    connecting: { tone: "neutral", label: "正在连接" },
    connected: { tone: "good", label: "信令在线" },
    reconnecting: { tone: "warning", label: "正在恢复" },
    offline: { tone: "neutral", label: "信令离线" },
  };
  return <Badge {...values[state]} />;
}

export function PeerStatusBadge({
  state,
}: {
  state: RTCPeerConnectionState | "reconnecting" | "waiting" | "routing";
}) {
  const labels: Record<
    RTCPeerConnectionState | "reconnecting" | "waiting" | "routing",
    BadgeProps
  > = {
    waiting: { tone: "neutral", label: "等待开始分享" },
    reconnecting: { tone: "warning", label: "正在恢复" },
    routing: ROUTING_STATUS_PRESENTATION,
    new: { tone: "neutral", label: "准备中" },
    connecting: { tone: "neutral", label: "正在连接" },
    connected: { tone: "good", label: "已连接" },
    disconnected: { tone: "warning", label: "连接中断" },
    failed: { tone: "danger", label: "连接失败" },
    closed: { tone: "neutral", label: "已关闭" },
  };
  return <Badge {...labels[state]} />;
}

export function PathBadge({ path }: { path: MediaPath }) {
  if (path === "direct") {
    return (
      <span className="path-badge path-direct" title="ICE 直连成功">
        <Wifi size={14} aria-hidden="true" />
        ICE 直连
      </span>
    );
  }
  if (path === "relay") {
    return (
      <span className="path-badge path-relay" title="此连接正在使用 TURN 中继">
        <Radio size={14} aria-hidden="true" />
        TURN 传输
      </span>
    );
  }
  return (
    <span className="path-badge path-unknown" title="尚未选出可用的 ICE 路径">
      <WifiOff size={14} aria-hidden="true" />
      ICE 未知
    </span>
  );
}

export function MediaRouteBadge({ route }: { route: "p2p" | "sfu" }) {
  const presentation = MEDIA_ROUTE_PRESENTATION[route];
  const Icon = presentation.icon === "network" ? Network : Server;
  return (
    <span
      className={`status-badge status-${presentation.tone}`}
      title="当前媒体路径"
    >
      <Icon size={14} aria-hidden="true" />
      {presentation.label}
    </span>
  );
}
export function WarningBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice notice-warning" role="status">
      <CircleAlert size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
