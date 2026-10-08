import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import type PizZip from "pizzip";
import type { DocumentParser } from "./index.js";
import { ValidationError } from "../../errors.js";
import { decodeHtmlEntities } from "../html-entities.js";

/** Default limit for the uncompressed bytes read from one EPUB (the `indexing.maxDocumentSize` default). */
export const DEFAULT_EPUB_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const CONTAINER_PATH = "META-INF/container.xml";
const OPF_MEDIA_TYPE = "application/oebps-package+xml";
const CHAPTER_MEDIA_TYPES = new Set(["application/xhtml+xml", "image/svg+xml"]);
/** Elements whose text is not chapter content. */
const SKIPPED_ELEMENTS = new Set(["head", "script", "style"]);
const ZIP_STORE = "\x00\x00";
const ZIP_DEFLATE = "\x08\x00";

export interface EpubParserOptions {
  /** Largest total of uncompressed bytes read from the archive. Larger EPUBs are refused. */
  maxUncompressedBytes?: number | undefined;
}

/** Parses EPUB files: container.xml -> OPF package -> spine order -> XHTML chapter text. */
export class EpubParser implements DocumentParser {
  readonly extensions = [".epub"];
  private readonly maxUncompressedBytes: number;

  constructor(options: EpubParserOptions = {}) {
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_EPUB_MAX_UNCOMPRESSED_BYTES;
  }

