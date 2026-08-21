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
    ? "本次分享的编码已锁定，停止分享后可修改"
    : null;
}

export function screenAudioQualityLockNotice(phase: string): string | null {
  return phase === "starting" || phase === "live"
    ? "本次分享的音频质量已锁定，停止分享后可修改"
    : null;
}
