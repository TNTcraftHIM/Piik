import { z } from "zod";

export const watchFormatSchema = z.enum(["file", "hls", "dash"]);
export type WatchFormat = z.infer<typeof watchFormatSchema>;

/** A direct media link chosen by the user. Other URLs still need format discovery. */
export function directWatchFormat(url: URL): "file" | "hls" | undefined {
  if (/\.m3u8$/i.test(url.pathname)) return "hls";
  if (/\.(?:mp4|webm|ogv)$/i.test(url.pathname)) return "file";
  return undefined;
}
