import { en, enTitleFrames } from "./en";
import { visualTitleFrames } from "./visual";
import {
  zh,
  zhTitleFrames,
  type TitleFrameCatalog,
} from "./zh";

export type { CopyKey, TitleFrameKey } from "./zh";

// Register contributed locales here; UI consumers stay catalog-agnostic.
export const catalogs = { zh, en };
export type Lang = keyof typeof catalogs;

export const titleFrameCatalogs: Record<Lang, TitleFrameCatalog> = {
  zh: zhTitleFrames,
  en: enTitleFrames,
};

export { visualTitleFrames };
