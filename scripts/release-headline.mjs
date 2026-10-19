// The release editor owns two leading bold paragraphs: English, then Chinese.
// Read only that pair; older release prose is not an inferred headline.
export function splitReleaseHeadline(body) {
  if (typeof body !== "string") return { headline: null, notes: "" };
  const opening = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?\n(?:[ \t]*\r?\n)+\*\*([^*\r\n]+)\*\*(?:[ \t]*\r?\n(?:[ \t]*\r?\n)+|[ \t]*$)/.exec(body);
  if (!opening || !opening[1].trim() || !opening[2].trim()) return { headline: null, notes: body };
  return {
    headline: { en: opening[1].trim(), "zh-CN": opening[2].trim() },
    notes: body.slice(opening[0].length).trimStart(),
  };
}
