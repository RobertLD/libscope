/** Decoding of HTML character references in text taken from raw HTML. */

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
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

/**
 * Decode HTML character references in text taken from raw HTML (for example a page title):
 * numeric references (`&#8212;`, `&#x2014;`) and common named ones (`&amp;`, `&mdash;`).
 * Unknown or invalid references are kept as they are.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replaceAll(
    /&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{2,8});/gi,
    (ref: string, body: string) => {
      if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? ref;
      const hex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (codePoint === 0 || codePoint > 0x10ffff) return ref;
      return String.fromCodePoint(codePoint);
    },
  );
}
