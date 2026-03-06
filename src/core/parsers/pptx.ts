import type { DocumentParser } from "./index.js";
import { ValidationError } from "../../errors.js";

/** Parses PPTX files using pizzip. */
export class PptxParser implements DocumentParser {
  readonly extensions = [".pptx", ".ppt"];

  async parse(content: Buffer): Promise<string> {
    let PizZip: typeof import("pizzip").default;
    try {
      const mod = await import("pizzip");
      PizZip = mod.default;
    } catch (err) {
      throw new ValidationError(
        'PPTX parsing requires the "pizzip" package. Install it with: npm install pizzip',
        err,
      );
    }

    let zip: InstanceType<typeof PizZip>;
    try {
      zip = new PizZip(content);
    } catch {
      return ""; // binary .ppt format not supported
    }

    const slides: string[] = [];
    let slideNum = 1;

    // PPTX slides are at ppt/slides/slide1.xml, slide2.xml, etc.
    while (true) {
      const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`);
      if (!slideFile) break;

      const xml = slideFile.asText();
      // Extract text from <a:t> elements
      const texts: string[] = [];
      const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(xml)) !== null) {
        const text = match[1]?.trim();
        if (text) texts.push(text);
      }

      if (texts.length > 0) {
        slides.push(`--- Slide ${slideNum} ---\n${texts.join(" ")}`);
      }

      slideNum++;
    }

    if (slides.length === 0) {
      throw new ValidationError("PPTX file contains no readable slides");
    }

    return slides.join("\n\n");
  }
}
