/** Markdown text helpers that avoid backtracking regular expressions. */

const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);
const WHITESPACE = /^\s$/;

function isLineTerminator(char: string): boolean {
  return LINE_TERMINATORS.has(char);
}

function isWhitespace(char: string): boolean {
  return WHITESPACE.test(char);
}

/** Index of the first line terminator at or after `from`, or the text length. */
function lineEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !isLineTerminator(text.charAt(end))) end++;
  return end;
}

/**
 * The heading text after the "#" at `hash` (the start of a line), or undefined when it is not
 * a heading. The whitespace after "#" may span lines, as `\s+` does.
 */
function headingAt(text: string, hash: number): string | undefined {
  let textStart = hash + 1;
  while (textStart < text.length && isWhitespace(text.charAt(textStart))) textStart++;
  if (textStart === hash + 1) return undefined;
  if (textStart < text.length) return text.slice(textStart, lineEnd(text, textStart));
  // Only whitespace up to the end: the heading is the last whitespace character that is not
  // a line terminator, if it is not the first character after "#".
  for (let i = text.length - 1; i > hash + 1; i--) {
    if (!isLineTerminator(text.charAt(i))) return text.charAt(i);
  }
  return undefined;
}

/**
 * First markdown heading: the same text as group 1 of /^#\s+(.+)$/m (not trimmed), or
 * undefined when there is none. Linear in the text length.
 */
export function firstMarkdownHeading(text: string): string | undefined {
  for (let hash = text.indexOf("#"); hash !== -1; hash = text.indexOf("#", hash + 1)) {
    const atLineStart = hash === 0 || isLineTerminator(text.charAt(hash - 1));
    const heading = atLineStart ? headingAt(text, hash) : undefined;
    if (heading !== undefined) return heading;
  }
  return undefined;
}
