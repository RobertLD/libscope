const REGEX_SPECIAL = new Set([".", "+", "^", "$", "(", ")", "|", "[", "]", "\\", "{", "}"]);

/** Regex source for the `*` at `glob[i]` (`*`, `**` or `**\/`) and how many characters it used. */
function starSource(glob: string, i: number): [source: string, length: number] {
  if (glob.charAt(i + 1) !== "*") return ["[^/]*", 1];
  return glob.charAt(i + 2) === "/" ? ["(?:.*/)?", 3] : [".*", 2];
}

/** Regex source for any other glob character; `{`, `,` and `}` are special only as braces. */
function charSource(c: string, inBraces: boolean): string {
  if (c === "?") return "[^/]";
  if (c === "{" && !inBraces) return "(?:";
  if (c === "}" && inBraces) return ")";
  if (c === "," && inBraces) return "|";
  return REGEX_SPECIAL.has(c) ? `\\${c}` : c;
}

/**
 * Convert a glob to an anchored RegExp that matches `/`-separated relative paths.
 *
 * Supports `**` (any depth; `**\/` also matches zero directories), `*` (within one
 * path segment), `?` (one character), and non-nested `{a,b}` alternation.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let inBraces = false;
  let i = 0;

  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      const [part, length] = starSource(glob, i);
      source += part;
      i += length;
    } else {
      source += charSource(c, inBraces);
      if (c === "{" || c === "}") inBraces = c === "{";
      i++;
    }
  }
  if (inBraces) source += ")";

  return new RegExp(`^${source}$`);
}

/** Normalize a platform path to `/` separators so it can be matched by {@link globToRegExp}. */
export function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}
