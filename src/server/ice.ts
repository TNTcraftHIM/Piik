import type { WireIceConfig } from "../shared/protocol.js";

export interface IceConfigOptions {
  stunUrls: readonly string[];
  natPredictionEnabled: boolean;
}

const NAT_PREDICTION_BASE_PORT = 3478;
const NAT_PREDICTION_AUXILIARY_PORTS = [3479, 3480] as const;

export function natPredictionStunUrls(
  stunUrls: readonly string[],
): string[] {
  for (const stunUrl of stunUrls) {
    const authorityText = stunUrl.slice(stunUrl.indexOf(":") + 1);
    let authority: URL;
    try {
      authority = new URL(`http://${authorityText}`);
    } catch {
      continue;
    }
    const port = authority.port
      ? Number(authority.port)
      : NAT_PREDICTION_BASE_PORT;
    if (port !== NAT_PREDICTION_BASE_PORT) {
      continue;
    }
    const hostname = authority.hostname.startsWith("[")
      ? authority.hostname
      : authority.hostname.includes(":")
        ? `[${authority.hostname}]`
        : authority.hostname;
    return NAT_PREDICTION_AUXILIARY_PORTS.map(
      (auxiliaryPort) => `stun:${hostname}:${auxiliaryPort}`,
    );
  }
  return [];
}

export function createIceConfig(options: IceConfigOptions): WireIceConfig {
  return {
    iceServers:
      options.stunUrls.length > 0 ? [{ urls: [...options.stunUrls] }] : [],
    natPredictionStunUrls: options.natPredictionEnabled
      ? natPredictionStunUrls(options.stunUrls)
      : [],
  };
}
