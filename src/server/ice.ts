import type { WireIceConfig } from "../shared/protocol.js";

export interface IceConfigOptions {
  stunUrls: readonly string[];
  natPredictionStunUrls?: readonly string[];
}

export function createIceConfig(options: IceConfigOptions): WireIceConfig {
  return {
    iceServers:
      options.stunUrls.length > 0 ? [{ urls: [...options.stunUrls] }] : [],
    natPredictionStunUrls: [...(options.natPredictionStunUrls ?? [])],
  };
}
