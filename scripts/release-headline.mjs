// The release editor owns two leading bold paragraphs: Chinese, then English.
// Read only that pair; older release prose is not an inferred headline.
export function splitReleaseHeadline(body) {
  if (typeof body !== "string") return { headline: null, notes: "" };
  const opening = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?\n(?:[ \t]*\r?\n)+\*\*([^*\r\n]+)\*\*(?:[ \t]*\r?\n(?:[ \t]*\r?\n)+|[ \t]*$)/.exec(body);
  if (!opening || !opening[1].trim() || !opening[2].trim()) return { headline: null, notes: body };
  return {
    headline: { "zh-CN": opening[1].trim(), en: opening[2].trim() },
    notes: body.slice(opening[0].length).trimStart(),
  };
}
