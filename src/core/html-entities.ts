/** Character references in text taken from HTML. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decode character references (`&amp;`, `&#8212;`, `&#x2014;`) in text taken from HTML, e.g. a title. */
export function decodeHtmlEntities(text: string): string {
  return text.replaceAll(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, ref: string) => {
    if (!ref.startsWith("#")) return NAMED_ENTITIES[ref.toLowerCase()] ?? entity;
    const hex = ref[1] === "x" || ref[1] === "X";
    const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
