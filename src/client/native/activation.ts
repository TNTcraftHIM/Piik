// Android intents only foreground Piik. App-owned pending requests still own
// permission, and the normal loopback approval/health checks own Site access.
export function androidAppIntent(action: unknown, userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  if (!/Android/i.test(userAgent) || (action !== "piik://app" && action !== "piik://media")) return null;
  return `intent://${action.slice("piik://".length)}#Intent;scheme=piik;package=tv.piik.android;end`;
}
