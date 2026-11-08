export interface ReleaseHeadlineText {
  title: string;
  description: string;
}

export interface ReleaseHeadline {
  en: ReleaseHeadlineText;
  "zh-CN": ReleaseHeadlineText;
}

export function splitReleaseHeadline(body: unknown): { headline: ReleaseHeadline | null; notes: string };
