// A media failure is a fact, not copy: transport layers record what failed and
// the UI resolves it during render, so switching language re-renders instead of
// leaving stale text until the next media event.
import {
  joinItems,
  joinSentences,
  type Copy,
  type CopyKey,
} from "./copy";

export interface MediaFailure {
  key: CopyKey;
  /** Copy keys locale-joined into the template's `{params}` slot. */
  paramKeys?: readonly CopyKey[];
  /** Literal template substitutions. */
  vars?: Record<string, string>;
}

export function resolveMediaFailure(
  failure: MediaFailure | MediaFailure[] | null | undefined,
  copy: Pick<Copy, "lang" | "t">,
): string | null {
  if (!failure) {
    return null;
  }
  const entries = Array.isArray(failure) ? failure : [failure];
  if (entries.length === 0) {
    return null;
  }
  const parts = entries.map((entry) =>
    copy.t(entry.key, {
      ...entry.vars,
      ...(entry.paramKeys
        ? {
            params: joinItems(
              copy.lang,
              entry.paramKeys.map((key) => copy.t(key)),
            ),
          }
        : {}),
    }),
  );
  return parts.length === 1
    ? parts[0]!
    : joinSentences(copy.lang, parts);
}
