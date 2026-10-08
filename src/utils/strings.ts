/** String helpers that avoid backtracking regular expressions. */

/** `value` without trailing "/" characters ("https://x.org//" -> "https://x.org"). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end--;
  return value.slice(0, end);
}
