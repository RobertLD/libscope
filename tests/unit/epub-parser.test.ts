import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import { EpubParser } from "../../src/core/parsers/epub.js";
import { getParserForFile } from "../../src/core/parsers/index.js";
import { ValidationError } from "../../src/errors.js";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

/** Manifest lists chapter 2 first; the spine puts chapter 1 first. */
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:identifier id="uid">urn:uuid:1234</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch2" href="text/chapter%202.xhtml#start" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="css"/>
    <itemref idref="missing"/>
  </spine>
</package>`;

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><style>p { color: red; }</style></head>
<body>
${body}
</body>
</html>`;
}

const BOOK: Record<string, string> = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": OPF,
  "OEBPS/nav.xhtml": xhtml(
    "Contents",
    `<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">One</a></li></ol></nav>`,
  ),
  "OEBPS/text/ch1.xhtml": xhtml(
    "Chapter 1",
    `<h1>Chapter One</h1>
<p>It was a dark &amp; stormy night.</p>
<script>var html = "<p>not text</p>";</script>
<!-- a comment -->
<p>Second   paragraph<br/>continues.</p>`,
  ),
  "OEBPS/text/chapter 2.xhtml": xhtml(
    "Chapter 2",
    `<h1 class="title">Chapter Two</h1><p title="a > b">An em dash &#8212; here.</p>`,
  ),
  "OEBPS/style.css": "p { margin: 0 }",
};

function buildEpub(
  files: Record<string, string>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Buffer {
  const zip = new PizZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { compression });
  }
  return zip.generate({ type: "nodebuffer", compression });
}

/** Overwrite the uncompressed size recorded for `name` in the local and central zip headers. */
function setDeclaredSize(zipBuffer: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zipBuffer);
  const nameBytes = Buffer.from(name, "utf-8");
  const headers = [
    { signature: 0x04034b50, sizeOffset: 22, nameOffset: 30 },
    { signature: 0x02014b50, sizeOffset: 24, nameOffset: 46 },
  ];
  let patched = 0;
  for (let i = 0; i + 4 <= out.length; i++) {
    const header = headers.find((h) => out.readUInt32LE(i) === h.signature);
    if (!header) continue;
    const start = i + header.nameOffset;
    if (out.subarray(start, start + nameBytes.length).equals(nameBytes)) {
      out.writeUInt32LE(size, i + header.sizeOffset);
      patched++;
    }
  }
  expect(patched).toBe(2);
  return out;
}

/** Overwrite the first bytes of the compressed data of `name` (deflate block type 3 is invalid). */
function corruptData(zipBuffer: Buffer, name: string): Buffer {
  const out = Buffer.from(zipBuffer);
  const nameBytes = Buffer.from(name, "utf-8");
  for (let i = 0; i + 30 <= out.length; i++) {
    if (out.readUInt32LE(i) !== 0x04034b50) continue;
    if (!out.subarray(i + 30, i + 30 + nameBytes.length).equals(nameBytes)) continue;
    const dataStart = i + 30 + out.readUInt16LE(i + 26) + out.readUInt16LE(i + 28);
    out.fill(0xff, dataStart, dataStart + 4);
    return out;
  }
  throw new Error(`no local header for ${name}`);
}

