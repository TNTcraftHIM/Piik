import type { IceConfig } from "../shared/protocol.js";

export interface IceConfigOptions {
  stunUrls: readonly string[];
}

export function createIceConfig(options: IceConfigOptions): IceConfig {
  return {
    iceServers:
      options.stunUrls.length > 0 ? [{ urls: [...options.stunUrls] }] : [],
  };
}
