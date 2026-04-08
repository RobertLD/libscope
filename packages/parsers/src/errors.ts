/** Standalone error class for @libscope/parsers. No cross-package dependencies. */
export class ParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ParseError";
    this.cause = cause;
  }
}
