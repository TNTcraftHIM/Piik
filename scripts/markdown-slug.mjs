// Repository links and the generated documentation use the same heading IDs.
export function githubSlug(heading) {
  return decodeHtmlEntities(heading)
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/giu, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()];
    const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}
