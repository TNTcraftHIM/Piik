import type { RoomConnectOptions } from "livekit-client";

export function sfuRoomConnectOptions(): RoomConnectOptions {
  return {
    autoSubscribe: false,
    rtcConfig: { iceServers: [] },
  };
}
