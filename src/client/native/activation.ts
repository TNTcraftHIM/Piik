// Platform actions only foreground Piik. App-owned pending requests still own
// permission, and the normal loopback approval/health checks own Site access.
export function nativeAppActivationURL(action: unknown, userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints): string | null {
  if (action !== "piik://app" && action !== "piik://media") return null;
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && (touchPoints > 1 || /Mobile\//.test(userAgent)))) return action;
  // A connected App supplies its own media action. Android tablets can report
  // a desktop UA; only an unconnected cold wake needs the browser OS hint.
  if (action === "piik://app" && !/Android/i.test(userAgent)) return null;
  return `intent://${action.slice("piik://".length)}#Intent;scheme=piik;package=tv.piik.android;end`;
}

// Called only after the pending picker request has been sent. A browser may
// decline the handoff; the existing confirmation control remains available.
export function activateNativePicker(action: unknown): void {
  const intent = nativeAppActivationURL(action);
  if (!intent || !navigator.userActivation?.isActive) return;
  try { window.location.assign(intent); } catch { /* Continue with manual confirmation. */ }
}
