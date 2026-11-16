import { z } from "zod";

export const watchFormatSchema = z.enum(["file", "hls"]);
export type WatchFormat = z.infer<typeof watchFormatSchema>;