describe("EpubParser", () => {
  const parser = new EpubParser();

  it("is the parser for .epub files", () => {
    expect(getParserForFile("book.epub")).toBeInstanceOf(EpubParser);
  });

  it("returns chapter text in spine order, one paragraph per chapter", async () => {
    const text = await parser.parse(buildEpub(BOOK));
    expect(text).toBe(
      "Chapter One It was a dark & stormy night. Second paragraph continues." +
        "\n\nChapter Two An em dash — here.",
    );
  });

  it("includes every XHTML spine item and skips non-XHTML and missing items", async () => {
    const opf = OPF.replace('<itemref idref="ch1"/>', '<itemref idref="nav" linear="no"/>');
    const text = await parser.parse(buildEpub({ ...BOOK, "OEBPS/content.opf": opf }));
    expect(text.split("\n\n")).toEqual(["One", "Chapter Two An em dash — here."]);
  });

  it("leaves out the head, scripts, styles and comments", async () => {
    const text = await parser.parse(buildEpub(BOOK));
    expect(text).not.toContain("Chapter 1");
    expect(text).not.toContain("not text");
    expect(text).not.toContain("color");
    expect(text).not.toContain("comment");
  });

  it("reads stored (uncompressed) entries", async () => {
    const text = await parser.parse(buildEpub(BOOK, "STORE"));
    expect(text).toContain("Chapter One");
  });

  it("reads a package document at the archive root and prefixed element names", async () => {
    const container = CONTAINER.replace("OEBPS/content.opf", "package.opf");
    const opf = `<?xml version="1.0"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
  <opf:manifest><opf:item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></opf:manifest>
  <opf:spine toc="ncx"><opf:itemref idref="a"/></opf:spine>
</opf:package>`;
    const text = await parser.parse(
      buildEpub({
        "META-INF/container.xml": container,
        "package.opf": opf,
        "a.xhtml": xhtml("A", "<p>Root <![CDATA[cdata & text]]> chapter</p>"),
      }),
    );
    expect(text).toBe("Root cdata & text chapter");
  });

  it("uses all text outside the head when a chapter has no body element", async () => {
    const files = {
      ...BOOK,
      "OEBPS/text/ch1.xhtml":
        "<svg xmlns='http://www.w3.org/2000/svg'><text>Drawn text</text></svg>",
    };
    const text = await parser.parse(buildEpub(files));
    expect(text.split("\n\n")[0]).toBe("Drawn text");
  });

  describe("invalid files", () => {
    async function expectInvalid(content: Buffer, message: RegExp): Promise<void> {
      const err: unknown = await parser.parse(content).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(message);
    }

    it("rejects data that is not a zip archive", async () => {
      await expectInvalid(Buffer.from("this is not an epub"), /Invalid EPUB file/);
    });

    it("rejects an archive without META-INF/container.xml", async () => {
      const files = { ...BOOK };
      delete files["META-INF/container.xml"];
      await expectInvalid(buildEpub(files), /container\.xml is missing/);
    });

    it("rejects a container.xml that names no package document", async () => {
      const files = { ...BOOK, "META-INF/container.xml": "<container><rootfiles/></container>" };
      await expectInvalid(buildEpub(files), /names no package document/);
    });

    it("rejects a missing package document", async () => {
      const files = { ...BOOK };
      delete files["OEBPS/content.opf"];
      await expectInvalid(buildEpub(files), /package document "OEBPS\/content\.opf" is missing/);
    });

    it("rejects an EPUB without readable chapters", async () => {
      const opf = `${OPF.slice(0, OPF.indexOf("<spine>"))}<spine></spine></package>`;
      const files = { ...BOOK, "OEBPS/content.opf": opf };
      await expectInvalid(buildEpub(files), /no readable chapters/);
    });

    it("rejects an entry whose compressed data is corrupt", async () => {
      const epub = corruptData(buildEpub(BOOK), "OEBPS/text/ch1.xhtml");
      await expectInvalid(epub, /cannot decompress "OEBPS\/text\/ch1\.xhtml"/);
    });

    it("rejects an entry whose declared size exceeds the limit", async () => {
      const small = new EpubParser({ maxUncompressedBytes: 2000 });
      const files = { ...BOOK, "OEBPS/text/ch1.xhtml": xhtml("Big", "<p>a</p>".repeat(1000)) };
      const err: unknown = await small.parse(buildEpub(files)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/too large/);
    });

    it("stops inflating an entry whose zip header understates its size", async () => {
      const small = new EpubParser({ maxUncompressedBytes: 4096 });
      const name = "OEBPS/text/ch1.xhtml";
      const epub = setDeclaredSize(
        buildEpub({ ...BOOK, [name]: xhtml("Bomb", "<p>0</p>".repeat(100_000)) }),
        name,
        100,
      );
      const err: unknown = await small.parse(epub).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/too large/);
    });

    it("counts the limit across all entries read", async () => {
      const opf = OPF.replace("<spine>", `<spine>${'<itemref idref="ch1"/>'.repeat(200)}`);
      const small = new EpubParser({ maxUncompressedBytes: 20_000 });
      const err: unknown = await small
        .parse(buildEpub({ ...BOOK, "OEBPS/content.opf": opf }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/too large/);
    });
  });
});
