import { iceConfigSchema, type IceConfig } from "../../shared/protocol";

export type ConnectionProbeStatus = "passed" | "failed" | "unknown";

export interface ConnectionProbeResult {
  status: ConnectionProbeStatus;
  detail: string;
}

export interface ConnectionSelfCheckResult {
  site: ConnectionProbeResult;
  signaling: ConnectionProbeResult;
  stun: ConnectionProbeResult;
  sfu: ConnectionProbeResult;
}

interface SelfCheckConfig {
  iceConfig: IceConfig;
  sfuConfigured: boolean;
}

interface ConnectionSelfCheckOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  peerFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const passed = (detail: string): ConnectionProbeResult => ({
  status: "passed",
  detail,
});
const failed = (detail: string): ConnectionProbeResult => ({
  status: "failed",
  detail,
});
const unknown = (detail: string): ConnectionProbeResult => ({
  status: "unknown",
  detail,
});
const cancelled = () => failed("自检已取消");

function cancelledCheck(): ConnectionSelfCheckResult {
  return {
    site: cancelled(),
    signaling: cancelled(),
    stun: cancelled(),
    sfu: unknown("配置状态未知"),
  };
}

async function readSelfCheckConfig(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<SelfCheckConfig> {
  const response = await fetcher("/api/connection-self-check", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("self-check config unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") {
    throw new Error("invalid self-check config");
  }
  const record = value as Record<string, unknown>;
  const iceConfig = iceConfigSchema.safeParse(record.iceConfig);
  if (!iceConfig.success || typeof record.sfuConfigured !== "boolean") {
    throw new Error("invalid self-check config");
  }
  return { iceConfig: iceConfig.data, sfuConfigured: record.sfuConfigured };
}

async function probeSite(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<ConnectionProbeResult> {
  try {
    const response = await fetcher("/healthz", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    const body: unknown = await response.json();
    return response.ok &&
      !!body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).status === "ok"
      ? passed("站点健康")
      : failed("站点健康检查失败");
  } catch {
    return failed("站点不可达");
  }
}

function probeSignaling(
  url: string,
  socketFactory: (url: string) => WebSocket,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ConnectionProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ConnectionProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const activeSocket = socket;
      socket = null;
      activeSocket?.close(1000, "self-check");
      resolve(result);
    };
    const onAbort = () => finish(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => finish(failed("WSS 握手超时")), timeoutMs);
    try {
      const createdSocket = socketFactory(url);
      if (settled) {
        createdSocket.close(1000, "self-check");
        return;
      }
      socket = createdSocket;
      socket.addEventListener("open", () => finish(passed("WSS 可达")), {
        once: true,
      });
      socket.addEventListener("error", () => finish(failed("WSS 不可达")), {
        once: true,
      });
      socket.addEventListener("close", () => finish(failed("WSS 不可达")), {
        once: true,
      });
    } catch {
      finish(failed("WSS 不可达"));
    }
  });
}

function probeStun(
  iceConfig: IceConfig,
  peerFactory: (configuration: RTCConfiguration) => RTCPeerConnection,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ConnectionProbeResult> {
  if (signal.aborted) {
    return Promise.resolve(cancelled());
  }
  if (iceConfig.iceServers.length === 0) {
    return Promise.resolve(unknown("当前未配置 STUN"));
  }
  return new Promise((resolve) => {
    let settled = false;
    let peer: RTCPeerConnection | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ConnectionProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const activePeer = peer;
      peer = null;
      activePeer?.close();
      resolve(result);
    };
    const onAbort = () => finish(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(
      () => finish(failed("未获得 STUN 候选")),
      timeoutMs,
    );
    try {
      const createdPeer = peerFactory({ iceServers: iceConfig.iceServers });
      if (settled) {
        createdPeer.close();
        return;
      }
      peer = createdPeer;
      peer.addEventListener("icecandidate", (event) => {
        if (event.candidate?.type === "srflx") {
          finish(passed("已获得 srflx 候选"));
        }
      });
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer?.iceGatheringState === "complete") {
          finish(failed("未获得 STUN 候选"));
        }
      });
      peer.createDataChannel("self-check");
      void peer
        .createOffer()
        .then((offer) => peer?.setLocalDescription(offer))
        .catch(() => finish(failed("STUN 自检失败")));
    } catch {
      finish(failed("浏览器无法启动 STUN 自检"));
    }
  });
}

export async function runConnectionSelfCheck(
  options: ConnectionSelfCheckOptions = {},
): Promise<ConnectionSelfCheckResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const lifecycleSignal = options.signal ?? new AbortController().signal;
  const requestSignal = options.signal
    ? AbortSignal.any([lifecycleSignal, timeoutSignal])
    : timeoutSignal;
  if (lifecycleSignal.aborted) return cancelledCheck();
  const signalUrl = new URL("/signal", options.baseUrl ?? window.location.href);
  signalUrl.protocol = signalUrl.protocol === "https:" ? "wss:" : "ws:";
  const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  const peerFactory =
    options.peerFactory ?? ((configuration) => new RTCPeerConnection(configuration));

  const [site, signaling, config] = await Promise.all([
    probeSite(fetcher, requestSignal),
    probeSignaling(
      signalUrl.toString(),
      socketFactory,
      lifecycleSignal,
      timeoutMs,
    ),
    readSelfCheckConfig(fetcher, requestSignal).catch(() => null),
  ]);
  if (lifecycleSignal.aborted) {
    return { ...cancelledCheck(), site, signaling };
  }
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  const stun = config && remainingMs > 0
    ? await probeStun(
        config.iceConfig,
        peerFactory,
        lifecycleSignal,
        remainingMs,
      )
    : config
      ? failed("未获得 STUN 候选")
    : failed("STUN 配置不可用");
  return {
    site,
    signaling,
    stun,
    sfu: !config
      ? unknown("配置状态未知")
      : config.sfuConfigured
        ? unknown("已配置，需实际路由验证")
        : unknown("当前未配置"),
  };
}
