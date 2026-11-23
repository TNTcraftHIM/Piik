export const peerTubeOrigin = "https://peertube.tv";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const shortId = /^[1-9A-HJ-NP-Za-km-z]{22}$/;

export function peerTubeId(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== peerTubeOrigin || url.username || url.password || url.href !== peerTubeOrigin + url.pathname) return null;
  const path = url.pathname;
  const id = path.split("/").at(-1) ?? "";
  if (uuid.test(id) && (path === "/videos/watch/" + id || path === "/videos/embed/" + id)) return id;
  return shortId.test(id) && path === "/w/" + id ? id : null;
}
export function peerTubeSourceId(source: { kind: string; url: string }): string | null {
  const id = peerTubeId(source.url);
  return source.kind === "website" && id && source.url === peerTubeOrigin + "/videos/embed/" + id ? id : null;
}
export async function publicPeerTubeURL(id: string, signal: AbortSignal): Promise<string> {
  const result = await fetch(peerTubeOrigin + "/api/v1/videos/" + encodeURIComponent(id), {
    credentials: "omit", redirect: "error", signal,
  });
  if (!result.ok) throw new Error("watch_media_unavailable");
  const video = await result.json();
  if (typeof video.uuid !== "string" || !uuid.test(video.uuid) || (id !== video.uuid && id !== video.shortUUID)
    || video.privacy?.id !== 1 || video.isLive !== false) throw new Error("watch_media_unavailable");
  return peerTubeOrigin + "/videos/embed/" + video.uuid;
}