  async parse(content: Buffer): Promise<string> {
    let PizZipCtor: typeof import("pizzip").default;
    try {
      const mod = await import("pizzip");
      PizZipCtor = mod.default;
    } catch (err) {
      throw new ValidationError(
        'EPUB parsing requires the "pizzip" package. Install it with: npm install pizzip',
        err,
      );
    }

    let zip: PizZip;
    try {
      zip = new PizZipCtor(content);
    } catch (err) {
      throw new ValidationError(
        `Invalid EPUB file: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const reader = new EntryReader(zip, this.maxUncompressedBytes);
    const container = reader.read(CONTAINER_PATH);
    if (container === undefined) {
      throw new ValidationError(`Invalid EPUB file: ${CONTAINER_PATH} is missing`);
    }
    const opfPath = findPackagePath(container);
    if (!opfPath) {
      throw new ValidationError(`Invalid EPUB file: ${CONTAINER_PATH} names no package document`);
    }
    const opf = reader.read(opfPath);
    if (opf === undefined) {
      throw new ValidationError(`Invalid EPUB file: package document "${opfPath}" is missing`);
    }

    const chapters: string[] = [];
    for (const path of chapterPaths(opf, opfPath)) {
      const xhtml = reader.read(path);
      if (xhtml === undefined) continue; // Skip spine items missing from the archive
      const text = chapterText(xhtml);
      if (text.length > 0) chapters.push(text);
    }

    if (chapters.length === 0) {
      throw new ValidationError("EPUB file contains no readable chapters");
    }
    return chapters.join("\n\n");
  }
}

/** Shape of PizZip's internal per-file data before the entry is decompressed. */
interface CompressedEntry {
  compressionMethod: string;
  uncompressedSize: number;
  getCompressedContent: () => unknown;
}

function isCompressedEntry(value: unknown): value is CompressedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Record<keyof CompressedEntry, unknown>>;
  return (
    typeof entry.compressionMethod === "string" &&
    typeof entry.uncompressedSize === "number" &&
    typeof entry.getCompressedContent === "function"
  );
}

/**
 * Reads archive entries with a shared budget of uncompressed bytes. Entries are inflated
 * here with a bounded output size instead of by PizZip, which inflates the whole entry
 * before it compares the size with the (untrusted) size in the zip header.
 */
class EntryReader {
  private remaining: number;

  constructor(
    private readonly zip: PizZip,
    private readonly maxBytes: number,
  ) {
    this.remaining = maxBytes;
  }

  /** The entry as UTF-8 text, or undefined if the archive has no such file. */
  read(path: string): string | undefined {
    const file = this.zip.file(path);
    if (!file) return undefined;
    // Before the first asText() call, PizZip keeps the still-compressed entry in `_data`.
    const entry: unknown = (file as unknown as { _data?: unknown })._data;
    if (!isCompressedEntry(entry)) {
      throw new ValidationError(`Invalid EPUB file: cannot read "${path}"`);
    }
    if (entry.uncompressedSize > this.remaining) throw this.tooLarge();
    const bytes = this.decompress(entry, path);
    if (bytes.length > this.remaining) throw this.tooLarge();
    this.remaining -= bytes.length;
    return bytes.toString("utf-8");
  }

  private decompress(entry: CompressedEntry, path: string): Buffer {
    const raw = entry.getCompressedContent();
    if (!(raw instanceof Uint8Array)) {
      throw new ValidationError(`Invalid EPUB file: cannot read "${path}"`);
    }
    const compressed = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (entry.compressionMethod === ZIP_STORE) return compressed;
    if (entry.compressionMethod !== ZIP_DEFLATE) {
      throw new ValidationError(`Invalid EPUB file: unsupported compression for "${path}"`);
    }
    try {
      return inflateRawSync(compressed, { maxOutputLength: Math.max(1, this.remaining) });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ERR_BUFFER_TOO_LARGE") {
        throw this.tooLarge();
      }
      throw new ValidationError(`Invalid EPUB file: cannot decompress "${path}"`, err);
    }
  }

  private tooLarge(): ValidationError {
    return new ValidationError(
      `EPUB file is too large: its content exceeds ${this.maxBytes} bytes uncompressed`,
    );
  }
}

/** The package document (OPF) path named by META-INF/container.xml. */
function findPackagePath(containerXml: string): string | undefined {
  let fallback: string | undefined;
  for (const token of scanXml(containerXml)) {
    if (token.kind === "text" || token.kind === "close" || token.name !== "rootfile") continue;
    const fullPath = token.attrs.get("full-path");
    if (!fullPath) continue;
    if (token.attrs.get("media-type") === OPF_MEDIA_TYPE) return fullPath;
    fallback ??= fullPath;
  }
  return fallback;
}

interface PackageDocument {
  manifest: Map<string, { href: string; mediaType: string }>;
  /** Manifest ids in reading order. */
  spine: string[];
}

function parsePackage(opfXml: string): PackageDocument {
  const doc: PackageDocument = { manifest: new Map(), spine: [] };
  for (const token of scanXml(opfXml)) {
    if (token.kind === "text" || token.kind === "close") continue;
    const { name, attrs } = token;
    const id = attrs.get("id");
    const href = attrs.get("href");
    const idref = attrs.get("idref");
    if (name === "item" && id && href) {
      doc.manifest.set(id, { href, mediaType: attrs.get("media-type") ?? "" });
    } else if (name === "itemref" && idref) {
      doc.spine.push(idref);
    }
  }
  return doc;
}

/** Archive paths of the spine items (reading order) that are XHTML or SVG documents. */
function chapterPaths(opfXml: string, opfPath: string): string[] {
  const { manifest, spine } = parsePackage(opfXml);
  const baseDir = posix.dirname(opfPath);
  const paths: string[] = [];
  for (const idref of spine) {
    const item = manifest.get(idref);
    if (item && CHAPTER_MEDIA_TYPES.has(item.mediaType)) {
      paths.push(resolveHref(baseDir, item.href));
    }
  }
  return paths;
}

/** Resolve a manifest href (relative to the OPF, URL-encoded) to an archive path. */
function resolveHref(baseDir: string, href: string): string {
  const hashIndex = href.indexOf("#");
  const withoutFragment = hashIndex === -1 ? href : href.slice(0, hashIndex);
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Keep a malformed escape sequence as written
  }
  let path = posix.normalize(posix.join(baseDir, decoded));
  while (path.startsWith("../")) path = path.slice(3);
  return path;
}

interface ChapterTextState {
  bodyText: string[];
  allText: string[];
  skipDepth: number;
  inBody: boolean;
  sawBody: boolean;
}

function addChapterText(state: ChapterTextState, text: string): void {
  if (state.skipDepth > 0) return;
  state.allText.push(text);
  if (state.inBody) state.bodyText.push(text);
}

function enterChapterTag(state: ChapterTextState, tag: Exclude<XmlToken, { kind: "text" }>): void {
  // Tags separate words, as in the original tag-stripping parser.
  addChapterText(state, " ");
  if (tag.kind === "self-closing") return;
  if (tag.name === "body") {
    state.inBody = tag.kind === "open";
    state.sawBody = true;
  } else if (SKIPPED_ELEMENTS.has(tag.name)) {
    state.skipDepth = Math.max(0, state.skipDepth + (tag.kind === "open" ? 1 : -1));
  }
}

/**
 * Plain text of an XHTML chapter: the body text (all text outside the head if there is no
 * body) without scripts and styles, entities decoded and whitespace collapsed.
 */
function chapterText(xhtml: string): string {
  const state: ChapterTextState = {
    bodyText: [],
    allText: [],
    skipDepth: 0,
    inBody: false,
    sawBody: false,
  };
  for (const token of scanXml(xhtml)) {
    if (token.kind === "text") addChapterText(state, token.text);
    else enterChapterTag(state, token);
  }
  const text = (state.sawBody ? state.bodyText : state.allText).join("");
  return decodeHtmlEntities(text).replaceAll(/\s+/g, " ").trim();
}

type XmlToken =
  | { kind: "text"; text: string }
  | { kind: "open" | "close" | "self-closing"; name: string; attrs: Map<string, string> };

/**
 * Linear scan of XML/XHTML into text and tag tokens. Element and attribute names are
 * lowercased and lose their namespace prefix. Comments, CDATA markers, processing
 * instructions and doctypes produce no tokens (CDATA content is kept as text).
 */
function* scanXml(xml: string): Generator<XmlToken> {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > pos) yield { kind: "text", text: xml.slice(pos, textEnd) };
    if (lt === -1) return;
    const markup = readMarkup(xml, lt);
    if (markup.token) yield markup.token;
    pos = markup.next;
  }
}

/** Read the markup (tag, comment, CDATA, declaration) starting with the "<" at `lt`. */
function readMarkup(xml: string, lt: number): { token?: XmlToken | undefined; next: number } {
  if (xml.startsWith("<!--", lt)) return { next: skipPast(xml, "-->", lt + 4) };
  if (xml.startsWith("<![CDATA[", lt)) {
    const end = xml.indexOf("]]>", lt + 9);
    const textEnd = end === -1 ? xml.length : end;
    return { token: { kind: "text", text: xml.slice(lt + 9, textEnd) }, next: textEnd + 3 };
  }
  const end = findTagEnd(xml, lt + 1);
  if (end === -1) return { next: xml.length }; // Unterminated tag: ignore the rest
  const declaration = xml[lt + 1] === "?" || xml[lt + 1] === "!";
  return { token: declaration ? undefined : parseTag(xml, lt + 1, end), next: end + 1 };
}

function skipPast(xml: string, marker: string, from: number): number {
  const end = xml.indexOf(marker, from);
  return end === -1 ? xml.length : end + marker.length;
}

/** Index of the ">" that ends the tag starting at `from`, ignoring ">" inside quoted values. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";

/** Read a name (element or attribute) starting at `from`; stops at whitespace, "/", "=" or `end`. */
function readName(xml: string, from: number, end: number): number {
  let i = from;
  while (i < end && !isSpace(xml[i]) && xml[i] !== "/" && xml[i] !== "=") i++;
  return i;
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

/** Parse the tag between `start` (just after "<") and `end` (the closing ">"). */
function parseTag(xml: string, start: number, end: number): XmlToken | undefined {
  const closing = xml[start] === "/";
  const nameStart = closing ? start + 1 : start;
  const nameEnd = readName(xml, nameStart, end);
  if (nameEnd === nameStart) return undefined;
  const name = localName(xml.slice(nameStart, nameEnd));
  if (closing) return { kind: "close", name, attrs: new Map() };
  const selfClosing = xml[end - 1] === "/";
  const attrs = parseAttributes(xml, nameEnd, selfClosing ? end - 1 : end);
  return { kind: selfClosing ? "self-closing" : "open", name, attrs };
}

function skipSpaces(xml: string, from: number, end: number): number {
  let i = from;
  while (i < end && isSpace(xml[i])) i++;
  return i;
}

/** Parse `name="value"` pairs between `from` and `end`. Values are entity-decoded. */
function parseAttributes(xml: string, from: number, end: number): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = from;
  while (i < end) {
    const nameEnd = readName(xml, i, end);
    if (nameEnd === i) {
      i++; // whitespace, "/" or a stray "="
      continue;
    }
    const name = localName(xml.slice(i, nameEnd));
    const afterName = skipSpaces(xml, nameEnd, end);
    if (xml[afterName] === "=") {
      const value = readAttributeValue(xml, skipSpaces(xml, afterName + 1, end), end);
      attrs.set(name, decodeHtmlEntities(value.text));
      i = value.next;
    } else {
      attrs.set(name, "");
      i = afterName;
    }
  }
  return attrs;
}

/** The attribute value starting at `from` (quoted or not) and the index after it. */
function readAttributeValue(
  xml: string,
  from: number,
  end: number,
): { text: string; next: number } {
  const quote = xml[from];
  if (quote === '"' || quote === "'") {
    const close = xml.indexOf(quote, from + 1);
    const valueEnd = close === -1 || close > end ? end : close;
    return { text: xml.slice(from + 1, valueEnd), next: valueEnd + 1 };
  }
  let i = from;
  while (i < end && !isSpace(xml[i])) i++;
  return { text: xml.slice(from, i), next: i };
}
