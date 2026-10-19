// Each language opens with a bold title and one plain description paragraph.
// Published title-only pairs remain readable; ordinary release prose is not a headline.
const gap = String.raw`[ \t]*\r?\n(?:[ \t]*\r?\n)+`;
const title = String.raw`\*\*([^*\r\n]+)\*\*`;
const description = String.raw`([^*#<>\r\n]+)`;
const end = `(?:${gap}|[ \\t]*$)`;
const explainedOpening = new RegExp(`^\\s*${title}${gap}${description}${gap}${title}${gap}${description}${end}`);
const titleOpening = new RegExp(`^\\s*${title}${gap}${title}${end}`);

export function splitReleaseHeadline(body) {
  if (typeof body !== "string") return { headline: null, notes: "" };
  const explained = explainedOpening.exec(body);
  const opening = explained ?? titleOpening.exec(body);
  if (!opening || opening.slice(1).some(text => !text.trim())) return { headline: null, notes: body };
  return {
    headline: explained ? {
      en: { title: opening[1].trim(), description: opening[2].trim() },
      "zh-CN": { title: opening[3].trim(), description: opening[4].trim() },
    } : {
      en: { title: opening[1].trim(), description: "" },
      "zh-CN": { title: opening[2].trim(), description: "" },
    },
    notes: body.slice(opening[0].length).trimStart(),
  };
}
