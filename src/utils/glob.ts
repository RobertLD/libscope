const REGEX_SPECIAL = new Set([".", "+", "^", "$", "(", ")", "|", "[", "]", "\\", "{", "}"]);

/**
 * Convert a glob to an anchored RegExp that matches `/`-separated relative paths.
 *
 * Supports `**` (any depth; `**\/` also matches zero directories), `*` (within one
 * path segment), `?` (one character), and non-nested `{a,b}` alternation.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let inBraces = false;

  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      i++;
      if (glob.charAt(i + 1) === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "{" && !inBraces) {
      inBraces = true;
      source += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      source += ")";
    } else if (c === "," && inBraces) {
      source += "|";
    } else {
      source += REGEX_SPECIAL.has(c) ? `\\${c}` : c;
    }
  }
  if (inBraces) source += ")";

  return new RegExp(`^${source}$`);
}

/** Normalize a platform path to `/` separators so it can be matched by {@link globToRegExp}. */
export function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}
