/**
 * Obsidian `[[wikilink]]` scanner.
 *
 * Finds the same links as /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g: "[[", a link of one or
 * more characters other than "]" and "|", an optional "|display" without "]", then "]]".
 * A "[[" right after "!" is an embed, not a wikilink. The scan is linear in the text length;
 * the regular expression backtracks polynomially on input such as "[[[[[[...".
 */

export interface Wikilink {
  /** Index of the opening "[[". */
  start: number;
  /** Index after the closing "]]". */
  end: number;
  link: string;
  /** Text after "|", or undefined when there is no "|". */
  display: string | undefined;
}

/** Outcome of reading a wikilink at one "[[": the link, or where the next candidate can start. */
type ScanResult = { link: Wikilink } | { resumeAt: number };

/**
 * `indexOf(char, from)` that reuses its last answer while it is still the first match at or
 * after `from`. Positions only grow during a scan, so the text is searched about once.
 */
function indexFinder(text: string, char: string): (from: number) => number {
  let searchedFrom = Number.POSITIVE_INFINITY;
  let found = -1;
  return (from) => {
    const reusable = from >= searchedFrom && (found === -1 || found >= from);
    if (!reusable) {
      found = text.indexOf(char, from);
      searchedFrom = from;
    }
    return found;
  };
}

interface Scanner {
  text: string;
  nextClose: (from: number) => number;
  nextPipe: (from: number) => number;
}

/** `index`, or the text length when `index` is -1 (not found). */
function orEnd(index: number, text: string): number {
  return index === -1 ? text.length : index;
}

/**
 * Read the wikilink whose "[[" is at `start`. Each "[[" between `start` and the index where a
 * failed scan stopped would fail the same way, so the search resumes there.
 */
function scanAt(scanner: Scanner, start: number): ScanResult {
  const { text } = scanner;
  if (start > 0 && text.charAt(start - 1) === "!") return { resumeAt: start + 1 };
  const linkStart = start + 2;
  const pipe = scanner.nextPipe(linkStart);
  const linkEnd = Math.min(orEnd(scanner.nextClose(linkStart), text), orEnd(pipe, text));
  if (linkEnd === linkStart) return { resumeAt: start + 1 };
  const link = text.slice(linkStart, linkEnd);
  if (linkEnd !== pipe) {
    return text.startsWith("]]", linkEnd)
      ? { link: { start, end: linkEnd + 2, link, display: undefined } }
      : { resumeAt: linkEnd };
  }
  const displayEnd = orEnd(scanner.nextClose(pipe + 1), text);
  if (!text.startsWith("]]", displayEnd)) return { resumeAt: displayEnd };
  const display = text.slice(pipe + 1, displayEnd);
  return { link: { start, end: displayEnd + 2, link, display } };
}

/** Find every wikilink in `text`, left to right, without overlaps. */
export function findWikilinks(text: string): Wikilink[] {
  const links: Wikilink[] = [];
  const scanner: Scanner = {
    text,
    nextClose: indexFinder(text, "]"),
    nextPipe: indexFinder(text, "|"),
  };

  let start = text.indexOf("[[");
  while (start !== -1) {
    const scanned = scanAt(scanner, start);
    let resumeAt: number;
    if ("link" in scanned) {
      links.push(scanned.link);
      resumeAt = scanned.link.end;
    } else {
      resumeAt = scanned.resumeAt;
    }
    start = text.indexOf("[[", resumeAt);
  }
  return links;
}

/** Replace each wikilink in `text` with `replace(link)`. */
export function replaceWikilinks(text: string, replace: (link: Wikilink) => string): string {
  let out = "";
  let last = 0;
  for (const link of findWikilinks(text)) {
    out += text.slice(last, link.start) + replace(link);
    last = link.end;
  }
  return out + text.slice(last);
}
