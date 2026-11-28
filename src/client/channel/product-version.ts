import { z } from "zod";
import developmentVersion from "../../../prototype/channel-core/development-version.json" with { type: "json" };

export const productVersionSchema = z.object({ major: z.uint32(), minor: z.uint32() });
export type ProductVersion = z.infer<typeof productVersionSchema>;

declare const __PIIK_PRODUCT_VERSION__: ProductVersion;
export const PRODUCT_VERSION: ProductVersion =
  typeof __PIIK_PRODUCT_VERSION__ === "undefined" ? developmentVersion : __PIIK_PRODUCT_VERSION__;
